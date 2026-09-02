import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { hasWorkspaceMembership, noStore, rejectsWorkspaceId, requireMutationOrigin, sendWorkspaceNotFound, workspaceContext } from "./tenant-domain-guard.js";
import { isUuid, jsonError } from "./validation.js";

export type TagRow = {
  workspace_id: string;
  id: string;
  name: string;
  name_key: string;
  version: number;
  created_at: string;
  updated_at: string;
};

export const MAX_TAG_NAME_LENGTH = 30;
// SQLite NOCASE складывает только латиницу, поэтому ключ уникальности считаем в JS: «Еда» и «еда» — один тег.
export const tagNameKey = (name: string) => name.toLowerCase();
const FORBIDDEN_NAME_CHARACTERS = /[\p{Cc}\p{Cf}]/u;

// Тег — короткая плашка, поэтому имя ограничено 30 символами и схлопывает внутренние пробелы.
export function normalizeTagName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  const length = Array.from(normalized).length;
  return length >= 1 && length <= MAX_TAG_NAME_LENGTH && !FORBIDDEN_NAME_CHARACTERS.test(normalized) ? normalized : undefined;
}

export function tagJson(row: TagRow) {
  return { id: row.id, name: row.name, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
}

export const TAGS_ORDERED = "SELECT * FROM tags WHERE workspace_id=? ORDER BY name COLLATE NOCASE";

export async function registerTagRoutes(app: FastifyInstance): Promise<void> {
  const prefix = "/api/workspaces/:workspaceId/tags";
  const requireMutation = (request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => requireMutationOrigin(app, request, reply);
  const byId = (workspaceId: string, id: string) => app.db.prepare("SELECT * FROM tags WHERE workspace_id=? AND id=?").get(workspaceId, id) as TagRow | undefined;
  const byName = (workspaceId: string, name: string) => app.db.prepare("SELECT * FROM tags WHERE workspace_id=? AND name_key=?").get(workspaceId, tagNameKey(name)) as TagRow | undefined;

  app.get(prefix, { preHandler: app.requireWorkspaceMember, onSend: noStore }, async (request) => {
    const { workspaceId } = workspaceContext(request);
    const rows = app.db.prepare(TAGS_ORDERED).all(workspaceId) as TagRow[];
    return { tags: rows.map(tagJson) };
  });

  app.post(prefix, { preHandler: [app.requireWorkspaceMember, requireMutation], onSend: noStore }, async (request, reply) => {
    if (rejectsWorkspaceId(request.body)) return reply.code(400).send(jsonError("VALIDATION", "workspaceId is defined by the route"));
    const { workspaceId, userId } = workspaceContext(request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const id = body.id === undefined ? randomUUID() : body.id;
    if (!isUuid(id)) return reply.code(400).send(jsonError("VALIDATION", "id must be a UUID"));
    const name = normalizeTagName(body.name);
    if (!name) return reply.code(400).send(jsonError("VALIDATION", `name must contain 1-${MAX_TAG_NAME_LENGTH} characters`));
    const outcome = app.db.transaction(() => {
      if (!hasWorkspaceMembership(app, workspaceId, userId)) return { member: false as const };
      const existing = byId(workspaceId, id);
      if (existing) return { member: true as const, existing, compatible: existing.name === name };
      const sameName = byName(workspaceId, name);
      if (sameName) return { member: true as const, duplicate: sameName };
      const now = new Date().toISOString();
      app.db.prepare("INSERT INTO tags(workspace_id,id,name,name_key,version,created_at,updated_at) VALUES (?,?,?,?,1,?,?)").run(workspaceId, id, name, tagNameKey(name), now, now);
      return { member: true as const, created: byId(workspaceId, id)! };
    })();
    if (!outcome.member) return sendWorkspaceNotFound(reply);
    if ("duplicate" in outcome) return reply.code(409).send(jsonError("DUPLICATE", "Tag name already exists", { current: tagJson(outcome.duplicate) }));
    if ("existing" in outcome) {
      return outcome.compatible
        ? reply.code(200).send(tagJson(outcome.existing))
        : reply.code(409).send(jsonError("IDEMPOTENCY_CONFLICT", "Tag id already exists with a different name", { current: tagJson(outcome.existing) }));
    }
    return reply.code(201).send(tagJson(outcome.created));
  });

  app.patch(`${prefix}/:id`, { preHandler: [app.requireWorkspaceMember, requireMutation], onSend: noStore }, async (request, reply) => {
    if (rejectsWorkspaceId(request.body)) return reply.code(400).send(jsonError("VALIDATION", "workspaceId is defined by the route"));
    const { workspaceId, userId } = workspaceContext(request);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body.version !== "number" || !Number.isInteger(body.version)) return reply.code(400).send(jsonError("VALIDATION", "version is required"));
    const name = normalizeTagName(body.name);
    if (!name) return reply.code(400).send(jsonError("VALIDATION", `name must contain 1-${MAX_TAG_NAME_LENGTH} characters`));
    const outcome = app.db.transaction(() => {
      if (!hasWorkspaceMembership(app, workspaceId, userId)) return { member: false as const };
      const current = byId(workspaceId, id);
      if (!current) return { member: true as const, missing: true as const };
      if (current.version !== body.version) return { member: true as const, conflict: current };
      const sameName = byName(workspaceId, name);
      if (sameName && sameName.id !== id) return { member: true as const, duplicate: sameName };
      app.db.prepare("UPDATE tags SET name=?,name_key=?,version=version+1,updated_at=? WHERE workspace_id=? AND id=? AND version=?")
        .run(name, tagNameKey(name), new Date().toISOString(), workspaceId, id, body.version);
      return { member: true as const, row: byId(workspaceId, id)! };
    })();
    if (!outcome.member) return sendWorkspaceNotFound(reply);
    if ("missing" in outcome) return reply.code(404).send(jsonError("NOT_FOUND", "Tag not found"));
    if ("conflict" in outcome) return reply.code(409).send(jsonError("VERSION_CONFLICT", "Tag was changed", { current: tagJson(outcome.conflict) }));
    if ("duplicate" in outcome) return reply.code(409).send(jsonError("DUPLICATE", "Tag name already exists", { current: tagJson(outcome.duplicate) }));
    return tagJson(outcome.row);
  });

  // Удаление тега снимает его со всех расходов: сам расход остаётся, теряется только метка.
  app.delete(`${prefix}/:id`, { preHandler: [app.requireWorkspaceMember, requireMutation], onSend: noStore }, async (request, reply) => {
    if (rejectsWorkspaceId(request.body)) return reply.code(400).send(jsonError("VALIDATION", "workspaceId is defined by the route"));
    const { workspaceId, userId } = workspaceContext(request);
    const { id } = request.params as { id: string };
    const { version } = (request.body ?? {}) as { version?: number };
    if (!Number.isInteger(version)) return reply.code(400).send(jsonError("VALIDATION", "version is required"));
    const outcome = app.db.transaction(() => {
      if (!hasWorkspaceMembership(app, workspaceId, userId)) return { member: false as const };
      const row = byId(workspaceId, id);
      if (!row) return { member: true as const, missing: true as const };
      if (row.version !== version) return { member: true as const, conflict: row };
      app.db.prepare("DELETE FROM expense_tags WHERE workspace_id=? AND tag_id=?").run(workspaceId, id);
      app.db.prepare("DELETE FROM tags WHERE workspace_id=? AND id=? AND version=?").run(workspaceId, id, version);
      return { member: true as const, removed: true as const };
    })();
    if (!outcome.member) return sendWorkspaceNotFound(reply);
    if ("missing" in outcome) return reply.code(404).send(jsonError("NOT_FOUND", "Tag not found"));
    if ("conflict" in outcome) return reply.code(409).send(jsonError("VERSION_CONFLICT", "Tag was changed", { current: tagJson(outcome.conflict) }));
    return reply.code(204).send();
  });
}
