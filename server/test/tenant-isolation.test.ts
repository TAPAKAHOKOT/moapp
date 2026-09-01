import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { createSession, sessionCookieName } from "../src/auth.js";
import { seedWorkspaceCategories } from "../src/db.js";
import { registerTenantDomainRoutes } from "../src/tenant-domain.js";
import { createUser } from "../src/users.js";
import { buildTestApp, testConfig } from "./test-app.js";

const config = testConfig();
const app = await buildTestApp({ config, plugins: [registerTenantDomainRoutes] });
const now = "2026-08-04T10:00:00.000Z";
const workspaceA = randomUUID();
const workspaceB = randomUUID();
const sharedExpenseId = randomUUID();
const expenseOnlyA = randomUUID();
const categoryOnlyB = randomUUID();

function createIdentity(displayName: string) {
  const user = createUser(app.db, displayName, now);
  const session = createSession(app.db, config, { userId: user.id, now: new Date(now) });
  const cookie = `${sessionCookieName(config)}=${app.signCookie(session.token)}`;
  return {
    user,
    session,
    headers: {
      cookie,
      origin: config.appOrigin,
      "x-moapp-expected-user-id": user.id,
      "x-moapp-expected-session-id": session.id
    }
  };
}

const identityA = createIdentity("Owner A");
const identityB = createIdentity("Owner B");

app.db.transaction(() => {
  for (const [workspaceId, name, ownerId] of [
    [workspaceA, "A", identityA.user.id],
    [workspaceB, "B", identityB.user.id]
  ] as const) {
    app.db.prepare(`INSERT INTO workspaces(id,name,owner_user_id,version,created_at,updated_at)
      VALUES (?,?,?,1,?,?)`).run(workspaceId, name, ownerId, now, now);
    app.db.prepare(`INSERT INTO memberships(workspace_id,user_id,joined_at,added_by_user_id)
      VALUES (?,?,?,NULL)`).run(workspaceId, ownerId, now);
    seedWorkspaceCategories(app.db, workspaceId);
  }
  app.db.prepare(`INSERT INTO categories
    (workspace_id,id,name,placement,sort_order,color,version,created_at,updated_at)
    VALUES (?,?,?,'additional',99,NULL,1,?,?)`).run(workspaceB, categoryOnlyB, "Only B", now, now);
  const insertExpense = app.db.prepare(`INSERT INTO expenses
    (workspace_id,id,amount_minor,currency,category_id,occurred_at,note,version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,NULL,1,?,?)`);
  insertExpense.run(workspaceA, sharedExpenseId, 1_000, "RSD", "products", now, now, now);
  insertExpense.run(workspaceB, sharedExpenseId, 9_000, "RSD", "products", now, now, now);
  insertExpense.run(workspaceA, expenseOnlyA, 2_000, "RSD", "other", now, now, now);
  app.db.prepare(`INSERT INTO exchange_rates(rate_date,base_currency,quote_currency,rate,fetched_at)
    VALUES (?,'EUR','RSD',117,?)`).run("2026-08-04", now);
  app.db.prepare(`INSERT INTO exchange_rates(rate_date,base_currency,quote_currency,rate,fetched_at)
    VALUES (?,'EUR','EUR',1,?)`).run("2026-08-04", now);
})();

after(async () => app.close());

