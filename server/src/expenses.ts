import type { FastifyInstance, FastifyReply } from "fastify";
import { hasWorkspaceMembership, noStore, rejectsWorkspaceId, requireMutationOrigin, sendWorkspaceNotFound, workspaceContext } from "./tenant-domain-guard.js";
import { isCurrency, isTimestamp, isUuid, jsonError } from "./validation.js";

export type ExpenseRow = {
  workspace_id: string;
  id: string;
  amount_minor: number;
  currency: string;
  category_id: string;
  occurred_at: string;
  note: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type ExpenseInput = {
  id: string;
  amountMinor: number;
  currency: string;
  categoryId: string;
  occurredAt: string;
  note?: string | null;
  version?: number;
};

type ExpenseJson = ReturnType<typeof expenseJson>;
type ExpenseChange = { expense?: ExpenseJson; error?: string; code?: string; current?: ExpenseJson };

export function expenseJson(row: ExpenseRow) {
  return {
    id: row.id,
    amountMinor: row.amount_minor,
    currency: row.currency,
    categoryId: row.category_id,
    occurredAt: row.occurred_at,
    note: row.note,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at
  };
}

function validate(input: ExpenseInput): string | undefined {
  if (!isUuid(input.id)) return "id must be a UUID";
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) return "amountMinor must be a positive safe integer";
  if (!isCurrency(input.currency)) return "currency must be an ISO 4217 code";
  if (typeof input.categoryId !== "string" || !input.categoryId) return "categoryId is required";
  if (!isTimestamp(input.occurredAt)) return "occurredAt must be an ISO timestamp";
  if (input.note !== undefined && input.note !== null && (typeof input.note !== "string" || input.note.length > 500)) return "note must be at most 500 characters";
  return undefined;
}

function normalizedNote(note: string | null | undefined): string | null {
  return note?.trim() || null;
}

export function createExpense(
  app: FastifyInstance,
  workspaceId: string,
  input: ExpenseInput
): { status: "created" | "existing"; expense: ExpenseJson } | { error: string; code?: string; current?: ExpenseJson } {
  const error = validate(input);
  if (error) return { error };
  const existing = app.db.prepare("SELECT * FROM expenses WHERE workspace_id=? AND id=?")
    .get(workspaceId, input.id) as ExpenseRow | undefined;
  if (existing) {
    const compatible = existing.amount_minor === input.amountMinor
      && existing.currency === input.currency
      && existing.category_id === input.categoryId
      && existing.occurred_at === new Date(input.occurredAt).toISOString()
      && existing.note === normalizedNote(input.note);
    return compatible
      ? { status: "existing", expense: expenseJson(existing) }
      : { error: "Expense id already exists with different fields", code: "IDEMPOTENCY_CONFLICT", current: expenseJson(existing) };
  }
  const category = app.db.prepare(`SELECT 1 FROM categories
    WHERE workspace_id=? AND id=? AND archived_at IS NULL`).get(workspaceId, input.categoryId);
  if (!category) return { error: "Category not found or archived", code: "CATEGORY_INVALID" };
  const now = new Date().toISOString();
  app.db.prepare(`INSERT INTO expenses
    (workspace_id,id,amount_minor,currency,category_id,occurred_at,note,version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,1,?,?)`)
    .run(workspaceId, input.id, input.amountMinor, input.currency, input.categoryId,
      new Date(input.occurredAt).toISOString(), normalizedNote(input.note), now, now);
  const row = app.db.prepare("SELECT * FROM expenses WHERE workspace_id=? AND id=?")
    .get(workspaceId, input.id) as ExpenseRow;
  return { status: "created", expense: expenseJson(row) };
}

