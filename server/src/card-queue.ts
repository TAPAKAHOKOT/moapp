import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createExpense, deleteExpense, EXPENSE_SELECT, expenseJson, MAX_EXPENSE_PARTS, type ExpenseRow } from "./expenses.js";
import { hasWorkspaceMembership, noStore, requireMutationOrigin, workspaceContext } from "./tenant-domain-guard.js";
import { jsonError } from "./validation.js";

/*
 * Очередь разбора — общая для всех источников операций с карт: Bybit присылает их сам, выписку Т‑Банка
 * человек загружает файлом. Разбор, разделение, «Это не расход» и отмена одинаковы для любой операции,
 * источник различает только то, откуда строка пришла и как её узнать при следующей загрузке.
 */
export type CardSource = "bybit-card" | "tbank";

const ATM_MCC_CODE = "6011";

export type TransactionRow = {
  id: string;
  workspace_id: string;
  source: CardSource;
  connection_id: string | null;
  external_key: string;
  raw_json: string;
  txn_id: string | null;
  order_no: string | null;
  side: string;
  amount_minor: number;
  currency: string;
  merchant_name: string | null;
  merchant_country: string | null;
  merchant_city: string | null;
  mcc_code: string | null;
  merchant_category: string | null;
  occurred_at: string;
  trade_status: string;
  provider_status: string;
  review_status: "pending" | "classified" | "ignored" | "split";
  expense_id: string | null;
  split_of_id: string | null;
  split_index: number;
  split_count?: number;
};

/*
 * Reviewable rows: settled payments (trade 1) and open authorizations (trade 0) that the provider accepted.
 * trade_status: 0 in progress, 1 completed, 2 declined, 3 reversal. provider_status: 1 success, 2 fail.
 */
export const REVIEWABLE_ROW_FILTER = "trade_status IN ('0','1') AND provider_status='1'";

export function isAtmWithdrawal(side: string, mccCode: string | null): boolean {
  return side === "13" || mccCode === ATM_MCC_CODE;
}

// Число частей всегда приходит из строки (QUEUE_SELECT): вторым параметром его брать нельзя,
// иначе `rows.map(transactionJson)` подставит сюда индекс массива.
export function transactionJson(row: TransactionRow) {
  const splitCount = row.split_count ?? 0;
  return {
    id: row.id,
    source: row.source,
    txnId: row.txn_id,
    orderNo: row.order_no,
    type: isAtmWithdrawal(row.side, row.mcc_code) ? "atm" : "purchase",
    amountMinor: row.amount_minor,
    currency: row.currency,
    merchantName: row.merchant_name,
    merchantCountry: row.merchant_country,
    merchantCity: row.merchant_city,
    mccCode: row.mcc_code,
    merchantCategory: row.merchant_category,
    occurredAt: row.occurred_at,
    reviewStatus: row.review_status,
    expenseId: row.expense_id,
    /* Часть разделённого платежа знает свой номер и сколько всего частей: карточка говорит «Часть 2 из 3». */
    splitIndex: row.split_of_id ? row.split_index : null,
    splitCount: row.split_of_id ? splitCount : null,
    settled: row.trade_status === "1"
  };
}

/* Строка очереди вместе с числом частей своего платежа: у целой операции их нет. */
const QUEUE_SELECT = `SELECT t.*, (SELECT count(*) FROM card_transactions s WHERE s.split_of_id=t.split_of_id) split_count
  FROM card_transactions t`;

export function pendingCount(app: FastifyInstance, workspaceId: string): number {
  const row = app.db.prepare(`SELECT count(*) count FROM card_transactions
    WHERE workspace_id=? AND review_status='pending' AND ${REVIEWABLE_ROW_FILTER}`).get(workspaceId) as { count: number };
  return row.count;
}

function readTransaction(app: FastifyInstance, workspaceId: string, id: string): TransactionRow | undefined {
  return app.db.prepare(`${QUEUE_SELECT} WHERE t.workspace_id=? AND t.id=?`).get(workspaceId, id) as TransactionRow | undefined;
}

/*
 * Провайдер отклонил или вернул операцию: она уходит из очереди, а расходы, уже записанные из неё
 * (и из каждой её части, если платёж делили), остаются в истории, но выпадают из итогов, пока человек
 * не решит, что с ними делать. Строки ещё нет — делать нечего: отклонённое не сохраняется.
 */
