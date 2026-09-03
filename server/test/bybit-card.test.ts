import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { registerBybitCardRoutes } from "../src/bybit-card.js";
import { buildTestApp, testConfig } from "./test-app.js";

const config = testConfig();
const assetRequests: Array<Record<string, unknown>> = [];
const assetRequestIds: string[] = [];
let validationTime = 0;
let rateLimited = false;

function payment(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    pan4: "4242", tradeStatus: "1", status: "1", side: "1", declinedReason: "0",
    basicCurrency: "USD", transactionCurrency: "USD", paidCurrency: "RSD", totalFees: "0.17000000",
    ...overrides
  };
}

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
  assert.equal(requestUrl.search, "", "asset-record parameters must travel in the JSON body, not the query string");
  assert.equal(headers["Content-Type"], "application/json");
  const assetRequest = JSON.parse(requestBody) as Record<string, unknown>;
  assetRequests.push(assetRequest);
  assetRequestIds.push(headers["cdn-request-id"]!);
  if (assetRequest.type !== "SIDE_QUERY_AUTH" || Number(assetRequest.limit) > 100) {
    return new Response(JSON.stringify({ retCode: 120110001, retMsg: "param_illegal", result: {} }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (!rateLimited) {
    rateLimited = true;
    return new Response(JSON.stringify({ retCode: 10006, retMsg: "Too many visits. Exceeded the API Rate Limit.", result: {} }), {
      status: 200,
      headers: { "content-type": "application/json", "X-Bapi-Limit-Reset-Timestamp": String(Date.now()) }
    });
  }
  const boundary = validationTime;
  const data = [
    payment({
      basicAmount: "19.250000000000000000", transactionAmount: "18.870000000000000000", transactionCurrencyAmount: "19.2500000000",
      paidAmount: "1925.000000000000000000", txnCreate: String(boundary - 60_000), merchName: "Old merchant", merchCountry: "SRB",
      txnId: "old", orderNo: "old-order", mccCode: "5411"
    }),
    payment({
      basicAmount: "12.460000000000000000", transactionAmount: "12.220000000000000000", transactionCurrencyAmount: "12.4600000000",
      paidAmount: "1234.000000000000000000", txnCreate: String(boundary + 1), merchName: "WOLT", merchCity: "Belgrade", merchCountry: "SRB",
      txnId: "new", orderNo: "new-order", mccCode: "5812", merchCategoryDesc: "Eating Places"
    }),
    payment({
      tradeStatus: "0", basicAmount: "5.000000000000000000", transactionAmount: "4.900000000000000000", transactionCurrencyAmount: "5.0000000000",
      paidAmount: "500.000000000000000000", txnCreate: String(boundary + 2), merchName: "Pending", merchCountry: "SRB", txnId: "pending", mccCode: "5411"
    }),
    payment({
      tradeStatus: "2", status: "2", declinedReason: "51", basicAmount: "3.000000000000000000", transactionAmount: "2.940000000000000000",
      transactionCurrencyAmount: "3.0000000000", paidAmount: "300.000000000000000000", txnCreate: String(boundary + 3), merchName: "Declined",
      merchCountry: "SRB", txnId: "declined", mccCode: "5411"
    })
  ];
  return new Response(JSON.stringify({ retCode: 0, retMsg: "success", result: { pageSize: 100, pageNo: 1, totalCount: data.length, data } }), {
    status: 200, headers: { "content-type": "application/json" }
  });
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
  assert.equal(assetRequests.length, 2, "the rate-limited first attempt is retried once");
  for (const assetRequest of assetRequests) {
    assert.equal(assetRequest.type, "SIDE_QUERY_AUTH");
    assert.equal(assetRequest.limit, 100);
    assert.equal(assetRequest.page, 1);
    assert.equal(assetRequest.createBeginTime, Date.parse(connected.json().enabledAt));
    assert.equal(typeof assetRequest.createEndTime, "number");
    assert.ok((assetRequest.createEndTime as number) >= (assetRequest.createBeginTime as number));
  }
  assert.equal(new Set(assetRequestIds).size, 2);

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
  assert.equal(assetRequests.length, 2, "a repeated sync inside the cooldown must not call Bybit");

  const queue = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/integrations/bybit-card/transactions`, headers: contextHeaders() });
  assert.equal(queue.statusCode, 200, queue.body);
  assert.equal(queue.json().transactions.length, 1);
  assert.equal(queue.json().transactions[0].merchantName, "WOLT");
  assert.equal(queue.json().transactions[0].amountMinor, 123400, "the amount actually paid (RSD) is imported, not the card-currency total");
  assert.equal(queue.json().transactions[0].currency, "RSD");
  assert.equal(queue.json().transactions[0].type, "purchase");
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
  assert.equal(first.json().expense.amountMinor, 123400);
  assert.equal(first.json().expense.currency, "RSD");
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