test("workspace guards hide foreign tenants and scoped bootstrap never mixes rows", async () => {
  const own = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceA}/bootstrap`, headers: identityA.headers });
  assert.equal(own.statusCode, 200, own.body);
  assert.equal(own.headers["cache-control"], "private, no-store");
  assert.equal(own.json().workspaceId, workspaceA);
  assert.equal(own.json().workspace.id, workspaceA);
  assert.deepEqual(new Set(own.json().expenses.map((row: { amountMinor: number }) => row.amountMinor)), new Set([1_000, 2_000]));

  const foreign = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceB}/expenses`, headers: identityA.headers });
  assert.equal(foreign.statusCode, 404);
  assert.equal(foreign.json().error.code, "WORKSPACE_NOT_FOUND");

  const crossId = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceB}/expenses/${expenseOnlyA}`, headers: identityB.headers });
  assert.equal(crossId.statusCode, 404);
  assert.equal(crossId.json().error.code, "NOT_FOUND");
});

test("matching IDs mutate only the workspace selected by the route and stale conflicts stay scoped", async () => {
  const changed = await app.inject({
    method: "PATCH",
    url: `/api/workspaces/${workspaceA}/expenses/${sharedExpenseId}`,
    headers: identityA.headers,
    payload: { amountMinor: 1_500, version: 1 }
  });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json().amountMinor, 1_500);
  assert.equal(app.db.prepare("SELECT amount_minor FROM expenses WHERE workspace_id=? AND id=?").pluck().get(workspaceB, sharedExpenseId), 9_000);

  const stale = await app.inject({
    method: "PATCH",
    url: `/api/workspaces/${workspaceA}/expenses/${sharedExpenseId}`,
    headers: identityA.headers,
    payload: { amountMinor: 7_000, version: 1 }
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.details.current.amountMinor, 1_500);
  assert.notEqual(stale.json().error.details.current.amountMinor, 9_000);

  const invalidCategory = await app.inject({
    method: "PATCH",
    url: `/api/workspaces/${workspaceA}/expenses/${sharedExpenseId}`,
    headers: identityA.headers,
    payload: { categoryId: categoryOnlyB, version: 2 }
  });
  assert.equal(invalidCategory.statusCode, 400);
  assert.equal(invalidCategory.json().error.code, "CATEGORY_INVALID");
});

test("category order and archived history remain workspace scoped", async () => {
  const beforeB = app.db.prepare("SELECT id,sort_order,version FROM categories WHERE workspace_id=? AND placement='main' ORDER BY sort_order")
    .all(workspaceB);
  const idsA = (app.db.prepare("SELECT id FROM categories WHERE workspace_id=? AND placement='main' AND archived_at IS NULL ORDER BY sort_order")
    .pluck().all(workspaceA) as string[]).reverse();
  const reordered = await app.inject({
    method: "PUT",
    url: `/api/workspaces/${workspaceA}/categories/order`,
    headers: identityA.headers,
    payload: { ids: idsA }
  });
  assert.equal(reordered.statusCode, 200, reordered.body);
  assert.deepEqual(app.db.prepare("SELECT id,sort_order,version FROM categories WHERE workspace_id=? AND placement='main' ORDER BY sort_order")
    .all(workspaceB), beforeB);

  const version = app.db.prepare("SELECT version FROM categories WHERE workspace_id=? AND id='products'")
    .pluck().get(workspaceA) as number;
  const archived = await app.inject({
    method: "DELETE",
    url: `/api/workspaces/${workspaceA}/categories/products`,
    headers: identityA.headers,
    payload: { version }
  });
  assert.equal(archived.statusCode, 204, archived.body);
  const bootstrap = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceA}/bootstrap`, headers: identityA.headers });
  assert.ok(bootstrap.json().categories.some((category: { id: string; archivedAt: string | null }) => category.id === "products" && category.archivedAt));
  assert.equal(app.db.prepare("SELECT archived_at FROM categories WHERE workspace_id=? AND id='products'").pluck().get(workspaceB), null);

  const retained = await app.inject({
    method: "PATCH",
    url: `/api/workspaces/${workspaceA}/expenses/${sharedExpenseId}`,
    headers: identityA.headers,
    payload: { note: "edited after archive", categoryId: "products", version: 2 }
  });
  assert.equal(retained.statusCode, 200, retained.body);
  assert.equal(retained.json().note, "edited after archive");
  assert.equal(retained.json().categoryId, "products");

  const newlySelectedArchived = await app.inject({
    method: "PATCH",
    url: `/api/workspaces/${workspaceA}/expenses/${expenseOnlyA}`,
    headers: identityA.headers,
    payload: { categoryId: "products", version: 1 }
  });
  assert.equal(newlySelectedArchived.statusCode, 400);
  assert.equal(newlySelectedArchived.json().error.code, "CATEGORY_INVALID");
});