export function voidCardTransaction(
  app: FastifyInstance,
  workspaceId: string,
  source: CardSource,
  externalKey: string,
  change: { tradeStatus: string; providerStatus: string; rawJson: string; kind: "declined" | "reversed" },
  now: string
): void {
  const linked = app.db.prepare(`SELECT e.id expense_id,t.txn_id,t.merchant_name,t.amount_minor,t.currency
    FROM card_transactions t
    JOIN card_transactions p ON p.id=t.id OR p.split_of_id=t.id
    JOIN expenses e ON e.workspace_id=p.workspace_id AND e.source_transaction_id=p.id AND e.deleted_at IS NULL
    WHERE t.workspace_id=? AND t.source=? AND t.external_key=?`).all(workspaceId, source, externalKey) as
    Array<{ expense_id: string; txn_id: string | null; merchant_name: string | null; amount_minor: number; currency: string }>;
  app.db.prepare(`UPDATE card_transactions
    SET trade_status=?,provider_status=?,raw_json=?,updated_at=?,
      review_status=CASE WHEN review_status='pending' THEN 'ignored' ELSE review_status END
    WHERE workspace_id=? AND source=? AND external_key=?`)
    .run(change.tradeStatus, change.providerStatus, change.rawJson, now, workspaceId, source, externalKey);
  /* Части не приходят от провайдера по своему ключу, поэтому из очереди их убирает отдельный запрос. */
  app.db.prepare(`UPDATE card_transactions SET updated_at=?,
      review_status=CASE WHEN review_status='pending' THEN 'ignored' ELSE review_status END
    WHERE split_of_id=(SELECT id FROM card_transactions WHERE workspace_id=? AND source=? AND external_key=?)`)
    .run(now, workspaceId, source, externalKey);
  const voidExpense = app.db.prepare(`UPDATE expenses SET voided_at=?,void_reason=?,updated_at=?,version=version+1
    WHERE workspace_id=? AND id=? AND deleted_at IS NULL AND voided_at IS NULL`);
  for (const part of linked) {
    const reason = JSON.stringify({
      provider: source, kind: change.kind,
      txnId: part.txn_id, merchantName: part.merchant_name, amountMinor: part.amount_minor, currency: part.currency
    });
    voidExpense.run(now, reason, now, workspaceId, part.expense_id);
  }
}

/* Брошено внутри транзакции отмены, чтобы уже удалённые части вернулись на место. */
class UndoConflict extends Error {}

/* Брошено внутри транзакции разбора: неудачная часть должна отменить уже созданные, а не оставить их сиротами. */
class ClassifyFailed extends Error {
  constructor(readonly code: string | undefined, readonly reason: string) { super(reason); }
}

/*
 * Разделение платежа спрашивает только суммы: части встают в очередь обычными строками,
 * а категорию, теги и заметку каждая получает на привычной карточке разбора.
 */
export function parseSplitAmounts(value: unknown, totalMinor: number): { amounts: number[] } | { error: string; code: string } {
  if (!Array.isArray(value) || value.length < 2) return { error: "amounts must list at least two parts", code: "VALIDATION" };
  if (value.length > MAX_EXPENSE_PARTS) return { error: `amounts must list at most ${MAX_EXPENSE_PARTS} parts`, code: "VALIDATION" };
  if (!value.every((item) => Number.isSafeInteger(item) && (item as number) > 0)) {
    return { error: "each amount must be a positive safe integer", code: "VALIDATION" };
  }
  const amounts = value as number[];
  if (amounts.reduce((total, amount) => total + amount, 0) !== totalMinor) {
    return { error: "amounts must add up to the operation amount", code: "SPLIT_MISMATCH" };
  }
  return { amounts };
}

function listParts(app: FastifyInstance, workspaceId: string, parentId: string): TransactionRow[] {
  return app.db.prepare(`${QUEUE_SELECT} WHERE t.workspace_id=? AND t.split_of_id=? ORDER BY t.split_index`)
    .all(workspaceId, parentId) as TransactionRow[];
}

