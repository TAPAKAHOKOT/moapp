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
  tag_ids?: string | null;
};

export type ExpenseInput = {
  id: string;
  amountMinor: number;
  currency: string;
  categoryId: string;
  occurredAt: string;
  note?: string | null;
  tagIds?: string[];
  version?: number;
};

type ExpenseJson = ReturnType<typeof expenseJson>;
type ExpenseChange = { expense?: ExpenseJson; error?: string; code?: string; current?: ExpenseJson };

export const MAX_EXPENSE_TAGS = 20;

// Теги хранятся в таблице связей, но наружу расход всегда уходит вместе со списком их id,
// поэтому каждая выборка расходов идёт через этот SELECT с алиасом `e`.
export const EXPENSE_SELECT = `SELECT e.*, (SELECT group_concat(et.tag_id) FROM expense_tags et
  WHERE et.workspace_id=e.workspace_id AND et.expense_id=e.id) AS tag_ids FROM expenses e`;

export function parseTagIds(value: string | null | undefined): string[] {
  return value ? value.split(",").sort() : [];
}

export function expenseJson(row: ExpenseRow) {
  return {
    id: row.id,
    amountMinor: row.amount_minor,
    currency: row.currency,
    categoryId: row.category_id,
    occurredAt: row.occurred_at,
    note: row.note,
    tagIds: parseTagIds(row.tag_ids),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at
  };
}

function validTagIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_EXPENSE_TAGS
    && value.every((item) => typeof item === "string" && item.length >= 1 && item.length <= 100)
    && new Set(value).size === value.length;
}

function validate(input: ExpenseInput): string | undefined {
  if (!isUuid(input.id)) return "id must be a UUID";
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) return "amountMinor must be a positive safe integer";
  if (!isCurrency(input.currency)) return "currency must be an ISO 4217 code";
  if (typeof input.categoryId !== "string" || !input.categoryId) return "categoryId is required";
  if (!isTimestamp(input.occurredAt)) return "occurredAt must be an ISO timestamp";
  if (input.note !== undefined && input.note !== null && (typeof input.note !== "string" || input.note.length > 500)) return "note must be at most 500 characters";
  if (input.tagIds !== undefined && !validTagIds(input.tagIds)) return `tagIds must be a unique array of at most ${MAX_EXPENSE_TAGS} tag ids`;
  return undefined;
}

function normalizedNote(note: string | null | undefined): string | null {
  return note?.trim() || null;
}

function sameTagIds(left: string[], right: string[]): boolean {
  const sortedRight = [...right].sort();
  return left.length === sortedRight.length && left.every((id, index) => id === sortedRight[index]);
}

function missingTag(app: FastifyInstance, workspaceId: string, tagIds: string[]): boolean {
  const exists = app.db.prepare("SELECT 1 FROM tags WHERE workspace_id=? AND id=?");
  return tagIds.some((tagId) => !exists.get(workspaceId, tagId));
}

function replaceTags(app: FastifyInstance, workspaceId: string, expenseId: string, tagIds: string[]): void {
  app.db.prepare("DELETE FROM expense_tags WHERE workspace_id=? AND expense_id=?").run(workspaceId, expenseId);
  const insert = app.db.prepare("INSERT INTO expense_tags(workspace_id,expense_id,tag_id) VALUES (?,?,?)");
  for (const tagId of tagIds) insert.run(workspaceId, expenseId, tagId);
}

function readExpense(app: FastifyInstance, workspaceId: string, id: string): ExpenseRow | undefined {
  return app.db.prepare(`${EXPENSE_SELECT} WHERE e.workspace_id=? AND e.id=?`).get(workspaceId, id) as ExpenseRow | undefined;
}

export function createExpense(
  app: FastifyInstance,
  workspaceId: string,
  input: ExpenseInput
): { status: "created" | "existing"; expense: ExpenseJson } | { error: string; code?: string; current?: ExpenseJson } {
  const error = validate(input);
  if (error) return { error };
  const existing = readExpense(app, workspaceId, input.id);
  if (existing) {
    const compatible = existing.amount_minor === input.amountMinor
      && existing.currency === input.currency
      && existing.category_id === input.categoryId
      && existing.occurred_at === new Date(input.occurredAt).toISOString()
      && existing.note === normalizedNote(input.note)
      && (input.tagIds === undefined || sameTagIds(parseTagIds(existing.tag_ids), input.tagIds));
    return compatible
      ? { status: "existing", expense: expenseJson(existing) }
      : { error: "Expense id already exists with different fields", code: "IDEMPOTENCY_CONFLICT", current: expenseJson(existing) };
  }
  const category = app.db.prepare(`SELECT 1 FROM categories
    WHERE workspace_id=? AND id=? AND archived_at IS NULL`).get(workspaceId, input.categoryId);
  if (!category) return { error: "Category not found or archived", code: "CATEGORY_INVALID" };
  const tagIds = input.tagIds ?? [];
  if (missingTag(app, workspaceId, tagIds)) return { error: "Tag not found", code: "TAG_INVALID" };
  const now = new Date().toISOString();
  app.db.prepare(`INSERT INTO expenses
    (workspace_id,id,amount_minor,currency,category_id,occurred_at,note,version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,1,?,?)`)
    .run(workspaceId, input.id, input.amountMinor, input.currency, input.categoryId,
      new Date(input.occurredAt).toISOString(), normalizedNote(input.note), now, now);
  if (tagIds.length) replaceTags(app, workspaceId, input.id, tagIds);
  return { status: "created", expense: expenseJson(readExpense(app, workspaceId, input.id)!) };
}

