import type { IncomingMessage } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { hasWorkspaceMembership } from "./tenant-domain-guard.js";
import { activeOAuthToken, mcpResource, protectedResourceMetadataUrl } from "./oauth.js";
import { listWorkspaceSummaries } from "./users.js";
import { isCalendarDate, minorDigits } from "./validation.js";

const MCP_SCOPE = "history:read";
const APP_TIME_ZONE = "Europe/Belgrade";

type HistoryRow = {
  id: string;
  amount_minor: number;
  currency: string;
  category_id: string;
  category_name: string;
  occurred_at: string;
  note: string | null;
  tag_pairs: string | null;
};

// Теги приходят одной строкой: пары «id\x1Fимя», разделённые \x1E, чтобы не делать второй запрос на каждую строку.
function tagFields(pairs: string | null): { tagIds: string[]; tags: string[] } {
  if (!pairs) return { tagIds: [], tags: [] };
  const parsed = pairs.split(String.fromCharCode(30)).map((pair) => pair.split(String.fromCharCode(31)) as [string, string])
    .sort((left, right) => left[1].localeCompare(right[1], "ru"));
  return { tagIds: parsed.map((pair) => pair[0]), tags: parsed.map((pair) => pair[1]) };
}

type HistoryCursor = { occurredAt: string; id: string };