function insertParts(app: FastifyInstance, parent: TransactionRow, amounts: number[], now: string): void {
  const insert = app.db.prepare(`INSERT INTO card_transactions
    (id,workspace_id,source,connection_id,external_key,txn_id,order_no,side,trade_status,provider_status,amount_minor,currency,
      merchant_name,merchant_country,merchant_city,mcc_code,merchant_category,occurred_at,review_status,expense_id,
      split_of_id,split_index,raw_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',NULL,?,?,?,?,?)`);
  amounts.forEach((amountMinor, index) => insert.run(
    randomUUID(), parent.workspace_id, parent.source, parent.connection_id, `${parent.external_key}#${index + 1}`, parent.txn_id,
    parent.order_no, parent.side, parent.trade_status, parent.provider_status, amountMinor, parent.currency, parent.merchant_name,
    parent.merchant_country, parent.merchant_city, parent.mcc_code, parent.merchant_category, parent.occurred_at,
    parent.id, index + 1, parent.raw_json, now, now
  ));
}

/* Собрать платёж обратно можно, пока ни одна часть не записана в историю. */
export function collapseSplit(app: FastifyInstance, workspaceId: string, parentId: string, now: string): boolean {
  const classified = app.db.prepare(`SELECT count(*) count FROM card_transactions
    WHERE workspace_id=? AND split_of_id=? AND review_status='classified'`).get(workspaceId, parentId) as { count: number };
  if (classified.count) return false;
  app.db.prepare("DELETE FROM card_transactions WHERE workspace_id=? AND split_of_id=?").run(workspaceId, parentId);
  app.db.prepare(`UPDATE card_transactions SET review_status='pending',updated_at=?
    WHERE workspace_id=? AND id=? AND review_status='split'`).run(now, workspaceId, parentId);
  return true;
}

/* Расходы, рождённые одной операцией карты: их может быть несколько, если операцию разделили. */
function linkedExpenses(app: FastifyInstance, workspaceId: string, transactionId: string) {
  // Части возвращаются в том порядке, в каком их записали: у них совпадает created_at, поэтому решает rowid.
  const rows = app.db.prepare(`${EXPENSE_SELECT} WHERE e.workspace_id=? AND e.source_transaction_id=? AND e.deleted_at IS NULL
    ORDER BY e.created_at,e.rowid`).all(workspaceId, transactionId) as ExpenseRow[];
  return rows.map(expenseJson);
}

/* Заявка на отмену: расход называют вместе с версией, иначе правку с другого устройства снесло бы молча. */
function expenseClaims(body: { expenseId?: unknown; expenseVersion?: unknown; expenses?: unknown }): Array<{ id: string; version: number }> | null {
  const requested = Array.isArray(body.expenses) ? body.expenses
    : typeof body.expenseId === "string" ? [{ id: body.expenseId, version: body.expenseVersion }]
    : [];
  const valid = requested.every((item) => item && typeof item === "object"
    && typeof (item as { id?: unknown }).id === "string" && Number.isInteger((item as { version?: unknown }).version));
  return valid ? requested as Array<{ id: string; version: number }> : null;
}

/* Записанные части для ответа 409: экран говорит, что именно уйдёт из истории, если собирать платёж. */
function recordedPartsJson(app: FastifyInstance, workspaceId: string, rows: TransactionRow[]) {
  return rows.map((row) => ({
    id: row.id,
    splitIndex: row.split_index,
    splitCount: row.split_count ?? rows.length,
    amountMinor: row.amount_minor,
    currency: row.currency,
    expenses: linkedExpenses(app, workspaceId, row.id)
  }));
}

function fail(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send(jsonError(code, message));
}

/*
 * Маршруты разбора живут под `/integrations/card-queue`. Прежний адрес `/integrations/bybit-card/transactions`
 * оставлен, пока телефоны с закэшированным старым клиентом не обновятся.
 */