export function updateExpense(
  app: FastifyInstance,
  workspaceId: string,
  id: string,
  input: Partial<ExpenseInput> & { version: number }
): ExpenseChange {
  const current = readExpense(app, workspaceId, id);
  if (!current) return { error: "Expense not found", code: "NOT_FOUND" };
  if (current.version !== input.version) return { error: "Expense was changed", code: "VERSION_CONFLICT", current: expenseJson(current) };
  const merged: ExpenseInput = {
    id,
    amountMinor: input.amountMinor ?? current.amount_minor,
    currency: input.currency ?? current.currency,
    categoryId: input.categoryId ?? current.category_id,
    occurredAt: input.occurredAt ?? current.occurred_at,
    note: input.note === undefined ? current.note : input.note,
    ...(input.tagIds === undefined ? {} : { tagIds: input.tagIds })
  };
  const error = validate(merged);
  if (error) return { error, code: "VALIDATION" };
  const category = app.db.prepare(`SELECT archived_at FROM categories
    WHERE workspace_id=? AND id=?`).get(workspaceId, merged.categoryId) as { archived_at: string | null } | undefined;
  // An archived category may stay attached to its existing expense so the
  // amount, note, currency or date remain editable. It cannot be newly chosen.
  if (!category || (category.archived_at && merged.categoryId !== current.category_id)) {
    return { error: "Category not found or archived", code: "CATEGORY_INVALID" };
  }
  if (merged.tagIds && missingTag(app, workspaceId, merged.tagIds)) return { error: "Tag not found", code: "TAG_INVALID" };
  app.db.prepare(`UPDATE expenses SET amount_minor=?,currency=?,category_id=?,occurred_at=?,note=?,deleted_at=NULL,
    version=version+1,updated_at=? WHERE workspace_id=? AND id=? AND version=?`)
    .run(merged.amountMinor, merged.currency, merged.categoryId, new Date(merged.occurredAt).toISOString(),
      normalizedNote(merged.note), new Date().toISOString(), workspaceId, id, input.version);
  if (merged.tagIds) replaceTags(app, workspaceId, id, merged.tagIds);
  return { expense: expenseJson(readExpense(app, workspaceId, id)!) };
}

export function deleteExpense(app: FastifyInstance, workspaceId: string, id: string, version: number): ExpenseChange {
  const current = readExpense(app, workspaceId, id);
  if (!current) return { error: "Expense not found", code: "NOT_FOUND" };
  if (current.version !== version) return { error: "Expense was changed", code: "VERSION_CONFLICT", current: expenseJson(current) };
  const now = new Date().toISOString();
  app.db.prepare(`UPDATE expenses SET deleted_at=?,updated_at=?,version=version+1
    WHERE workspace_id=? AND id=? AND version=?`).run(now, now, workspaceId, id, version);
  return { expense: expenseJson(readExpense(app, workspaceId, id)!) };
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
    const q = request.query as { from?: string; to?: string; categoryId?: string; tagId?: string; currency?: string; cursor?: string; limit?: string; includeDeleted?: string };
    const limit = Number(q.limit ?? 50);
    if (!Number.isInteger(limit) || limit < 1) return reply.code(400).send(jsonError("VALIDATION", "limit must be a positive integer"));
    const boundedLimit = Math.min(limit, 200);
    if ((q.from && Number.isNaN(Date.parse(q.from))) || (q.to && Number.isNaN(Date.parse(q.to)))) {
      return reply.code(400).send(jsonError("VALIDATION", "from and to must be ISO timestamps"));
    }
    const where: string[] = ["e.workspace_id=?", q.includeDeleted === "true" ? "1=1" : "e.deleted_at IS NULL"];
    const values: unknown[] = [workspaceId];
    if (q.from) { where.push("e.occurred_at >= ?"); values.push(new Date(q.from).toISOString()); }
    if (q.to) { where.push("e.occurred_at <= ?"); values.push(new Date(q.to).toISOString()); }
    if (q.categoryId) { where.push("e.category_id = ?"); values.push(q.categoryId); }
    if (q.tagId) { where.push("EXISTS (SELECT 1 FROM expense_tags f WHERE f.workspace_id=e.workspace_id AND f.expense_id=e.id AND f.tag_id=?)"); values.push(q.tagId); }
    if (q.currency) { where.push("e.currency = ?"); values.push(q.currency.toUpperCase()); }
    if (q.cursor) {
      const separator = q.cursor.lastIndexOf("|");
      const occurred = q.cursor.slice(0, separator);
      const id = q.cursor.slice(separator + 1);
      if (separator < 1 || !isTimestamp(occurred) || !id) return reply.code(400).send(jsonError("VALIDATION", "cursor is invalid"));
      where.push("(e.occurred_at < ? OR (e.occurred_at = ? AND e.id < ?))");
      values.push(occurred, occurred, id);
    }
    const rows = app.db.prepare(`${EXPENSE_SELECT} WHERE ${where.join(" AND ")}
      ORDER BY e.occurred_at DESC,e.id DESC LIMIT ?`).all(...values, boundedLimit + 1) as ExpenseRow[];
    const hasMore = rows.length > boundedLimit;
    const items = rows.slice(0, boundedLimit);
    const last = items.at(-1);
    return { expenses: items.map(expenseJson), nextCursor: hasMore && last ? `${last.occurred_at}|${last.id}` : null };
  });

  app.get(`${prefix}/:id`, { preHandler: app.requireWorkspaceMember, onSend: noStore }, async (request, reply) => {
    const { workspaceId } = workspaceContext(request);
    const row = readExpense(app, workspaceId, (request.params as { id: string }).id);
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