function localDateKey(value: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function decimalAmount(amountMinor: number, currency: string): string {
  const decimals = minorDigits(currency);
  const digits = String(amountMinor).padStart(decimals + 1, "0");
  return decimals === 0 ? digits : `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

function encodeCursor(row: HistoryRow): string {
  return Buffer.from(JSON.stringify({ occurredAt: row.occurred_at, id: row.id } satisfies HistoryCursor)).toString("base64url");
}

function decodeCursor(value: string | undefined): HistoryCursor | undefined {
  if (value === undefined) return undefined;
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("cursor is invalid");
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<HistoryCursor>;
    if (typeof parsed.occurredAt !== "string" || Number.isNaN(Date.parse(parsed.occurredAt)) || typeof parsed.id !== "string" || !parsed.id) {
      throw new Error("cursor is invalid");
    }
    return { occurredAt: new Date(parsed.occurredAt).toISOString(), id: parsed.id };
  } catch {
    throw new Error("cursor is invalid");
  }
}

function historyToolError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

function createMcpServer(app: FastifyInstance, userId: string): McpServer {
  const server = new McpServer({ name: "moapp-expense-history", version: "1.0.0" }, {
    instructions: "This server provides read-only access to the user's Moapp expense history. Call list_workspaces before get_expense_history when the workspace ID is unknown. Dates use the Europe/Belgrade calendar. Never imply that these tools can modify expenses."
  });
  const authMeta = { securitySchemes: [{ type: "oauth2", scopes: [MCP_SCOPE] }] };

  server.registerTool("list_workspaces", {
    title: "List Moapp workspaces",
    description: "List the Moapp workspaces whose expense history the connected user can currently read. Use this first when a workspace ID is not already known.",
    inputSchema: {},
    outputSchema: {
      workspaces: z.array(z.object({ id: z.string(), name: z.string(), role: z.enum(["owner", "member"]) }))
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: authMeta
  }, async () => {
    const workspaces = listWorkspaceSummaries(app.db, userId).map(({ id, name, role }) => ({ id, name, role }));
    return {
      structuredContent: { workspaces },
      content: [{ type: "text", text: workspaces.length
        ? `Found ${workspaces.length} Moapp workspace${workspaces.length === 1 ? "" : "s"}.`
        : "No Moapp workspaces are currently available to this profile." }]
    };
  });

  server.registerTool("get_expense_history", {
    title: "Read Moapp expense history",
    description: "Read one page of expenses from a Moapp workspace. Results are newest first. Use from/to for Europe/Belgrade calendar dates and nextCursor to continue when more results exist.",
    inputSchema: {
      workspaceId: z.string().uuid().describe("Workspace ID returned by list_workspaces"),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Inclusive Europe/Belgrade calendar date, YYYY-MM-DD"),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Inclusive Europe/Belgrade calendar date, YYYY-MM-DD"),
      categoryId: z.string().min(1).max(100).optional().describe("Optional category ID"),
      tagId: z.string().min(1).max(100).optional().describe("Optional tag ID; returns only expenses carrying this tag"),
      currency: z.string().regex(/^[A-Z]{3}$/).optional().describe("Optional ISO 4217 currency code"),
      limit: z.number().int().min(1).max(200).default(100).describe("Maximum expenses to return"),
      cursor: z.string().max(512).optional().describe("Opaque nextCursor from the previous result")
    },
    outputSchema: {
      workspace: z.object({ id: z.string(), name: z.string() }),
      from: z.string().nullable(),
      to: z.string().nullable(),
      expenses: z.array(z.object({
        id: z.string(),
        occurredAt: z.string(),
        date: z.string(),
        amountMinor: z.number().int(),
        amount: z.string(),
        currency: z.string(),
        categoryId: z.string(),
        category: z.string(),
        tagIds: z.array(z.string()),
        tags: z.array(z.string()),
        note: z.string().nullable()
      })),
      nextCursor: z.string().nullable()
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: authMeta
  }, async ({ workspaceId, from, to, categoryId, tagId, currency, limit, cursor }) => {
    if ((from && !isCalendarDate(from)) || (to && !isCalendarDate(to)) || (from && to && from > to)) {
      return historyToolError("from and to must be valid YYYY-MM-DD dates with from no later than to.");
    }
    if (!hasWorkspaceMembership(app, workspaceId, userId)) return historyToolError("Workspace not found.");
    const workspace = app.db.prepare("SELECT id,name FROM workspaces WHERE id=?").get(workspaceId) as { id: string; name: string } | undefined;
    if (!workspace) return historyToolError("Workspace not found.");
    let decodedCursor: HistoryCursor | undefined;
    try {
      decodedCursor = decodeCursor(cursor);
    } catch (error) {
      return historyToolError(error instanceof Error ? error.message : "cursor is invalid");
    }
    const where = ["e.workspace_id=?", "e.deleted_at IS NULL"];
    const values: unknown[] = [workspaceId];
    if (categoryId) { where.push("e.category_id=?"); values.push(categoryId); }
    if (tagId) { where.push("EXISTS (SELECT 1 FROM expense_tags f WHERE f.workspace_id=e.workspace_id AND f.expense_id=e.id AND f.tag_id=?)"); values.push(tagId); }
    if (currency) { where.push("e.currency=?"); values.push(currency); }
    if (decodedCursor) {
      where.push("(e.occurred_at < ? OR (e.occurred_at = ? AND e.id < ?))");
      values.push(decodedCursor.occurredAt, decodedCursor.occurredAt, decodedCursor.id);
    }
    const candidates = app.db.prepare(`SELECT e.id,e.amount_minor,e.currency,e.category_id,c.name AS category_name,e.occurred_at,e.note,
        (SELECT group_concat(et.tag_id || char(31) || t.name, char(30)) FROM expense_tags et
          JOIN tags t ON t.workspace_id=et.workspace_id AND t.id=et.tag_id
          WHERE et.workspace_id=e.workspace_id AND et.expense_id=e.id) AS tag_pairs
      FROM expenses e JOIN categories c ON c.workspace_id=e.workspace_id AND c.id=e.category_id
      WHERE ${where.join(" AND ")} ORDER BY e.occurred_at DESC,e.id DESC`).iterate(...values) as IterableIterator<HistoryRow>;
    const page: HistoryRow[] = [];
    for (const row of candidates) {
      const date = localDateKey(row.occurred_at);
      if ((!from || date >= from) && (!to || date <= to)) page.push(row);
      if (page.length > limit) break;
    }
    const hasMore = page.length > limit;
    const selected = page.slice(0, limit);
    const expenses = selected.map((row) => ({
      id: row.id,
      occurredAt: row.occurred_at,
      date: localDateKey(row.occurred_at),
      amountMinor: row.amount_minor,
      amount: decimalAmount(row.amount_minor, row.currency),
      currency: row.currency,
      categoryId: row.category_id,
      category: row.category_name,
      ...tagFields(row.tag_pairs),
      note: row.note
    }));
    const nextCursor = hasMore && selected.length ? encodeCursor(selected.at(-1)!) : null;
    const structuredContent = { workspace, from: from ?? null, to: to ?? null, expenses, nextCursor };
    return {
      structuredContent,
      content: [{ type: "text", text: `Returned ${expenses.length} expense${expenses.length === 1 ? "" : "s"} from ${workspace.name}${nextCursor ? "; more results are available" : ""}.` }]
    };
  });

  return server;
}

function challenge(app: FastifyInstance, reply: FastifyReply, invalid: boolean): FastifyReply {
  const fields = [`resource_metadata="${protectedResourceMetadataUrl(app)}"`, `scope="${MCP_SCOPE}"`];
  if (invalid) fields.push('error="invalid_token"');
  return reply
    .header("WWW-Authenticate", `Bearer ${fields.join(", ")}`)
    .header("Cache-Control", "no-store")
    .code(401)
    .send({ error: invalid ? "invalid_token" : "unauthorized" });
}

function authenticateMcp(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply): { authInfo: AuthInfo; userId: string } | undefined {
  const authorization = request.headers.authorization;
  if (!authorization) { void challenge(app, reply, false); return undefined; }
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
  if (!match) { void challenge(app, reply, true); return undefined; }
  const token = match[1]!;
  const row = activeOAuthToken(app.db, token, mcpResource(app));
  const scopes = row?.scope.split(/\s+/).filter(Boolean) ?? [];
  if (!row || !scopes.includes(MCP_SCOPE)) { void challenge(app, reply, true); return undefined; }
  return {
    userId: row.user_id,
    authInfo: {
      token,
      clientId: row.client_id,
      scopes,
      expiresAt: Math.floor(Date.parse(row.access_expires_at) / 1000),
      resource: new URL(row.resource),
      extra: { userId: row.user_id }
    }
  };
}

function methodNotAllowed(reply: FastifyReply): FastifyReply {
  return reply.header("Allow", "POST").header("Cache-Control", "no-store").code(405).send({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed for this stateless MCP server." },
    id: null
  });
}

export async function registerMcpRoutes(app: FastifyInstance): Promise<void> {
  app.get("/mcp", async (request, reply) => authenticateMcp(app, request, reply) ? methodNotAllowed(reply) : reply);
  app.delete("/mcp", async (request, reply) => authenticateMcp(app, request, reply) ? methodNotAllowed(reply) : reply);
  app.post("/mcp", async (request, reply) => {
    const authenticated = authenticateMcp(app, request, reply);
    if (!authenticated) return;
    const server = createMcpServer(app, authenticated.userId);
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    const rawRequest = request.raw as IncomingMessage & { auth?: AuthInfo };
    rawRequest.auth = authenticated.authInfo;
    reply.header("Cache-Control", "no-store");
    reply.hijack();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      void transport.close();
      void server.close();
    };
    reply.raw.once("close", close);
    try {
      await server.connect(transport as unknown as Parameters<McpServer["connect"]>[0]);
      await transport.handleRequest(rawRequest, reply.raw, request.body);
    } catch (error) {
      request.log.error({ err: error }, "MCP request failed");
      if (!reply.raw.headersSent) {
        reply.raw.statusCode = 500;
        reply.raw.setHeader("Content-Type", "application/json");
        reply.raw.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
      } else if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
      close();
    }
  });
}