export async function registerCardQueueRoutes(app: FastifyInstance): Promise<void> {
  const mutation = (request: FastifyRequest, reply: FastifyReply) => requireMutationOrigin(app, request, reply);
  const queuePrefix = "/api/workspaces/:workspaceId/integrations/card-queue";

  app.get(queuePrefix, { preHandler: app.requireWorkspaceMember, onSend: noStore }, async (request) => ({
    pendingCount: pendingCount(app, workspaceContext(request).workspaceId)
  }));

  for (const prefix of [`${queuePrefix}/transactions`, "/api/workspaces/:workspaceId/integrations/bybit-card/transactions"]) {
    app.get(prefix, { preHandler: app.requireWorkspaceMember, onSend: noStore }, async (request, reply) => {
      const { workspaceId } = workspaceContext(request);
      const requestedLimit = Number((request.query as { limit?: string }).limit ?? 100);
      if (!Number.isInteger(requestedLimit) || requestedLimit < 1) return fail(reply, 400, "VALIDATION", "limit must be a positive integer");
      const rows = app.db.prepare(`${QUEUE_SELECT}
        WHERE t.workspace_id=? AND t.review_status='pending' AND ${REVIEWABLE_ROW_FILTER.replace(/(\w+_status)/g, "t.$1")}
        ORDER BY t.occurred_at,t.split_index,t.id LIMIT ?`).all(workspaceId, Math.min(200, requestedLimit)) as TransactionRow[];
      return { transactions: rows.map(transactionJson), pendingCount: pendingCount(app, workspaceId) };
    });

    /* Операция (или часть разделённого платежа) кладётся в одну категорию — это всегда один расход. */
    app.post(`${prefix}/:transactionId/classify`, { preHandler: [app.requireWorkspaceMember, mutation], onSend: noStore }, async (request, reply) => {
      const { workspaceId, userId } = workspaceContext(request);
      const transactionId = (request.params as { transactionId: string }).transactionId;
      const body = request.body as { categoryId?: unknown; comment?: unknown; tagIds?: unknown };
      const categoryId = typeof body.categoryId === "string" ? body.categoryId : "";
      const comment = typeof body.comment === "string" ? body.comment.trim().slice(0, 200) : "";
      if (!categoryId) return fail(reply, 400, "VALIDATION", "categoryId is required");
      if (body.tagIds !== undefined && (!Array.isArray(body.tagIds) || body.tagIds.some((item) => typeof item !== "string"))) return fail(reply, 400, "VALIDATION", "tagIds must be an array of tag ids");
      const tagIds = (body.tagIds as string[] | undefined) ?? [];
      const classification = app.db.transaction(() => {
        if (!hasWorkspaceMembership(app, workspaceId, userId)) return { kind: "missing" as const };
        const row = readTransaction(app, workspaceId, transactionId);
        if (!row) return { kind: "missing" as const };
        if (row.review_status === "classified") {
          const expenses = linkedExpenses(app, workspaceId, transactionId);
          return expenses.length ? { kind: "classified" as const, row, expenses } : { kind: "reviewed" as const };
        }
        if (row.review_status !== "pending") return { kind: "reviewed" as const };
        const note = [row.merchant_name, comment].filter((value, index, values) => value && values.indexOf(value) === index).join(" · ").slice(0, 500) || null;
        const created = createExpense(app, workspaceId, {
          id: randomUUID(), amountMinor: row.amount_minor, currency: row.currency, categoryId,
          occurredAt: row.occurred_at, note, tagIds
        }, row.id);
        if ("error" in created) throw new ClassifyFailed(created.code, created.error);
        app.db.prepare(`UPDATE card_transactions SET review_status='classified',expense_id=?,updated_at=? WHERE workspace_id=? AND id=?`)
          .run(created.expense.id, new Date().toISOString(), workspaceId, transactionId);
        return { kind: "classified" as const, row: { ...row, review_status: "classified", expense_id: created.expense.id } as TransactionRow, expenses: [created.expense] };
      });
      let outcome;
      try { outcome = classification(); }
      catch (error) {
        if (!(error instanceof ClassifyFailed)) throw error;
        return fail(reply, 400, error.code ?? "VALIDATION", error.reason);
      }
      if (outcome.kind === "missing") return fail(reply, 404, "NOT_FOUND", "Imported transaction not found");
      if (outcome.kind === "reviewed") return fail(reply, 409, "ALREADY_REVIEWED", "Imported transaction was already reviewed");
      return {
        transaction: transactionJson(outcome.row), expense: outcome.expenses[0]!, expenses: outcome.expenses,
        pendingCount: pendingCount(app, workspaceId)
      };
    });

    /* «Разделить»: платёж превращается в несколько строк очереди, каждая со своей суммой. */
    app.post(`${prefix}/:transactionId/split`, { preHandler: [app.requireWorkspaceMember, mutation], onSend: noStore }, async (request, reply) => {
      const { workspaceId, userId } = workspaceContext(request);
      const transactionId = (request.params as { transactionId: string }).transactionId;
      const body = (request.body ?? {}) as { amounts?: unknown };
      const outcome = app.db.transaction(() => {
        if (!hasWorkspaceMembership(app, workspaceId, userId)) return { kind: "missing" as const };
        const row = readTransaction(app, workspaceId, transactionId);
        if (!row) return { kind: "missing" as const };
        if (row.split_of_id) return { kind: "already-part" as const };
        if (row.review_status !== "pending") return { kind: "reviewed" as const };
        const parsed = parseSplitAmounts(body.amounts, row.amount_minor);
        if ("error" in parsed) return { kind: "invalid" as const, error: parsed.error, code: parsed.code };
        const now = new Date().toISOString();
        insertParts(app, row, parsed.amounts, now);
        app.db.prepare("UPDATE card_transactions SET review_status='split',updated_at=? WHERE workspace_id=? AND id=?")
          .run(now, workspaceId, transactionId);
        return { kind: "split" as const, parts: listParts(app, workspaceId, row.id) };
      })();
      if (outcome.kind === "missing") return fail(reply, 404, "NOT_FOUND", "Imported transaction not found");
      if (outcome.kind === "already-part") return fail(reply, 409, "ALREADY_SPLIT", "This is already a part of a split payment");
      if (outcome.kind === "reviewed") return fail(reply, 409, "ALREADY_REVIEWED", "Imported transaction was already reviewed");
      if (outcome.kind === "invalid") return fail(reply, 400, outcome.code, outcome.error);
      return { transactions: outcome.parts.map((part) => transactionJson(part)), pendingCount: pendingCount(app, workspaceId) };
    });

    /*
     * «Собрать части»: части исчезают, платёж возвращается в очередь целиком.
     * Записанные части не сносятся молча — без `expenses` ответ 409 перечисляет их вместе с расходами,
     * чтобы экран мог спросить и повторить запрос уже с точными версиями.
     */
    app.post(`${prefix}/:transactionId/unsplit`, { preHandler: [app.requireWorkspaceMember, mutation], onSend: noStore }, async (request, reply) => {
      const { workspaceId, userId } = workspaceContext(request);
      const transactionId = (request.params as { transactionId: string }).transactionId;
      const claimed = expenseClaims((request.body ?? {}) as { expenses?: unknown });
      const run = app.db.transaction(() => {
        if (!hasWorkspaceMembership(app, workspaceId, userId)) return { kind: "missing" as const };
        const row = readTransaction(app, workspaceId, transactionId);
        if (!row) return { kind: "missing" as const };
        const parent = row.split_of_id ? readTransaction(app, workspaceId, row.split_of_id) : row;
        if (!parent || parent.review_status !== "split") return { kind: "missing" as const };
        const parts = listParts(app, workspaceId, parent.id);
        const removed = parts.map((part) => part.id);
        const recorded = parts.filter((part) => part.review_status === "classified");
        const undone: string[] = [];
        if (recorded.length) {
          const linked = recorded.flatMap((part) => linkedExpenses(app, workspaceId, part.id));
          // Отмена только по названным версиям: расход, изменённый на другом устройстве, не удаляют вслепую.
          const named = claimed !== null && claimed.length === linked.length
            && linked.every((expense) => claimed.some((item) => item.id === expense.id && item.version === expense.version));
          if (!named) return { kind: "conflict" as const, recorded: recordedPartsJson(app, workspaceId, recorded) };
          for (const expense of linked) {
            if (deleteExpense(app, workspaceId, expense.id, expense.version).error) throw new UndoConflict();
            undone.push(expense.id);
          }
          app.db.prepare(`UPDATE card_transactions SET review_status='pending',expense_id=NULL,updated_at=?
            WHERE workspace_id=? AND split_of_id=? AND review_status='classified'`)
            .run(new Date().toISOString(), workspaceId, parent.id);
        }
        if (!collapseSplit(app, workspaceId, parent.id, new Date().toISOString())) throw new UndoConflict();
        return { kind: "merged" as const, row: readTransaction(app, workspaceId, parent.id)!, removed, undone };
      });
      let outcome;
      try { outcome = run(); }
      catch (error) { if (error instanceof UndoConflict) outcome = { kind: "stale" as const }; else throw error; }
      if (outcome.kind === "missing") return fail(reply, 404, "NOT_FOUND", "Split payment not found");
      if (outcome.kind === "stale") return fail(reply, 409, "UNDO_CONFLICT", "The recorded part was already changed and cannot be undone here");
      if (outcome.kind === "conflict") {
        return reply.code(409).send(jsonError("SPLIT_IN_USE", "A part of this payment is already recorded; undo it first", { recorded: outcome.recorded }));
      }
      return {
        transaction: transactionJson(outcome.row), removedTransactionIds: outcome.removed,
        undoneExpenseIds: outcome.undone, pendingCount: pendingCount(app, workspaceId)
      };
    });

    app.post(`${prefix}/:transactionId/ignore`, { preHandler: [app.requireWorkspaceMember, mutation], onSend: noStore }, async (request, reply) => {
      const { workspaceId, userId } = workspaceContext(request);
      const transactionId = (request.params as { transactionId: string }).transactionId;
      const changed = app.db.transaction(() => {
        if (!hasWorkspaceMembership(app, workspaceId, userId)) return 0;
        return app.db.prepare(`UPDATE card_transactions SET review_status='ignored',updated_at=?
          WHERE workspace_id=? AND id=? AND review_status='pending'`).run(new Date().toISOString(), workspaceId, transactionId).changes;
      })();
      if (!changed) return fail(reply, 404, "NOT_FOUND", "Pending imported transaction not found");
      return { pendingCount: pendingCount(app, workspaceId) };
    });

    /* Отмена снимает всю операцию целиком: разделённая операция возвращается в очередь только вместе со всеми частями. */
    app.post(`${prefix}/:transactionId/undo`, { preHandler: [app.requireWorkspaceMember, mutation], onSend: noStore }, async (request, reply) => {
      const { workspaceId, userId } = workspaceContext(request);
      const transactionId = (request.params as { transactionId: string }).transactionId;
      const claimed = expenseClaims((request.body ?? {}) as { expenseId?: unknown; expenseVersion?: unknown; expenses?: unknown });
      const outcome = app.db.transaction(() => {
        if (!hasWorkspaceMembership(app, workspaceId, userId)) return { kind: "missing" as const };
        const row = readTransaction(app, workspaceId, transactionId);
        if (!row) return { kind: "missing" as const };
        if (row.review_status === "pending") return { kind: "undone" as const, row, expenseIds: [] as string[] };
        if (row.review_status === "classified") {
          const linked = linkedExpenses(app, workspaceId, transactionId);
          if (!claimed || !linked.length || claimed.length !== linked.length) return { kind: "conflict" as const };
          const matches = linked.every((expense) => claimed.some((item) => item.id === expense.id && item.version === expense.version));
          if (!matches) return { kind: "conflict" as const };
          for (const expense of linked) {
            const removed = deleteExpense(app, workspaceId, expense.id, expense.version);
            if (removed.error) throw new UndoConflict();
          }
          app.db.prepare(`UPDATE card_transactions SET review_status='pending',expense_id=NULL,updated_at=?
            WHERE workspace_id=? AND id=? AND review_status='classified'`)
            .run(new Date().toISOString(), workspaceId, transactionId);
          return { kind: "undone" as const, row: { ...row, review_status: "pending", expense_id: null } as TransactionRow, expenseIds: linked.map((expense) => expense.id) };
        }
        app.db.prepare(`UPDATE card_transactions SET review_status='pending',updated_at=?
          WHERE workspace_id=? AND id=? AND review_status='ignored'`)
          .run(new Date().toISOString(), workspaceId, transactionId);
        return { kind: "undone" as const, row: { ...row, review_status: "pending" } as TransactionRow, expenseIds: [] as string[] };
      });
      let result;
      try { result = outcome(); }
      catch (error) { if (error instanceof UndoConflict) result = { kind: "conflict" as const }; else throw error; }
      if (result.kind === "missing") return fail(reply, 404, "NOT_FOUND", "Imported transaction not found");
      if (result.kind === "conflict") return fail(reply, 409, "UNDO_CONFLICT", "The created expense was already changed and cannot be undone here");
      return {
        transaction: transactionJson(result.row), undoneExpenseId: result.expenseIds[0] ?? null, undoneExpenseIds: result.expenseIds,
        pendingCount: pendingCount(app, workspaceId)
      };
    });
  }
}
