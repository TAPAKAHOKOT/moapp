import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { registerBybitCardRoutes } from "../src/bybit-card.js";
import { registerTenantDomainRoutes } from "../src/tenant-domain.js";
import { buildTestApp, testConfig } from "./test-app.js";

const config = testConfig();
const assetRequests: Array<Record<string, unknown>> = [];
const assetRequestIds: string[] = [];
let validationTime = 0;
let rateLimited = false;
let phase = 1;

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
  /* Records are placed relative to the requested window: the mocked fetch answers within the same
     millisecond, so anything "after" createEndTime would be legitimately outside the sync window. */
  const begin = Number(assetRequest.createBeginTime);
  const end = Number(assetRequest.createEndTime);
  const at = (offset: number) => String(Math.min(begin + offset, end));
  const data = [
    payment({
      basicAmount: "19.250000000000000000", transactionAmount: "18.870000000000000000", transactionCurrencyAmount: "19.2500000000",
      paidAmount: "1925.000000000000000000", txnCreate: String(begin - 60_000), merchName: "Old merchant", merchCountry: "SRB",
      txnId: "old", orderNo: "old-order", mccCode: "5411"
    }),
    payment({
      basicAmount: "12.460000000000000000", transactionAmount: "12.220000000000000000", transactionCurrencyAmount: "12.4600000000",
      paidAmount: "1234.000000000000000000", txnCreate: at(1), merchName: "WOLT", merchCity: "Belgrade", merchCountry: "SRB",
      txnId: "new", orderNo: "new-order", mccCode: "5812", merchCategoryDesc: "Eating Places"
    }),
    /* An open authorization: reviewable immediately, settled in phase 2 with a slightly different amount. */
    payment({
      tradeStatus: phase === 1 ? "0" : "1", basicAmount: "5.000000000000000000", transactionAmount: "4.900000000000000000", transactionCurrencyAmount: "5.0000000000",
      paidAmount: phase === 1 ? "500.000000000000000000" : "550.000000000000000000", txnCreate: at(2), merchName: "Pending", merchCountry: "SRB", txnId: "pending", mccCode: "5411"
    }),
    /* An open authorization that Bybit reverses in phase 2: it must leave the review queue. */
    payment({
      tradeStatus: phase === 1 ? "0" : "3", basicAmount: "9.000000000000000000", transactionAmount: "8.820000000000000000", transactionCurrencyAmount: "9.0000000000",
      paidAmount: "900.000000000000000000", txnCreate: at(3), merchName: "Reversed", merchCountry: "SRB", txnId: "reversed", mccCode: "5411"
    }),
    payment({
      tradeStatus: "2", status: "2", declinedReason: "51", basicAmount: "3.000000000000000000", transactionAmount: "2.940000000000000000",
      transactionCurrencyAmount: "3.0000000000", paidAmount: "300.000000000000000000", txnCreate: at(4), merchName: "Declined",
      merchCountry: "SRB", txnId: "declined", mccCode: "5411"
    })
  ];
  return new Response(JSON.stringify({ retCode: 0, retMsg: "success", result: { pageSize: 100, pageNo: 1, totalCount: data.length, data } }), {
    status: 200, headers: { "content-type": "application/json" }
  });
};

