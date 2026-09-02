import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createExpense, deleteExpense, EXPENSE_SELECT, expenseJson, type ExpenseRow } from "./expenses.js";
import { hasWorkspaceMembership, noStore, requireMutationOrigin, workspaceContext } from "./tenant-domain-guard.js";
import { isCurrency, jsonError, minorDigits } from "./validation.js";

const RECV_WINDOW = "5000";
const SYNC_OVERLAP_MS = 7 * 24 * 60 * 60 * 1000;
const SYNC_INTERVAL_MS = 15 * 60 * 1000;
const MIN_SYNC_INTERVAL_MS = 60 * 1000;
const SCHEDULER_INITIAL_DELAY_MS = 60 * 1000;
const MAX_RATE_LIMIT_RETRY_DELAY_MS = 5 * 1000;
const MAX_PAGES = 100;

export const BYBIT_REGIONS = {
  global: "https://api.bybit.com",
  eu: "https://api.bybit.eu",
  nl: "https://api.bybit.nl",
  tr: "https://api.bybit.tr",
  kz: "https://api.bybit.kz",
  ge: "https://api.bybitgeorgia.ge",
  ae: "https://api.bybit.ae",
  id: "https://api.bybit.id"
} as const;

type BybitRegion = keyof typeof BYBIT_REGIONS;
type FetchLike = typeof fetch;
type Credentials = { apiKey: string; apiSecret: string; region: BybitRegion };

type ConnectionRow = {
  id: string;
  workspace_id: string;
  connected_by_user_id: string;
  credentials_encrypted: string;
  region: BybitRegion;
  enabled_at: string;
  last_synced_at: string | null;
  status: "active" | "error";
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type TransactionRow = {
  id: string;
  workspace_id: string;
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
  review_status: "pending" | "classified" | "ignored";
  expense_id: string | null;
};

type AssetRecord = {
  tradeStatus?: unknown;
  side?: unknown;
  basicAmount?: unknown;
  basicCurrency?: unknown;
  transactionAmount?: unknown;
  transactionCurrency?: unknown;
  transactionCurrencyAmount?: unknown;
  txnCreate?: unknown;
  merchCountry?: unknown;
  merchCity?: unknown;
  merchName?: unknown;
  txnId?: unknown;
  orderNo?: unknown;
  status?: unknown;
  mccCode?: unknown;
  merchCategoryDesc?: unknown;
};

class BybitError extends Error {
  constructor(
    message: string,
    readonly code = "BYBIT_UNAVAILABLE",
    readonly retCode: string | number | undefined = undefined,
    readonly requestId: string | undefined = undefined
  ) { super(message); }
}

const activeSyncs = new WeakMap<FastifyInstance, Set<string>>();

function syncSet(app: FastifyInstance): Set<string> {
  const existing = activeSyncs.get(app);
  if (existing) return existing;
  const created = new Set<string>();
  activeSyncs.set(app, created);
  return created;
}

function fail(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send(jsonError(code, message));
}

function encryptionKey(app: FastifyInstance): Buffer {
  return createHash("sha256").update(app.config.integrationEncryptionKey, "utf8").digest();
}

export function encryptBybitCredentials(app: FastifyInstance, credentials: Credentials): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(app), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(credentials), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(":");
}

export function decryptBybitCredentials(app: FastifyInstance, value: string): Credentials {
  const [version, ivText, tagText, encryptedText] = value.split(":");
  if (version !== "v1" || !ivText || !tagText || !encryptedText) throw new Error("Unsupported encrypted credential format");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(app), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  const decoded = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64url")), decipher.final()]).toString("utf8")) as Credentials;
  if (!decoded.apiKey || !decoded.apiSecret || !(decoded.region in BYBIT_REGIONS)) throw new Error("Stored Bybit credentials are invalid");
  return decoded;
}

type RequestParameters = Record<string, string | number>;