export function updateExpense(
  app: FastifyInstance,
  workspaceId: string,
  id: string,
  input: Partial<ExpenseInput> & { version: number }
): ExpenseChange {
  const current = app.db.prepare("SELECT * FROM expenses WHERE workspace_id=? AND id=?")
    .get(workspaceId, id) as ExpenseRow | undefined;
  if (!current) return { error: "Expense not found", code: "NOT_FOUND" };
  if (current.version !== input.version) return { error: "Expense was changed", code: "VERSION_CONFLICT", current: expenseJson(current) };
  const merged: ExpenseInput = {
    id,
    amountMinor: input.amountMinor ?? current.amount_minor,
    currency: input.currency ?? current.currency,
    categoryId: input.categoryId ?? current.category_id,
    occurredAt: input.occurredAt ?? current.occurred_at,
    note: input.note === undefined ? current.note : input.note
  };
  const error = validate(merged);
  if (error) return { error, code: "VALIDATION" };
  if (!app.db.prepare(`SELECT 1 FROM categories
    WHERE workspace_id=? AND id=? AND archived_at IS NULL`).get(workspaceId, merged.categoryId)) {
    return { error: "Category not found or archived", code: "CATEGORY_INVALID" };
  }
  app.db.prepare(`UPDATE expenses SET amount_minor=?,currency=?,category_id=?,occurred_at=?,note=?,deleted_at=NULL,
    version=version+1,updated_at=? WHERE workspace_id=? AND id=? AND version=?`)
    .run(merged.amountMinor, merged.currency, merged.categoryId, new Date(merged.occurredAt).toISOString(),
      normalizedNote(merged.note), new Date().toISOString(), workspaceId, id, input.version);
  const row = app.db.prepare("SELECT * FROM expenses WHERE workspace_id=? AND id=?")
    .get(workspaceId, id) as ExpenseRow;
  return { expense: expenseJson(row) };
}

export function deleteExpense(app: FastifyInstance, workspaceId: string, id: string, version: number): ExpenseChange {
  const current = app.db.prepare("SELECT * FROM expenses WHERE workspace_id=? AND id=?")
    .get(workspaceId, id) as ExpenseRow | undefined;
  if (!current) return { error: "Expense not found", code: "NOT_FOUND" };
  if (current.version !== version) return { error: "Expense was changed", code: "VERSION_CONFLICT", current: expenseJson(current) };
  const now = new Date().toISOString();
  app.db.prepare(`UPDATE expenses SET deleted_at=?,updated_at=?,version=version+1
    WHERE workspace_id=? AND id=? AND version=?`).run(now, now, workspaceId, id, version);
  const row = app.db.prepare("SELECT * FROM expenses WHERE workspace_id=? AND id=?")
    .get(workspaceId, id) as ExpenseRow;
  return { expense: expenseJson(row) };
}

function sendResult(reply: FastifyReply, result: ExpenseChange) {
  if (!result.error) return reply.send(result.expense);
  const status = result.code === "NOT_FOUND" ? 404 : result.code === "VERSION_CONFLICT" || result.code === "IDEMPOTENCY_CONFLICT" ? 409 : 400;
  return reply.code(status).send(jsonError(result.code ?? "VALIDATION", result.error,
    result.current ? { current: result.current } : undefined));
}