test("category names are canonically normalized and reject control characters", async () => {
  const id = randomUUID();
  const created = await app.inject({
    method: "POST",
    url: `/api/workspaces/${workspaceA}/categories`,
    headers: identityA.headers,
    payload: { id, name: "  Cafe\u0301  ", placement: "additional", sortOrder: 100 }
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().name, "Café");
  const invalid = await app.inject({
    method: "PATCH",
    url: `/api/workspaces/${workspaceA}/categories/${id}`,
    headers: identityA.headers,
    payload: { name: "Hidden\u202Ename", version: 1 }
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, "VALIDATION");
});

test("analytics filters tenants in SQL and sync idempotency is composite", async () => {
  const analytics = await app.inject({
    method: "GET",
    url: `/api/workspaces/${workspaceA}/analytics?from=2026-08-04&to=2026-08-04&currency=RSD`,
    headers: identityA.headers
  });
  assert.equal(analytics.statusCode, 200, analytics.body);
  assert.equal(analytics.json().totalMinor, 3_500);
  assert.equal(analytics.json().expenseCount, 2);

  const operationId = randomUUID();
  const makeSync = (workspaceId: string, id: string, amountMinor: number, headers: typeof identityA.headers) => app.inject({
    method: "POST",
    url: `/api/workspaces/${workspaceId}/sync`,
    headers,
    payload: { operations: [{ operationId, type: "createExpense", payload: { id, amountMinor, currency: "RSD", categoryId: "other", occurredAt: now } }] }
  });
  const syncA = await makeSync(workspaceA, randomUUID(), 111, identityA.headers);
  const syncB = await makeSync(workspaceB, randomUUID(), 999, identityB.headers);
  assert.equal(syncA.statusCode, 200, syncA.body);
  assert.equal(syncB.statusCode, 200, syncB.body);
  assert.equal(syncA.json().workspaceId, workspaceA);
  assert.equal(syncB.json().workspaceId, workspaceB);
  assert.equal(syncA.json().results[0].expense.amountMinor, 111);
  assert.equal(syncB.json().results[0].expense.amountMinor, 999);
  assert.equal(app.db.prepare("SELECT count(*) FROM sync_operations WHERE operation_id=?").pluck().get(operationId), 2);
  const replayA = await makeSync(workspaceA, randomUUID(), 777, identityA.headers);
  assert.equal(replayA.json().results[0].replayed, true);
  assert.equal(replayA.json().results[0].expense.amountMinor, 111);
});

test("analytics and rate conversion reject impossible calendar dates before loading rates", async () => {
  for (const date of ["2026-99-99", "2026-02-30", "banana"]) {
    const analytics = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceA}/analytics?from=${date}&to=2026-08-04&currency=RSD`,
      headers: identityA.headers
    });
    assert.equal(analytics.statusCode, 400, analytics.body);
    assert.equal(analytics.json().error.code, "VALIDATION");

    const conversion = await app.inject({
      method: "GET",
      url: `/api/rates/convert?amount=1&from=EUR&to=RSD&date=${date}`,
      headers: identityA.headers
    });
    assert.equal(conversion.statusCode, 400, conversion.body);
    assert.equal(conversion.json().error.code, "VALIDATION");
  }
});

test("membership removal blocks mutations, old APIs are 410, and rates require a normal expected context", async () => {
  const removedWorkspace = randomUUID();
  app.db.transaction(() => {
    app.db.prepare(`INSERT INTO workspaces(id,name,owner_user_id,version,created_at,updated_at)
      VALUES (?,?,?,1,?,?)`).run(removedWorkspace, "Removed", identityB.user.id, now, now);
    app.db.prepare(`INSERT INTO memberships(workspace_id,user_id,joined_at,added_by_user_id)
      VALUES (?,?,?,NULL)`).run(removedWorkspace, identityB.user.id, now);
    app.db.prepare(`INSERT INTO memberships(workspace_id,user_id,joined_at,added_by_user_id)
      VALUES (?,?,?,?)`).run(removedWorkspace, identityA.user.id, now, identityB.user.id);
    seedWorkspaceCategories(app.db, removedWorkspace);
    app.db.prepare("DELETE FROM memberships WHERE workspace_id=? AND user_id=?").run(removedWorkspace, identityA.user.id);
  })();
  const denied = await app.inject({
    method: "POST",
    url: `/api/workspaces/${removedWorkspace}/expenses`,
    headers: identityA.headers,
    payload: { id: randomUUID(), amountMinor: 1, currency: "RSD", categoryId: "other", occurredAt: now }
  });
  assert.equal(denied.statusCode, 404);
  assert.equal(denied.json().error.code, "WORKSPACE_NOT_FOUND");
  assert.equal(app.db.prepare("SELECT count(*) FROM expenses WHERE workspace_id=?").pluck().get(removedWorkspace), 0);

  for (const [method, url] of [["GET", "/api/bootstrap"], ["GET", "/api/expenses"], ["POST", "/api/sync"]] as const) {
    const response = await app.inject({ method, url, ...(method === "POST" ? { payload: { operations: [] } } : {}) });
    assert.equal(response.statusCode, 410, `${method} ${url}: ${response.body}`);
    assert.equal(response.json().error.code, "UPGRADE_REQUIRED");
  }

  const guestRates = await app.inject({ method: "GET", url: "/api/rates/status" });
  assert.equal(guestRates.statusCode, 401);
  const missingExpected = await app.inject({ method: "GET", url: "/api/rates/status", headers: { cookie: identityA.headers.cookie } });
  assert.equal(missingExpected.statusCode, 409);
  const rates = await app.inject({ method: "GET", url: "/api/rates/status", headers: identityA.headers });
  assert.equal(rates.statusCode, 200);
  assert.equal(rates.headers["cache-control"], "private, no-store");
});

test("tenant mutations reject non-object JSON bodies without a server error", async () => {
  const malformed = await app.inject({
    method: "POST",
    url: `/api/workspaces/${workspaceA}/categories`,
    headers: { ...identityA.headers, "content-type": "application/json" },
    payload: "null"
  });
  assert.equal(malformed.statusCode, 400, malformed.body);
  assert.equal(malformed.json().error.code, "REQUEST_ERROR");
});