async function signedRequest<T>(
  fetchImpl: FetchLike,
  credentials: Credentials,
  method: "GET" | "POST",
  path: string,
  options: { query?: RequestParameters; body?: Record<string, unknown>; baseUrl?: string | undefined } = {}
): Promise<T> {
  const queryString = options.query ? new URLSearchParams(
    Object.entries(options.query).map(([key, value]) => [key, String(value)])
  ).toString() : "";
  const jsonBody = options.body ? JSON.stringify(options.body) : "";
  const url = `${options.baseUrl ?? BYBIT_REGIONS[credentials.region]}${path}${queryString ? `?${queryString}` : ""}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const timestamp = String(Date.now());
    const signatureParameters = method === "GET" ? queryString : jsonBody;
    const signaturePayload = `${timestamp}${credentials.apiKey}${RECV_WINDOW}${signatureParameters}`;
    const signature = createHmac("sha256", credentials.apiSecret).update(signaturePayload).digest("hex");
    const requestId = randomUUID();
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          "X-BAPI-API-KEY": credentials.apiKey,
          "X-BAPI-TIMESTAMP": timestamp,
          "X-BAPI-RECV-WINDOW": RECV_WINDOW,
          "X-BAPI-SIGN": signature,
          "cdn-request-id": requestId,
          ...(jsonBody ? { "Content-Type": "application/json" } : {})
        },
        ...(jsonBody ? { body: jsonBody } : {}),
        signal: AbortSignal.timeout(15_000)
      });
    } catch (error) {
      throw new BybitError(error instanceof Error ? `Bybit connection failed: ${error.message}` : "Bybit connection failed", "BYBIT_UNAVAILABLE", undefined, requestId);
    }
    let payload: unknown;
    try { payload = await response.json(); }
    catch { throw new BybitError(`Bybit returned an unreadable response (${response.status})`, "BYBIT_UNAVAILABLE", undefined, requestId); }
    const envelope = payload as { retCode?: unknown; retMsg?: unknown; result?: T };
    if (response.ok && envelope.retCode === 0 && envelope.result !== undefined) return envelope.result;
    const message = typeof envelope.retMsg === "string" && envelope.retMsg ? envelope.retMsg : `HTTP ${response.status}`;
    const rawRetCode = typeof envelope.retCode === "number" || typeof envelope.retCode === "string" ? envelope.retCode : undefined;
    if (String(rawRetCode) === "10006") {
      const retryAfterHeader = response.headers.get("retry-after");
      const resetHeader = response.headers.get("x-bapi-limit-reset-timestamp");
      const retryAfterSeconds = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
      const resetAt = resetHeader === null ? Number.NaN : Number(resetHeader);
      const retryDelay = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
        ? retryAfterSeconds * 1000
        : Number.isFinite(resetAt) && resetAt > 0 ? Math.max(0, resetAt - Date.now()) : 1000;
      if (attempt === 0 && retryDelay <= MAX_RATE_LIMIT_RETRY_DELAY_MS) {
        await new Promise((resolve) => setTimeout(resolve, Math.max(100, retryDelay + 100)));
        continue;
      }
      throw new BybitError(`Bybit API rate limit exceeded (10006): ${message}`, "BYBIT_RATE_LIMITED", rawRetCode, requestId);
    }
    const retCode = rawRetCode === undefined ? "" : ` (${rawRetCode})`;
    throw new BybitError(`Bybit rejected the request${retCode}: ${message}`, "BYBIT_REJECTED", rawRetCode, requestId);
  }
  throw new BybitError("Bybit API rate limit exceeded", "BYBIT_RATE_LIMITED", 10006);
}

async function validateCredentials(fetchImpl: FetchLike, credentials: Credentials, baseUrl?: string): Promise<void> {
  const result = await signedRequest<{ readOnly?: unknown; permissions?: { BitCard?: unknown } }>(fetchImpl, credentials, "GET", "/v5/user/query-api", { baseUrl });
  if (result.readOnly !== 1) throw new BybitError("Use a read-only Bybit API key", "BYBIT_KEY_NOT_READ_ONLY");
  if (!Array.isArray(result.permissions?.BitCard) || !result.permissions.BitCard.includes("BitCard")) {
    throw new BybitError("The API key does not have the Bybit Card permission", "BYBIT_CARD_PERMISSION_MISSING");
  }
}

function text(value: unknown, max = 200): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function decimalToMinor(value: unknown, currency: string): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const minor = Math.round(amount * 10 ** minorDigits(currency));
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

function amountOf(record: AssetRecord): { amountMinor: number; currency: string } | null {
  const candidates = [
    [record.transactionCurrencyAmount, record.transactionCurrency],
    [record.transactionAmount, record.transactionCurrency],
    [record.basicAmount, record.basicCurrency]
  ] as const;
  for (const [amount, rawCurrency] of candidates) {
    const currency = typeof rawCurrency === "string" ? rawCurrency.toUpperCase() : "";
    if (!isCurrency(currency)) continue;
    const amountMinor = decimalToMinor(amount, currency);
    if (amountMinor) return { amountMinor, currency };
  }
  return null;
}

function transactionKey(record: AssetRecord): string {
  const stable = text(record.txnId) ?? text(record.orderNo);
  if (stable) return `${String(record.side ?? "unknown")}:${stable}`;
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

function reviewableSide(side: string): boolean {
  return side === "3" || side === "7" || side === "13";
}

function storedProviderMetadata(record: AssetRecord): string {
  return JSON.stringify({
    txnId: text(record.txnId),
    orderNo: text(record.orderNo),
    side: String(record.side ?? ""),
    tradeStatus: String(record.tradeStatus ?? ""),
    status: String(record.status ?? "")
  });
}

function transactionJson(row: TransactionRow) {
  return {
    id: row.id,
    txnId: row.txn_id,
    orderNo: row.order_no,
    type: row.side === "13" ? "atm" : "purchase",
    amountMinor: row.amount_minor,
    currency: row.currency,
    merchantName: row.merchant_name,
    merchantCountry: row.merchant_country,
    merchantCity: row.merchant_city,
    mccCode: row.mcc_code,
    merchantCategory: row.merchant_category,
    occurredAt: row.occurred_at,
    reviewStatus: row.review_status,
    expenseId: row.expense_id
  };
}

function connectionStatus(app: FastifyInstance, workspaceId: string) {
  const row = app.db.prepare("SELECT * FROM bybit_card_connections WHERE workspace_id=?").get(workspaceId) as ConnectionRow | undefined;
  if (!row) return { connected: false as const, pendingCount: 0 };
  const pending = app.db.prepare(`SELECT count(*) count FROM bybit_card_transactions
    WHERE workspace_id=? AND review_status='pending' AND trade_status='1' AND provider_status='1'`)
    .get(workspaceId) as { count: number };
  return {
    connected: true as const,
    region: row.region,
    enabledAt: row.enabled_at,
    lastSyncedAt: row.last_synced_at,
    status: row.status,
    lastError: row.last_error,
    pendingCount: pending.count
  };
}

async function fetchRecords(fetchImpl: FetchLike, credentials: Credentials, from: number, to: number, baseUrl?: string): Promise<AssetRecord[]> {
  const records: AssetRecord[] = [];
  let fetched = 0;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const result = await signedRequest<{ pageSize?: unknown; totalCount?: unknown; data?: unknown }>(
      fetchImpl,
      credentials,
      "POST",
      "/v5/card/transaction/query-asset-records",
      { query: { limit: 10, page }, body: {}, baseUrl }
    );
    const data = Array.isArray(result.data) ? result.data as AssetRecord[] : [];
    fetched += data.length;
    records.push(...data.filter((record) => {
      const occurredAt = Number(record.txnCreate);
      return Number.isFinite(occurredAt) && occurredAt >= from && occurredAt <= to
        && String(record.tradeStatus ?? "") === "1" && String(record.status ?? "") === "1";
    }));
    const total = typeof result.totalCount === "number" ? result.totalCount : fetched;
    if (!data.length || fetched >= total || data.length < 10) break;
  }
  return records;
}

export async function syncBybitCard(app: FastifyInstance, workspaceId: string, fetchImpl: FetchLike = fetch): Promise<{ imported: number; pendingCount: number }> {
  const running = syncSet(app);
  if (running.has(workspaceId)) return { imported: 0, pendingCount: connectionStatus(app, workspaceId).pendingCount };
  running.add(workspaceId);
  let connectionId: string | null = null;
  try {
    const connection = app.db.prepare("SELECT * FROM bybit_card_connections WHERE workspace_id=?").get(workspaceId) as ConnectionRow | undefined;
    if (!connection) throw new BybitError("Bybit Card is not connected", "BYBIT_NOT_CONNECTED");
    connectionId = connection.id;
    const enabledAtMs = Date.parse(connection.enabled_at);
    const lastSyncedMs = connection.last_synced_at ? Date.parse(connection.last_synced_at) : enabledAtMs;
    if (connection.last_synced_at && Date.now() - lastSyncedMs < MIN_SYNC_INTERVAL_MS) {
      return { imported: 0, pendingCount: connectionStatus(app, workspaceId).pendingCount };
    }
    const from = Math.max(enabledAtMs, lastSyncedMs - SYNC_OVERLAP_MS);
    const to = Date.now();
    const records = await fetchRecords(fetchImpl, decryptBybitCredentials(app, connection.credentials_encrypted), from, to, app.config.bybitApiBaseUrl);
    const now = new Date(to).toISOString();
    let imported = 0;
    const applied = app.db.transaction(() => {
      const current = app.db.prepare("SELECT id FROM bybit_card_connections WHERE workspace_id=?").get(workspaceId) as { id: string } | undefined;
      if (current?.id !== connection.id) return false;
      const insert = app.db.prepare(`INSERT INTO bybit_card_transactions
        (id,connection_id,workspace_id,external_key,txn_id,order_no,side,trade_status,provider_status,amount_minor,currency,
          merchant_name,merchant_country,merchant_city,mcc_code,merchant_category,occurred_at,review_status,expense_id,raw_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(connection_id,external_key) DO UPDATE SET
          txn_id=excluded.txn_id,order_no=excluded.order_no,side=excluded.side,trade_status=excluded.trade_status,
          provider_status=excluded.provider_status,amount_minor=excluded.amount_minor,currency=excluded.currency,
          merchant_name=excluded.merchant_name,merchant_country=excluded.merchant_country,merchant_city=excluded.merchant_city,
          mcc_code=excluded.mcc_code,merchant_category=excluded.merchant_category,occurred_at=excluded.occurred_at,
          raw_json=excluded.raw_json,updated_at=excluded.updated_at`);
      for (const record of records) {
        const occurredMs = Number(record.txnCreate);
        if (!Number.isFinite(occurredMs) || occurredMs < enabledAtMs) continue;
        const amount = amountOf(record);
        if (!amount) continue;
        const side = String(record.side ?? "");
        const externalKey = transactionKey(record);
        const existed = app.db.prepare("SELECT 1 FROM bybit_card_transactions WHERE connection_id=? AND external_key=?")
          .get(connection.id, externalKey);
        insert.run(
          randomUUID(), connection.id, workspaceId, externalKey, text(record.txnId), text(record.orderNo), side,
          String(record.tradeStatus ?? ""), String(record.status ?? ""), amount.amountMinor, amount.currency,
          text(record.merchName), text(record.merchCountry, 10), text(record.merchCity), text(record.mccCode, 10),
          text(record.merchCategoryDesc), new Date(occurredMs).toISOString(), reviewableSide(side) ? "pending" : "ignored",
          null, storedProviderMetadata(record), now, now
        );
        if (!existed && reviewableSide(side)) imported += 1;
      }
      app.db.prepare(`UPDATE bybit_card_connections SET last_synced_at=?,status='active',last_error=NULL,updated_at=? WHERE id=?`)
        .run(now, now, connection.id);
      return true;
    })();
    if (!applied) return { imported: 0, pendingCount: connectionStatus(app, workspaceId).pendingCount };
    return { imported, pendingCount: connectionStatus(app, workspaceId).pendingCount };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "Bybit synchronization failed";
    if (connectionId) app.db.prepare(`UPDATE bybit_card_connections SET status='error',last_error=?,updated_at=? WHERE id=?`)
      .run(message, new Date().toISOString(), connectionId);
    throw error;
  } finally {
    running.delete(workspaceId);
  }
}

export async function registerBybitCardRoutes(app: FastifyInstance, options: { fetch?: FetchLike } = {}): Promise<void> {
  const fetchImpl = options.fetch ?? fetch;
  const prefix = "/api/workspaces/:workspaceId/integrations/bybit-card";
  const mutation = (request: FastifyRequest, reply: FastifyReply) => requireMutationOrigin(app, request, reply);

  app.get(prefix, { preHandler: app.requireWorkspaceMember, onSend: noStore }, async (request) => ({
    ...connectionStatus(app, workspaceContext(request).workspaceId),
    canManage: Boolean(request.workspaceAccess?.owner)
  }));

  app.post(prefix, { preHandler: [app.requireWorkspaceMember, mutation], onSend: noStore }, async (request, reply) => {
    if (!request.workspaceAccess?.owner || !request.auth) return fail(reply, 403, "FORBIDDEN", "Only the workspace owner can connect Bybit Card");
    const body = request.body as { apiKey?: unknown; apiSecret?: unknown; region?: unknown };
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    const apiSecret = typeof body.apiSecret === "string" ? body.apiSecret.trim() : "";
    const region = typeof body.region === "string" && body.region in BYBIT_REGIONS ? body.region as BybitRegion : null;
    if (!apiKey || apiKey.length > 256 || !apiSecret || apiSecret.length > 512 || !region) {
      return fail(reply, 400, "VALIDATION", "Valid API key, secret and region are required");
    }
    const enabledAt = new Date().toISOString();
    const credentials = { apiKey, apiSecret, region };
    try { await validateCredentials(fetchImpl, credentials, app.config.bybitApiBaseUrl); }
    catch (error) {
      const bybit = error instanceof BybitError ? error : new BybitError("Could not validate the Bybit key");
      return fail(reply, bybit.code === "BYBIT_RATE_LIMITED" ? 429 : 422, bybit.code, bybit.message);
    }
    const id = randomUUID();
    const saved = app.db.transaction(() => {
      const owner = app.db.prepare("SELECT 1 FROM workspaces WHERE id=? AND owner_user_id=?").get(request.workspaceAccess!.workspaceId, request.auth!.userId);
      if (!owner) return false;
      app.db.prepare("DELETE FROM bybit_card_connections WHERE workspace_id=?").run(request.workspaceAccess!.workspaceId);
      app.db.prepare(`INSERT INTO bybit_card_connections
        (id,workspace_id,connected_by_user_id,credentials_encrypted,region,enabled_at,last_synced_at,status,last_error,created_at,updated_at)
        VALUES (?,?,?,?,?,?,NULL,'active',NULL,?,?)`)
        .run(id, request.workspaceAccess!.workspaceId, request.auth!.userId, encryptBybitCredentials(app, credentials), region, enabledAt, enabledAt, enabledAt);
      return true;
    })();
    if (!saved) return fail(reply, 403, "FORBIDDEN", "Only the workspace owner can connect Bybit Card");
    try { await syncBybitCard(app, request.workspaceAccess.workspaceId, fetchImpl); }
    catch (error) {
      request.log.warn({ err: error, workspaceId: request.workspaceAccess.workspaceId }, "Initial Bybit Card sync failed");
      /* The verified connection stays enabled and exposes its sync error in status. */
    }
    return reply.code(201).send({ ...connectionStatus(app, request.workspaceAccess.workspaceId), canManage: true });
  });

  app.delete(prefix, { preHandler: [app.requireWorkspaceMember, mutation], onSend: noStore }, async (request, reply) => {
    if (!request.workspaceAccess?.owner || !request.auth) return fail(reply, 403, "FORBIDDEN", "Only the workspace owner can disconnect Bybit Card");
    const removed = app.db.transaction(() => {
      const owner = app.db.prepare("SELECT 1 FROM workspaces WHERE id=? AND owner_user_id=?").get(request.workspaceAccess!.workspaceId, request.auth!.userId);
      if (!owner) return 0;
      return app.db.prepare("DELETE FROM bybit_card_connections WHERE workspace_id=?").run(request.workspaceAccess!.workspaceId).changes;
    })();
    return removed ? reply.code(204).send() : fail(reply, 404, "BYBIT_NOT_CONNECTED", "Bybit Card is not connected");
  });

  app.post(`${prefix}/sync`, { preHandler: [app.requireWorkspaceMember, mutation], onSend: noStore }, async (request, reply) => {
    const { workspaceId } = workspaceContext(request);
    try { return { ...(await syncBybitCard(app, workspaceId, fetchImpl)), ...connectionStatus(app, workspaceId) }; }
    catch (error) {
      request.log.warn({ err: error, workspaceId }, "Manual Bybit Card sync failed");
      const bybit = error instanceof BybitError ? error : new BybitError("Could not synchronize Bybit Card");
      const status = bybit.code === "BYBIT_NOT_CONNECTED" ? 404 : bybit.code === "BYBIT_RATE_LIMITED" ? 429 : 502;
      return fail(reply, status, bybit.code, bybit.message);
    }
  });

  app.get(`${prefix}/transactions`, { preHandler: app.requireWorkspaceMember, onSend: noStore }, async (request, reply) => {
    const { workspaceId } = workspaceContext(request);
    const requestedLimit = Number((request.query as { limit?: string }).limit ?? 100);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) return fail(reply, 400, "VALIDATION", "limit must be a positive integer");
    const rows = app.db.prepare(`SELECT * FROM bybit_card_transactions
      WHERE workspace_id=? AND review_status='pending' AND trade_status='1' AND provider_status='1'
      ORDER BY occurred_at,id LIMIT ?`).all(workspaceId, Math.min(200, requestedLimit)) as TransactionRow[];
    return { transactions: rows.map(transactionJson), pendingCount: connectionStatus(app, workspaceId).pendingCount };
  });

  app.post(`${prefix}/transactions/:transactionId/classify`, { preHandler: [app.requireWorkspaceMember, mutation], onSend: noStore }, async (request, reply) => {
    const { workspaceId, userId } = workspaceContext(request);
    const transactionId = (request.params as { transactionId: string }).transactionId;
    const body = request.body as { categoryId?: unknown; comment?: unknown; tagIds?: unknown };
    const categoryId = typeof body.categoryId === "string" ? body.categoryId : "";
    const comment = typeof body.comment === "string" ? body.comment.trim().slice(0, 300) : "";
    if (!categoryId) return fail(reply, 400, "VALIDATION", "categoryId is required");
    if (body.tagIds !== undefined && (!Array.isArray(body.tagIds) || body.tagIds.some((item) => typeof item !== "string"))) return fail(reply, 400, "VALIDATION", "tagIds must be an array of tag ids");
    const tagIds = (body.tagIds as string[] | undefined) ?? [];
    const outcome = app.db.transaction(() => {
      if (!hasWorkspaceMembership(app, workspaceId, userId)) return { kind: "missing" as const };
      const row = app.db.prepare("SELECT * FROM bybit_card_transactions WHERE workspace_id=? AND id=?")
        .get(workspaceId, transactionId) as TransactionRow | undefined;
      if (!row) return { kind: "missing" as const };
      if (row.review_status === "classified" && row.expense_id) {
        const expense = app.db.prepare(`${EXPENSE_SELECT} WHERE e.workspace_id=? AND e.id=?`).get(workspaceId, row.expense_id) as ExpenseRow | undefined;
        return expense ? { kind: "classified" as const, row, expense: expenseJson(expense) } : { kind: "reviewed" as const };
      }
      if (row.review_status !== "pending") return { kind: "reviewed" as const };
      const note = [row.merchant_name, comment].filter((part, index, parts) => part && parts.indexOf(part) === index).join(" · ").slice(0, 500) || null;
      const created = createExpense(app, workspaceId, {
        id: randomUUID(), amountMinor: row.amount_minor, currency: row.currency, categoryId,
        occurredAt: row.occurred_at, note, tagIds
      });
      if ("error" in created) return { kind: "expense-error" as const, error: created.error, code: created.code };
      app.db.prepare(`UPDATE bybit_card_transactions SET review_status='classified',expense_id=?,updated_at=? WHERE workspace_id=? AND id=?`)
        .run(created.expense.id, new Date().toISOString(), workspaceId, transactionId);
      return { kind: "classified" as const, row: { ...row, review_status: "classified", expense_id: created.expense.id } as TransactionRow, expense: created.expense };
    })();
    if (outcome.kind === "missing") return fail(reply, 404, "NOT_FOUND", "Imported transaction not found");
    if (outcome.kind === "reviewed") return fail(reply, 409, "ALREADY_REVIEWED", "Imported transaction was already reviewed");
    if (outcome.kind === "expense-error") return fail(reply, 400, outcome.code ?? "VALIDATION", outcome.error);
    return { transaction: transactionJson(outcome.row), expense: outcome.expense, pendingCount: connectionStatus(app, workspaceId).pendingCount };
  });

  app.post(`${prefix}/transactions/:transactionId/ignore`, { preHandler: [app.requireWorkspaceMember, mutation], onSend: noStore }, async (request, reply) => {
    const { workspaceId, userId } = workspaceContext(request);
    const transactionId = (request.params as { transactionId: string }).transactionId;
    const changed = app.db.transaction(() => {
      if (!hasWorkspaceMembership(app, workspaceId, userId)) return 0;
      return app.db.prepare(`UPDATE bybit_card_transactions SET review_status='ignored',updated_at=?
        WHERE workspace_id=? AND id=? AND review_status='pending'`).run(new Date().toISOString(), workspaceId, transactionId).changes;
    })();
    if (!changed) return fail(reply, 404, "NOT_FOUND", "Pending imported transaction not found");
    return { pendingCount: connectionStatus(app, workspaceId).pendingCount };
  });

  app.post(`${prefix}/transactions/:transactionId/undo`, { preHandler: [app.requireWorkspaceMember, mutation], onSend: noStore }, async (request, reply) => {
    const { workspaceId, userId } = workspaceContext(request);
    const transactionId = (request.params as { transactionId: string }).transactionId;
    const body = (request.body ?? {}) as { expenseId?: unknown; expenseVersion?: unknown };
    const outcome = app.db.transaction(() => {
      if (!hasWorkspaceMembership(app, workspaceId, userId)) return { kind: "missing" as const };
      const row = app.db.prepare("SELECT * FROM bybit_card_transactions WHERE workspace_id=? AND id=?")
        .get(workspaceId, transactionId) as TransactionRow | undefined;
      if (!row) return { kind: "missing" as const };
      if (row.review_status === "pending") return { kind: "undone" as const, row, expenseId: null };
      if (row.review_status === "classified") {
        if (typeof body.expenseId !== "string" || !Number.isInteger(body.expenseVersion) || body.expenseId !== row.expense_id) {
          return { kind: "conflict" as const };
        }
        const removed = deleteExpense(app, workspaceId, body.expenseId, body.expenseVersion as number);
        if (removed.error) return { kind: "conflict" as const };
        app.db.prepare(`UPDATE bybit_card_transactions SET review_status='pending',expense_id=NULL,updated_at=?
          WHERE workspace_id=? AND id=? AND review_status='classified' AND expense_id=?`)
          .run(new Date().toISOString(), workspaceId, transactionId, body.expenseId);
        return { kind: "undone" as const, row: { ...row, review_status: "pending", expense_id: null } as TransactionRow, expenseId: body.expenseId };
      }
      app.db.prepare(`UPDATE bybit_card_transactions SET review_status='pending',updated_at=?
        WHERE workspace_id=? AND id=? AND review_status='ignored'`)
        .run(new Date().toISOString(), workspaceId, transactionId);
      return { kind: "undone" as const, row: { ...row, review_status: "pending" } as TransactionRow, expenseId: null };
    })();
    if (outcome.kind === "missing") return fail(reply, 404, "NOT_FOUND", "Imported transaction not found");
    if (outcome.kind === "conflict") return fail(reply, 409, "UNDO_CONFLICT", "The created expense was already changed and cannot be undone here");
    return { transaction: transactionJson(outcome.row), undoneExpenseId: outcome.expenseId, pendingCount: connectionStatus(app, workspaceId).pendingCount };
  });
}

export function startBybitCardScheduler(app: FastifyInstance): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const run = async () => {
    const rows = app.db.prepare("SELECT workspace_id FROM bybit_card_connections").all() as Array<{ workspace_id: string }>;
    for (const row of rows) {
      if (stopped) break;
      try { await syncBybitCard(app, row.workspace_id); }
      catch (error) { app.log.warn({ err: error, workspaceId: row.workspace_id }, "Scheduled Bybit Card sync failed"); }
    }
    if (!stopped) {
      timer = setTimeout(run, SYNC_INTERVAL_MS);
      timer.unref();
    }
  };
  timer = setTimeout(run, SCHEDULER_INITIAL_DELAY_MS);
  timer.unref();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
