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
const created = "2026-09-01T10:00:00.000Z";
const workspaceId = randomUUID();

function identity(displayName: string) {
  const user = createUser(app.db, displayName, created);
  // Сессия живёт 30 дней от реального времени: с фиксированной датой она протухает, и тесты падают в CI ровно через месяц.
  const session = createSession(app.db, config, { userId: user.id });
  return {
    user,
    headers: {
      cookie: `${sessionCookieName(config)}=${app.signCookie(session.token)}`,
      origin: config.appOrigin,
      "x-moapp-expected-user-id": user.id,
      "x-moapp-expected-session-id": session.id
    }
  };
}

const owner = identity("Owner");
app.db.transaction(() => {
  app.db.prepare("INSERT INTO workspaces(id,name,owner_user_id,version,created_at,updated_at) VALUES (?,?,?,1,?,?)").run(workspaceId, "Home", owner.user.id, created, created);
  app.db.prepare("INSERT INTO memberships(workspace_id,user_id,joined_at,added_by_user_id) VALUES (?,?,?,NULL)").run(workspaceId, owner.user.id, created);
  seedWorkspaceCategories(app.db, workspaceId);
})();
after(async () => app.close());

const api = (method: "GET" | "POST" | "PATCH" | "DELETE", path: string, payload?: unknown, headers = owner.headers) =>
  app.inject({ method, url: `/api/workspaces/${workspaceId}${path}`, headers, ...(payload === undefined ? {} : { payload }) });

