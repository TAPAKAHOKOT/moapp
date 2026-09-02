import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { registerBybitCardRoutes } from "../src/bybit-card.js";
import { buildTestApp, testConfig } from "./test-app.js";

const config = testConfig();
const assetRequests: Array<Record<string, string>> = [];
const assetRequestIds: string[] = [];
let validationTime = 0;
let rateLimited = false;

const mockFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  assert.equal(init?.headers instanceof Headers, false);
  const headers = init?.headers as Record<string, string>;
  assert.equal(headers["X-BAPI-API-KEY"], "read-only-card-key");
  assert.equal(headers["X-BAPI-RECV-WINDOW"], "5000");
  assert.match(headers["cdn-request-id"], /^[0-9a-f-]{36}$/);
  const requestBody = String(init?.body ?? "");
  const signaturePayload = `${headers["X-BAPI-TIMESTAMP"]}read-only-card-key5000${init?.method === "POST" ? requestBody : ""}`;
  assert.equal(headers["X-BAPI-SIGN"], createHmac("sha256", "super-secret").update(signaturePayload).digest("hex"));
  if (url.endsWith("/v5/user/query-api")) {
    assert.equal(init?.method, "GET");
    assert.equal(requestBody, "");
    assert.equal(headers["Content-Type"], undefined);
    validationTime = Date.now();
    return new Response(JSON.stringify({ retCode: 0, retMsg: "OK", result: { readOnly: 1, permissions: { BitCard: ["BitCard"] } } }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  }
  const requestUrl = new URL(url);
  assert.equal(init?.method, "POST");
  assert.equal(requestUrl.pathname, "/v5/card/transaction/query-asset-records");
  assert.equal(requestBody, "{}");
  assert.equal(headers["Content-Type"], "application/json");
  const assetRequest = Object.fromEntries(requestUrl.searchParams);
  assetRequests.push(assetRequest);
  assetRequestIds.push(headers["cdn-request-id"]!);
  if (requestUrl.searchParams.has("statusCode")) {
    return new Response(JSON.stringify({ retCode: 120110001, retMsg: "param_illegal", result: {} }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  }
  if (!rateLimited) {
    rateLimited = true;
    return new Response(JSON.stringify({ retCode: 10006, retMsg: "Too many visits. Exceeded the API Rate Limit.", result: {} }), {
      status: 200,
      headers: { "content-type": "application/json", "X-Bapi-Limit-Reset-Timestamp": String(Date.now()) }
    });
  }
  const boundary = validationTime;
  return new Response(JSON.stringify({
    retCode: 0,
    retMsg: "OK",
    result: {
      pageSize: 2,
      totalCount: 2,
      data: [
        {
          tradeStatus: "1", status: "1", side: "3", transactionCurrencyAmount: "19.25", transactionCurrency: "EUR",
          txnCreate: boundary - 60_000, merchName: "Old merchant", txnId: "old", orderNo: "old-order", mccCode: "5411"
        },
        {
          tradeStatus: "1", status: "1", side: "3", transactionCurrencyAmount: "12.34", transactionCurrency: "EUR",
          txnCreate: boundary + 1, merchName: "WOLT", merchCity: "Belgrade", merchCountry: "RS", txnId: "new",
          orderNo: "new-order", mccCode: "5812", merchCategoryDesc: "Eating Places"
        }
      ]
    }
  }), { status: 200, headers: { "content-type": "application/json" } });
};

const app = await buildTestApp({ config, plugins: [(instance) => registerBybitCardRoutes(instance, { fetch: mockFetch })] });
const origin = { origin: config.appOrigin };
let cookie = "";
let userId = "";
let sessionId = "";
let workspaceId = "";

function contextHeaders() {
  return { cookie, "x-moapp-expected-user-id": userId, "x-moapp-expected-session-id": sessionId };
}

before(async () => {
  const identity = await app.inject({ method: "POST", url: "/api/identity", headers: origin, payload: { displayName: "Owner" } });
  assert.equal(identity.statusCode, 201, identity.body);
  const session = identity.json();
  userId = session.user.id;
  sessionId = session.currentSessionId;
  cookie = String(identity.headers["set-cookie"]).split(";", 1)[0]!;
  workspaceId = randomUUID();
  const workspace = await app.inject({
    method: "POST", url: "/api/workspaces", headers: { ...origin, ...contextHeaders() }, payload: { id: workspaceId, name: "Home" }
  });
  assert.equal(workspace.statusCode, 201, workspace.body);
});

after(async () => app.close());

test("Bybit Card imports only records at or after the exact connection boundary", async () => {
  const connected = await app.inject({
    method: "POST",
    url: `/api/workspaces/${workspaceId}/integrations/bybit-card`,
    headers: { ...origin, ...contextHeaders() },
    payload: { apiKey: "read-only-card-key", apiSecret: "super-secret", region: "global" }
  });
  assert.equal(connected.statusCode, 201, connected.body);
  assert.equal(connected.json().connected, true);
  assert.equal(connected.json().pendingCount, 1);
  assert.deepEqual(assetRequests.map(({ type, statusCode, limit, page }) => ({ type, statusCode, limit, page })), [
    { type: "SIDE_QUERY_FINANCIAL", statusCode: "1", limit: "500", page: "1" },
    { type: "SIDE_QUERY_FINANCIAL", statusCode: undefined, limit: "500", page: "1" },
    { type: "SIDE_QUERY_FINANCIAL", statusCode: undefined, limit: "500", page: "1" }
  ]);
  assert.equal(new Set(assetRequestIds).size, 3);
  assert.equal(Number(assetRequests[0]?.createBeginTime), Date.parse(connected.json().enabledAt));
  assert.ok(Number(assetRequests[0]?.createEndTime) >= Number(assetRequests[0]?.createBeginTime));

  const storedConnection = app.db.prepare("SELECT * FROM bybit_card_connections WHERE workspace_id=?").get(workspaceId) as { credentials_encrypted: string };
  assert.doesNotMatch(storedConnection.credentials_encrypted, /read-only-card-key|super-secret/);
  assert.equal((app.db.prepare("SELECT count(*) count FROM bybit_card_transactions WHERE workspace_id=?").get(workspaceId) as { count: number }).count, 1);

  const repeatedSync = await app.inject({
    method: "POST",
    url: `/api/workspaces/${workspaceId}/integrations/bybit-card/sync`,
    headers: { ...origin, ...contextHeaders() },
    payload: {}
  });
  assert.equal(repeatedSync.statusCode, 200, repeatedSync.body);
  assert.equal(assetRequests.length, 3, "a repeated sync inside the cooldown must not call Bybit");

  const queue = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/integrations/bybit-card/transactions`, headers: contextHeaders() });
  assert.equal(queue.statusCode, 200, queue.body);
  assert.equal(queue.json().transactions.length, 1);
  assert.equal(queue.json().transactions[0].merchantName, "WOLT");
  assert.equal(queue.json().transactions[0].amountMinor, 1234);
});

test("review actions can be safely undone and disconnect keeps the final expense", async () => {
  const row = app.db.prepare("SELECT id FROM bybit_card_transactions WHERE workspace_id=?").get(workspaceId) as { id: string };
  const classify = async () => app.inject({
    method: "POST",
    url: `/api/workspaces/${workspaceId}/integrations/bybit-card/transactions/${row.id}/classify`,
    headers: { ...origin, ...contextHeaders() },
    payload: { categoryId: "eating-out", comment: "Dinner" }
  });
  const first = await classify();
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().pendingCount, 0);
  assert.equal(first.json().expense.amountMinor, 1234);
  assert.equal(first.json().expense.note, "WOLT · Dinner");
  const replay = await classify();
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().expense.id, first.json().expense.id);
  assert.equal((app.db.prepare("SELECT count(*) count FROM expenses WHERE workspace_id=?").get(workspaceId) as { count: number }).count, 1);

  const undo = async (payload: Record<string, unknown>) => app.inject({
    method: "POST",
    url: `/api/workspaces/${workspaceId}/integrations/bybit-card/transactions/${row.id}/undo`,
    headers: { ...origin, ...contextHeaders() },
    payload
  });
  const staleUndo = await undo({ expenseId: first.json().expense.id, expenseVersion: first.json().expense.version + 1 });
  assert.equal(staleUndo.statusCode, 409, staleUndo.body);
  assert.equal(staleUndo.json().error.code, "UNDO_CONFLICT");

  const undoneClassification = await undo({ expenseId: first.json().expense.id, expenseVersion: first.json().expense.version });
  assert.equal(undoneClassification.statusCode, 200, undoneClassification.body);
  assert.equal(undoneClassification.json().pendingCount, 1);
  assert.equal(undoneClassification.json().transaction.reviewStatus, "pending");
  assert.equal((app.db.prepare("SELECT count(*) count FROM expenses WHERE workspace_id=? AND deleted_at IS NULL").get(workspaceId) as { count: number }).count, 0);

  const ignored = await app.inject({
    method: "POST",
    url: `/api/workspaces/${workspaceId}/integrations/bybit-card/transactions/${row.id}/ignore`,
    headers: { ...origin, ...contextHeaders() },
    payload: {}
  });
  assert.equal(ignored.statusCode, 200, ignored.body);
  assert.equal(ignored.json().pendingCount, 0);
  const undoneIgnore = await undo({});
  assert.equal(undoneIgnore.statusCode, 200, undoneIgnore.body);
  assert.equal(undoneIgnore.json().pendingCount, 1);

  const finalClassification = await classify();
  assert.equal(finalClassification.statusCode, 200, finalClassification.body);
  assert.notEqual(finalClassification.json().expense.id, first.json().expense.id);

  const disconnected = await app.inject({
    method: "DELETE", url: `/api/workspaces/${workspaceId}/integrations/bybit-card`, headers: { ...origin, ...contextHeaders() }, payload: {}
  });
  assert.equal(disconnected.statusCode, 204, disconnected.body);
  assert.equal((app.db.prepare("SELECT count(*) count FROM bybit_card_transactions WHERE workspace_id=?").get(workspaceId) as { count: number }).count, 0);
  assert.equal((app.db.prepare("SELECT count(*) count FROM expenses WHERE workspace_id=? AND deleted_at IS NULL").get(workspaceId) as { count: number }).count, 1);
});