const app = await buildTestApp({ config, plugins: [registerTenantDomainRoutes, (instance) => registerBybitCardRoutes(instance, { fetch: mockFetch })] });
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
  /* Analytics loads rates for the requested day; seed them so the test never reaches the network. */
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  app.db.prepare("INSERT INTO exchange_rates(rate_date,base_currency,quote_currency,rate,fetched_at) VALUES (?,'EUR','RSD',117,?)").run(today, now);
  app.db.prepare("INSERT INTO exchange_rates(rate_date,base_currency,quote_currency,rate,fetched_at) VALUES (?,'EUR','EUR',1,?)").run(today, now);
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
  assert.equal(connected.json().pendingCount, 3, "one settled payment plus two open authorizations are reviewable");
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
  assert.equal((app.db.prepare("SELECT count(*) count FROM bybit_card_transactions WHERE workspace_id=?").get(workspaceId) as { count: number }).count, 3, "declined and pre-boundary records are never stored");

  const repeatedSync = await app.inject({
    method: "POST",
    url: `/api/workspaces/${workspaceId}/integrations/bybit-card/sync`,
    headers: { ...origin, ...contextHeaders() },
    payload: {}
  });
  assert.equal(repeatedSync.statusCode, 200, repeatedSync.body);
  assert.equal(assetRequests.length, 2, "a repeated sync inside the cooldown must not call Bybit");
  assert.equal(repeatedSync.json().throttled, true, "the response says why nothing was fetched so the UI can explain it");

  const queue = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/integrations/bybit-card/transactions`, headers: contextHeaders() });
  assert.equal(queue.statusCode, 200, queue.body);
  const byName = (items: Array<{ merchantName: string }>) => [...items].sort((a, b) => a.merchantName.localeCompare(b.merchantName));
  const imported = byName(queue.json().transactions) as Array<{ merchantName: string; settled: boolean; amountMinor: number; currency: string; type: string }>;
  assert.deepEqual(imported.map((item) => [item.merchantName, item.settled, item.amountMinor]), [["Pending", false, 50000], ["Reversed", false, 90000], ["WOLT", true, 123400]]);
  assert.equal(imported[2]!.currency, "RSD", "the amount actually paid (RSD) is imported, not the card-currency total");
  assert.equal(imported[2]!.type, "purchase");
});

test("a later sync settles open authorizations and drops reversed ones from review", async () => {
  /* The reversed authorization was already classified: its expense must be voided, not deleted. */
  const reversedRow = app.db.prepare("SELECT id FROM bybit_card_transactions WHERE workspace_id=? AND merchant_name='Reversed'").get(workspaceId) as { id: string };
  const classified = await app.inject({
    method: "POST",
    url: `/api/workspaces/${workspaceId}/integrations/bybit-card/transactions/${reversedRow.id}/classify`,
    headers: { ...origin, ...contextHeaders() },
    payload: { categoryId: "eating-out", comment: "Lunch" }
  });
  assert.equal(classified.statusCode, 200, classified.body);
  const reversedExpense = classified.json().expense as { id: string; version: number };

  phase = 2;
  app.db.prepare("UPDATE bybit_card_connections SET last_synced_at=? WHERE workspace_id=?").run(new Date(Date.now() - 10 * 60_000).toISOString(), workspaceId);
  const requestsBefore = assetRequests.length;
  const sync = await app.inject({
    method: "POST",
    url: `/api/workspaces/${workspaceId}/integrations/bybit-card/sync`,
    headers: { ...origin, ...contextHeaders() },
    payload: {}
  });
  assert.equal(sync.statusCode, 200, sync.body);
  assert.equal(assetRequests.length, requestsBefore + 1);
  assert.ok((assetRequests.at(-1)!.createBeginTime as number) <= Date.parse((app.db.prepare("SELECT min(occurred_at) occurred_at FROM bybit_card_transactions WHERE workspace_id=? AND merchant_name='Pending'").get(workspaceId) as { occurred_at: string }).occurred_at),
    "the window reaches back to the oldest open authorization even after the overlap would have passed");
  assert.equal(sync.json().imported, 0, "settling an already imported authorization is not a new import");
  assert.equal(sync.json().pendingCount, 2);

  const queue = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/integrations/bybit-card/transactions`, headers: contextHeaders() });
  const settled = [...(queue.json().transactions as Array<{ merchantName: string; settled: boolean; amountMinor: number }>)].sort((a, b) => a.merchantName.localeCompare(b.merchantName));
  assert.deepEqual(settled.map((item) => [item.merchantName, item.settled, item.amountMinor]), [["Pending", true, 55000], ["WOLT", true, 123400]]);
  const reversed = app.db.prepare("SELECT review_status, trade_status, expense_id FROM bybit_card_transactions WHERE workspace_id=? AND merchant_name='Reversed'").get(workspaceId) as { review_status: string; trade_status: string; expense_id: string };
  assert.deepEqual(reversed, { review_status: "classified", trade_status: "3", expense_id: reversedExpense.id }, "a classified operation keeps its link; only pending ones are ignored");

  const voided = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/expenses/${reversedExpense.id}`, headers: contextHeaders() });
  assert.equal(voided.statusCode, 200, voided.body);
  assert.equal(voided.json().deletedAt, null);
  assert.ok(voided.json().voidedAt, "the linked expense is marked as declined by the provider");
  assert.equal(voided.json().version, reversedExpense.version + 1);
  assert.deepEqual(voided.json().voidReason, { provider: "bybit-card", kind: "reversed", txnId: "reversed", merchantName: "Reversed", amountMinor: 90000, currency: "RSD" });

  const day = new Date().toISOString().slice(0, 10);
  const analytics = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/analytics?from=${day}&to=${day}&currency=RSD`, headers: contextHeaders() });
  assert.equal(analytics.statusCode, 200, analytics.body);
  assert.equal(analytics.json().totalMinor, 0, "a voided expense is excluded from analytics");

  const stale = await app.inject({
    method: "POST", url: `/api/workspaces/${workspaceId}/expenses/${reversedExpense.id}/include`,
    headers: { ...origin, ...contextHeaders() }, payload: { version: reversedExpense.version }
  });
  assert.equal(stale.statusCode, 409, stale.body);
  const included = await app.inject({
    method: "POST", url: `/api/workspaces/${workspaceId}/expenses/${reversedExpense.id}/include`,
    headers: { ...origin, ...contextHeaders() }, payload: { version: voided.json().version }
  });
  assert.equal(included.statusCode, 200, included.body);
  assert.equal(included.json().voidedAt, null);
  assert.equal(included.json().voidReason, null);
  assert.equal(included.json().version, voided.json().version + 1);
  const counted = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/analytics?from=${day}&to=${day}&currency=RSD`, headers: contextHeaders() });
  assert.equal(counted.json().totalMinor, 90000, "counting it again restores it everywhere");
});

test("review actions can be safely undone and disconnect keeps the final expense", async () => {
  const row = app.db.prepare("SELECT id FROM bybit_card_transactions WHERE workspace_id=? AND merchant_name='WOLT'").get(workspaceId) as { id: string };
  const classify = async () => app.inject({
    method: "POST",
    url: `/api/workspaces/${workspaceId}/integrations/bybit-card/transactions/${row.id}/classify`,
    headers: { ...origin, ...contextHeaders() },
    payload: { categoryId: "eating-out", comment: "Dinner" }
  });
  const first = await classify();
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().pendingCount, 1);
  assert.equal(first.json().expense.amountMinor, 123400);
  assert.equal(first.json().expense.currency, "RSD");
  assert.equal(first.json().expense.note, "WOLT · Dinner");
  const replay = await classify();
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().expense.id, first.json().expense.id);
  assert.equal((app.db.prepare("SELECT count(*) count FROM expenses WHERE workspace_id=?").get(workspaceId) as { count: number }).count, 2, "the WOLT expense plus the reversed operation's expense");

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
  assert.equal(undoneClassification.json().pendingCount, 2);
  assert.equal(undoneClassification.json().transaction.reviewStatus, "pending");
  assert.equal((app.db.prepare("SELECT count(*) count FROM expenses WHERE workspace_id=? AND deleted_at IS NULL").get(workspaceId) as { count: number }).count, 1);

  const ignored = await app.inject({
    method: "POST",
    url: `/api/workspaces/${workspaceId}/integrations/bybit-card/transactions/${row.id}/ignore`,
    headers: { ...origin, ...contextHeaders() },
    payload: {}
  });
  assert.equal(ignored.statusCode, 200, ignored.body);
  assert.equal(ignored.json().pendingCount, 1);
  const undoneIgnore = await undo({});
  assert.equal(undoneIgnore.statusCode, 200, undoneIgnore.body);
  assert.equal(undoneIgnore.json().pendingCount, 2);

  const finalClassification = await classify();
  assert.equal(finalClassification.statusCode, 200, finalClassification.body);
  assert.notEqual(finalClassification.json().expense.id, first.json().expense.id);

  const disconnected = await app.inject({
    method: "DELETE", url: `/api/workspaces/${workspaceId}/integrations/bybit-card`, headers: { ...origin, ...contextHeaders() }, payload: {}
  });
  assert.equal(disconnected.statusCode, 204, disconnected.body);
  assert.equal((app.db.prepare("SELECT count(*) count FROM bybit_card_transactions WHERE workspace_id=?").get(workspaceId) as { count: number }).count, 0);
  assert.equal((app.db.prepare("SELECT count(*) count FROM expenses WHERE workspace_id=? AND deleted_at IS NULL").get(workspaceId) as { count: number }).count, 2);
});