export async function registerExpenseRoutes(app: FastifyInstance): Promise<void> {
  const prefix = "/api/workspaces/:workspaceId/expenses";
  const requireMutation = (request: import("fastify").FastifyRequest, reply: FastifyReply) => requireMutationOrigin(app, request, reply);

  app.get(prefix, { preHandler: app.requireWorkspaceMember, onSend: noStore }, async (request, reply) => {
    const { workspaceId } = workspaceContext(request);
    const q = request.query as { from?: string; to?: string; categoryId?: string; currency?: string; cursor?: string; limit?: string; includeDeleted?: string };
    const limit = Number(q.limit ?? 50);
    if (!Number.isInteger(limit) || limit < 1) return reply.code(400).send(jsonError("VALIDATION", "limit must be a positive integer"));
    const boundedLimit = Math.min(limit, 200);
    if ((q.from && Number.isNaN(Date.parse(q.from))) || (q.to && Number.isNaN(Date.parse(q.to)))) {
      return reply.code(400).send(jsonError("VALIDATION", "from and to must be ISO timestamps"));
    }
    const where: string[] = ["workspace_id=?", q.includeDeleted === "true" ? "1=1" : "deleted_at IS NULL"];
    const values: unknown[] = [workspaceId];
    if (q.from) { where.push("occurred_at >= ?"); values.push(new Date(q.from).toISOString()); }
    if (q.to) { where.push("occurred_at <= ?"); values.push(new Date(q.to).toISOString()); }
    if (q.categoryId) { where.push("category_id = ?"); values.push(q.categoryId); }
    if (q.currency) { where.push("currency = ?"); values.push(q.currency.toUpperCase()); }
    if (q.cursor) {
      const separator = q.cursor.lastIndexOf("|");
      const occurred = q.cursor.slice(0, separator);
      const id = q.cursor.slice(separator + 1);
      if (separator < 1 || !isTimestamp(occurred) || !id) return reply.code(400).send(jsonError("VALIDATION", "cursor is invalid"));
      where.push("(occurred_at < ? OR (occurred_at = ? AND id < ?))");
      values.push(occurred, occurred, id);
    }
    const rows = app.db.prepare(`SELECT * FROM expenses WHERE ${where.join(" AND ")}
      ORDER BY occurred_at DESC,id DESC LIMIT ?`).all(...values, boundedLimit + 1) as ExpenseRow[];
    const hasMore = rows.length > boundedLimit;
    const items = rows.slice(0, boundedLimit);
    const last = items.at(-1);
    return { expenses: items.map(expenseJson), nextCursor: hasMore && last ? `${last.occurred_at}|${last.id}` : null };
  });

  app.get(`${prefix}/:id`, { preHandler: app.requireWorkspaceMember, onSend: noStore }, async (request, reply) => {
    const { workspaceId } = workspaceContext(request);
    const row = app.db.prepare("SELECT * FROM expenses WHERE workspace_id=? AND id=?")
      .get(workspaceId, (request.params as { id: string }).id) as ExpenseRow | undefined;
    return row ? expenseJson(row) : reply.code(404).send(jsonError("NOT_FOUND", "Expense not found"));
  });

  app.post(prefix, { preHandler: [app.requireWorkspaceMember, requireMutation], onSend: noStore }, async (request, reply) => {
    if (rejectsWorkspaceId(request.body)) return reply.code(400).send(jsonError("VALIDATION", "workspaceId is defined by the route"));
    const { workspaceId, userId } = workspaceContext(request);
    const body = request.body as ExpenseInput;
    if (typeof body.currency === "string") body.currency = body.currency.toUpperCase();
    const outcome = app.db.transaction(() => {
      if (!hasWorkspaceMembership(app, workspaceId, userId)) return { member: false as const };
      return { member: true as const, result: createExpense(app, workspaceId, body) };
    })();
    if (!outcome.member) return sendWorkspaceNotFound(reply);
    if ("error" in outcome.result) return sendResult(reply, outcome.result);
    return reply.code(outcome.result.status === "created" ? 201 : 200).send(outcome.result.expense);
  });

  app.patch(`${prefix}/:id`, { preHandler: [app.requireWorkspaceMember, requireMutation], onSend: noStore }, async (request, reply) => {
    if (rejectsWorkspaceId(request.body)) return reply.code(400).send(jsonError("VALIDATION", "workspaceId is defined by the route"));
    const { workspaceId, userId } = workspaceContext(request);
    const body = request.body as Partial<ExpenseInput> & { version: number };
    if (!Number.isInteger(body.version)) return reply.code(400).send(jsonError("VALIDATION", "version is required"));
    if (typeof body.currency === "string") body.currency = body.currency.toUpperCase();
    const outcome = app.db.transaction(() => {
      if (!hasWorkspaceMembership(app, workspaceId, userId)) return { member: false as const };
      return { member: true as const, result: updateExpense(app, workspaceId, (request.params as { id: string }).id, body) };
    })();
    return outcome.member ? sendResult(reply, outcome.result) : sendWorkspaceNotFound(reply);
  });

  app.delete(`${prefix}/:id`, { preHandler: [app.requireWorkspaceMember, requireMutation], onSend: noStore }, async (request, reply) => {
    if (rejectsWorkspaceId(request.body)) return reply.code(400).send(jsonError("VALIDATION", "workspaceId is defined by the route"));
    const { workspaceId, userId } = workspaceContext(request);
    const { version } = (request.body ?? {}) as { version?: number };
    if (!Number.isInteger(version)) return reply.code(400).send(jsonError("VALIDATION", "version is required"));
    const outcome = app.db.transaction(() => {
      if (!hasWorkspaceMembership(app, workspaceId, userId)) return { member: false as const };
      return { member: true as const, result: deleteExpense(app, workspaceId, (request.params as { id: string }).id, version!) };
    })();
    if (!outcome.member) return sendWorkspaceNotFound(reply);
    if (outcome.result.error) return sendResult(reply, outcome.result);
    return reply.code(204).send();
  });
}