async function expense(amountMinor: number, extra: Record<string, unknown> = {}) {
  const response = await api("POST", "/expenses", {
    id: randomUUID(), amountMinor, currency: "RSD", categoryId: "products",
    occurredAt: "2026-09-05T18:30:00.000Z", note: "Maxi", ...extra
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json() as { id: string; version: number; tagIds: string[] };
}

test("a saved expense splits into parts that keep its day, currency, note and tags", async () => {
  const tag = await api("POST", "/tags", { name: "Поездка" });
  assert.equal(tag.statusCode, 201, tag.body);
  const original = await expense(300000, { tagIds: [tag.json().id] });

  const split = await api("POST", `/expenses/${original.id}/split`, {
    version: original.version,
    parts: [{ amountMinor: 200000, categoryId: "products" }, { amountMinor: 100000, categoryId: "home" }]
  });
  assert.equal(split.statusCode, 200, split.body);
  const parts = split.json().expenses as Array<Record<string, unknown>>;
  assert.equal(parts.length, 2);
  assert.equal(parts[0]!.id, original.id, "the first part stays the expense that was split");
  assert.notEqual(parts[1]!.id, original.id);
  assert.deepEqual(parts.map((part) => [part.amountMinor, part.categoryId]), [[200000, "products"], [100000, "home"]]);
  for (const part of parts) {
    assert.equal(part.currency, "RSD");
    assert.equal(part.occurredAt, "2026-09-05T18:30:00.000Z");
    assert.equal(part.note, "Maxi", "parts describe the same purchase");
    assert.deepEqual(part.tagIds, [tag.json().id]);
    assert.equal(part.deletedAt, null);
  }
  assert.equal(parts[0]!.version, original.version + 1, "the original is edited, not recreated");

  const stored = await api("GET", "/expenses");
  assert.equal(stored.json().expenses.length, 2);
  assert.equal((stored.json().expenses as Array<{ amountMinor: number }>).reduce((total, item) => total + item.amountMinor, 0), 300000);
});

test("a split is refused unless the parts add up to the untouched expense", async () => {
  const original = await expense(100000);

  const mismatch = await api("POST", `/expenses/${original.id}/split`, {
    version: original.version, parts: [{ amountMinor: 60000, categoryId: "products" }, { amountMinor: 30000, categoryId: "home" }]
  });
  assert.equal(mismatch.statusCode, 400, mismatch.body);
  assert.equal(mismatch.json().error.code, "SPLIT_MISMATCH");

  const single = await api("POST", `/expenses/${original.id}/split`, {
    version: original.version, parts: [{ amountMinor: 100000, categoryId: "products" }]
  });
  assert.equal(single.statusCode, 400, single.body);
  assert.equal(single.json().error.code, "VALIDATION");

  const zero = await api("POST", `/expenses/${original.id}/split`, {
    version: original.version, parts: [{ amountMinor: 100000, categoryId: "products" }, { amountMinor: 0, categoryId: "home" }]
  });
  assert.equal(zero.statusCode, 400, zero.body);

  const stale = await api("POST", `/expenses/${original.id}/split`, {
    version: original.version + 1, parts: [{ amountMinor: 60000, categoryId: "products" }, { amountMinor: 40000, categoryId: "home" }]
  });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.equal(stale.json().error.code, "VERSION_CONFLICT");
  assert.equal(stale.json().error.details.current.amountMinor, 100000);

  const missingCategory = await api("POST", `/expenses/${original.id}/split`, {
    version: original.version, parts: [{ amountMinor: 60000, categoryId: "products" }, { amountMinor: 40000, categoryId: "nope" }]
  });
  assert.equal(missingCategory.statusCode, 400, missingCategory.body);
  assert.equal(missingCategory.json().error.code, "CATEGORY_INVALID");

  const unchanged = await api("GET", `/expenses/${original.id}`);
  assert.equal(unchanged.json().amountMinor, 100000, "a failed part rolls the whole split back");
  assert.equal(unchanged.json().version, original.version);
  assert.equal(unchanged.json().categoryId, "products");
  const stored = await api("GET", "/expenses");
  assert.equal((stored.json().expenses as unknown[]).length, 3, "no orphan part survived the rejected splits");
});

test("a deleted or declined expense cannot be split", async () => {
  const original = await expense(50000);
  const voided = await expense(70000);
  app.db.prepare("UPDATE expenses SET voided_at=?,void_reason=? WHERE workspace_id=? AND id=?")
    .run(created, JSON.stringify({ provider: "bybit-card", kind: "declined", txnId: null, merchantName: "Maxi", amountMinor: 70000, currency: "RSD" }), workspaceId, voided.id);

  const declined = await api("POST", `/expenses/${voided.id}/split`, {
    version: voided.version, parts: [{ amountMinor: 40000, categoryId: "products" }, { amountMinor: 30000, categoryId: "home" }]
  });
  assert.equal(declined.statusCode, 400, declined.body);
  assert.equal(declined.json().error.code, "EXPENSE_VOIDED");

  const removed = await api("DELETE", `/expenses/${original.id}`, { version: original.version });
  assert.equal(removed.statusCode, 204, removed.body);
  const gone = await api("POST", `/expenses/${original.id}/split`, {
    version: original.version + 1, parts: [{ amountMinor: 30000, categoryId: "products" }, { amountMinor: 20000, categoryId: "home" }]
  });
  assert.equal(gone.statusCode, 404, gone.body);
  assert.equal(gone.json().error.code, "NOT_FOUND");
});

test("splitting stays inside the workspace and needs a mutation origin", async () => {
  const original = await expense(80000);
  const parts = [{ amountMinor: 50000, categoryId: "products" }, { amountMinor: 30000, categoryId: "home" }];

  const foreignOrigin = await api("POST", `/expenses/${original.id}/split`, { version: original.version, parts },
    { ...owner.headers, origin: "https://evil.test" });
  assert.equal(foreignOrigin.statusCode, 403, foreignOrigin.body);

  const stranger = identity("Stranger");
  const outsider = await api("POST", `/expenses/${original.id}/split`, { version: original.version, parts }, stranger.headers);
  assert.equal(outsider.statusCode, 404, outsider.body);
  assert.equal(outsider.json().error.code, "WORKSPACE_NOT_FOUND");

  const intact = await api("GET", `/expenses/${original.id}`);
  assert.equal(intact.json().amountMinor, 80000);
});
