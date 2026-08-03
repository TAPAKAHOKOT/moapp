import type { FastifyInstance } from "fastify";
import type { ExpenseRow } from "./types.js";
import { isCurrency, isTimestamp, isUuid, jsonError } from "./validation.js";

export type ExpenseInput = {
  id: string; amountMinor: number; currency: string; categoryId: string;
  occurredAt: string; note?: string | null; version?: number;
};

export function expenseJson(row: ExpenseRow) {
  return {
    id: row.id, amountMinor: row.amount_minor, currency: row.currency,
    categoryId: row.category_id, occurredAt: row.occurred_at, note: row.note,
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
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

export function createExpense(app: FastifyInstance, input: ExpenseInput): { status: "created" | "existing"; expense: ReturnType<typeof expenseJson> } | { error: string; code?: string } {
  const error = validate(input);
  if (error) return { error };
  const existing = app.db.prepare("SELECT * FROM expenses WHERE id = ?").get(input.id) as ExpenseRow | undefined;
  if (existing) return { status: "existing", expense: expenseJson(existing) };
  const category = app.db.prepare("SELECT 1 FROM categories WHERE id = ? AND archived_at IS NULL").get(input.categoryId);
  if (!category) return { error: "Category not found or archived", code: "CATEGORY_INVALID" };
  const now = new Date().toISOString();
  app.db.prepare(`INSERT INTO expenses(id,amount_minor,currency,category_id,occurred_at,note,version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,1,?,?)`).run(input.id, input.amountMinor, input.currency, input.categoryId, new Date(input.occurredAt).toISOString(), input.note?.trim() || null, now, now);
  return { status: "created", expense: expenseJson(app.db.prepare("SELECT * FROM expenses WHERE id = ?").get(input.id) as ExpenseRow) };
}

export function updateExpense(app: FastifyInstance, id: string, input: Partial<ExpenseInput> & { version: number }): { expense?: ReturnType<typeof expenseJson>; error?: string; code?: string; current?: ReturnType<typeof expenseJson> } {
  const current = app.db.prepare("SELECT * FROM expenses WHERE id = ?").get(id) as ExpenseRow | undefined;
  if (!current) return { error: "Expense not found", code: "NOT_FOUND" };
  if (current.version !== input.version) return { error: "Expense was changed", code: "VERSION_CONFLICT", current: expenseJson(current) };
  const merged: ExpenseInput = {
    id, amountMinor: input.amountMinor ?? current.amount_minor, currency: input.currency ?? current.currency,
    categoryId: input.categoryId ?? current.category_id, occurredAt: input.occurredAt ?? current.occurred_at,
    note: input.note === undefined ? current.note : input.note
  };
  const error = validate(merged);
  if (error) return { error, code: "VALIDATION" };
  if (!app.db.prepare("SELECT 1 FROM categories WHERE id = ?").get(merged.categoryId)) return { error: "Category not found", code: "CATEGORY_INVALID" };
  app.db.prepare(`UPDATE expenses SET amount_minor=?,currency=?,category_id=?,occurred_at=?,note=?,deleted_at=NULL,
    version=version+1,updated_at=? WHERE id=? AND version=?`).run(merged.amountMinor, merged.currency, merged.categoryId,
    new Date(merged.occurredAt).toISOString(), merged.note?.trim() || null, new Date().toISOString(), id, input.version);
  return { expense: expenseJson(app.db.prepare("SELECT * FROM expenses WHERE id = ?").get(id) as ExpenseRow) };
}

export function deleteExpense(app: FastifyInstance, id: string, version: number) {
  const current = app.db.prepare("SELECT * FROM expenses WHERE id = ?").get(id) as ExpenseRow | undefined;
  if (!current) return { error: "Expense not found", code: "NOT_FOUND" };
  if (current.version !== version) return { error: "Expense was changed", code: "VERSION_CONFLICT", current: expenseJson(current) };
  const now = new Date().toISOString();
  app.db.prepare("UPDATE expenses SET deleted_at=?,updated_at=?,version=version+1 WHERE id=? AND version=?").run(now, now, id, version);
  return { expense: expenseJson(app.db.prepare("SELECT * FROM expenses WHERE id = ?").get(id) as ExpenseRow) };
}

function sendResult(reply: import("fastify").FastifyReply, result: ReturnType<typeof updateExpense> | ReturnType<typeof deleteExpense>) {
  if (!result.error) return reply.send(result.expense);
  const status = result.code === "NOT_FOUND" ? 404 : result.code === "VERSION_CONFLICT" ? 409 : 400;
  return reply.code(status).send(jsonError(result.code ?? "VALIDATION", result.error, result.current ? { current: result.current } : undefined));
}

export async function registerExpenseRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/expenses", { preHandler: app.requireAuth }, async (request, reply) => {
    const q = request.query as { from?: string; to?: string; categoryId?: string; currency?: string; cursor?: string; limit?: string; includeDeleted?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 50), 1), 200);
    if (!Number.isInteger(limit)) return reply.code(400).send(jsonError("VALIDATION", "limit must be an integer"));
    if ((q.from && Number.isNaN(Date.parse(q.from))) || (q.to && Number.isNaN(Date.parse(q.to))))
      return reply.code(400).send(jsonError("VALIDATION", "from and to must be ISO timestamps"));
    const where: string[] = [q.includeDeleted === "true" ? "1=1" : "deleted_at IS NULL"];
    const values: unknown[] = [];
    if (q.from) { where.push("occurred_at >= ?"); values.push(new Date(q.from).toISOString()); }
    if (q.to) { where.push("occurred_at <= ?"); values.push(new Date(q.to).toISOString()); }
    if (q.categoryId) { where.push("category_id = ?"); values.push(q.categoryId); }
    if (q.currency) { where.push("currency = ?"); values.push(q.currency.toUpperCase()); }
    if (q.cursor) { where.push("(occurred_at < ? OR (occurred_at = ? AND id < ?))"); const [occurred, id] = q.cursor.split("|"); values.push(occurred, occurred, id); }
    const rows = app.db.prepare(`SELECT * FROM expenses WHERE ${where.join(" AND ")} ORDER BY occurred_at DESC,id DESC LIMIT ?`).all(...values, limit + 1) as ExpenseRow[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return { expenses: items.map(expenseJson), nextCursor: hasMore && last ? `${last.occurred_at}|${last.id}` : null };
  });

  app.get("/api/expenses/:id", { preHandler: app.requireAuth }, async (request, reply) => {
    const row = app.db.prepare("SELECT * FROM expenses WHERE id = ?").get((request.params as { id: string }).id) as ExpenseRow | undefined;
    return row ? expenseJson(row) : reply.code(404).send(jsonError("NOT_FOUND", "Expense not found"));
  });

  app.post("/api/expenses", { preHandler: app.requireAuth }, async (request, reply) => {
    const body = request.body as ExpenseInput;
    if (typeof body.currency === "string") body.currency = body.currency.toUpperCase();
    const result = createExpense(app, body);
    if ("error" in result) return reply.code(400).send(jsonError(result.code ?? "VALIDATION", result.error));
    return reply.code(result.status === "created" ? 201 : 200).send(result.expense);
  });

  app.patch("/api/expenses/:id", { preHandler: app.requireAuth }, async (request, reply) => {
    const body = request.body as Partial<ExpenseInput> & { version: number };
    if (!Number.isInteger(body.version)) return reply.code(400).send(jsonError("VALIDATION", "version is required"));
    if (typeof body.currency === "string") body.currency = body.currency.toUpperCase();
    return sendResult(reply, updateExpense(app, (request.params as { id: string }).id, body));
  });

  app.delete("/api/expenses/:id", { preHandler: app.requireAuth }, async (request, reply) => {
    const { version } = (request.body ?? {}) as { version?: number };
    if (!Number.isInteger(version)) return reply.code(400).send(jsonError("VALIDATION", "version is required"));
    const result = deleteExpense(app, (request.params as { id: string }).id, version!);
    if (result.error) return sendResult(reply, result);
    return reply.code(204).send();
  });
}
