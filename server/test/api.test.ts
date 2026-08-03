import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { buildApp } from "../src/app.js";

const app = await buildApp({
  databasePath: ":memory:", pin: "2468", sessionSecret: "a-test-secret-that-is-definitely-longer-than-32-chars",
  sessionTtlDays: 30, secureCookies: false, frankfurterUrl: "https://example.invalid/v2", defaultAnalyticsCurrency: "RSD"
}, { logger: false, scheduler: false });

let cookie = "";
before(async () => { await app.ready(); });
after(async () => { await app.close(); });

test("health is public and auth is required", async () => {
  const health = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().status, "ok");
  const heartbeat = app.db.prepare("SELECT value FROM app_meta WHERE key='backup_heartbeat'").get() as { value: string };
  assert.ok(!Number.isNaN(Date.parse(heartbeat.value)));
  assert.equal((await app.inject({ method: "GET", url: "/api/bootstrap" })).statusCode, 401);
});

test("shared PIN creates a signed session", async () => {
  assert.equal((await app.inject({ method: "POST", url: "/api/session", payload: { pin: "wrong" } })).statusCode, 401);
  const response = await app.inject({ method: "POST", url: "/api/session", payload: { pin: "2468" } });
  assert.equal(response.statusCode, 200);
  cookie = response.headers["set-cookie"]!.split(";")[0]!;
  assert.match(cookie, /^moapp_session=/);
  assert.equal((await app.inject({ method: "GET", url: "/api/session", headers: { cookie } })).statusCode, 200);
});

test("bootstrap contains seeded categories", async () => {
  const response = await app.inject({ method: "GET", url: "/api/bootstrap", headers: { cookie } });
  assert.equal(response.statusCode, 200);
  const names = response.json().categories.map((category: { name: string }) => category.name);
  assert.deepEqual(names, ["Продукты", "Eating out", "Для дома", "Вафля", "Развлечения", "Подписки", "Прочее"]);
  assert.equal(response.json().rates.base, "RSD");
  assert.equal(response.json().rates.ratesToRsd.RSD, 1);
  assert.ok(response.json().currencies.some((currency: { code: string }) => currency.code === "EUR"));
});

test("expense create is idempotent and updates use optimistic versions", async () => {
  const id = randomUUID();
  const payload = { id, amountMinor: 12500, currency: "RSD", categoryId: "products", occurredAt: "2026-08-03T12:00:00.000Z", note: null };
  const created = await app.inject({ method: "POST", url: "/api/expenses", headers: { cookie }, payload });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().version, 1);
  assert.equal((await app.inject({ method: "POST", url: "/api/expenses", headers: { cookie }, payload })).statusCode, 200);
  const updated = await app.inject({ method: "PATCH", url: `/api/expenses/${id}`, headers: { cookie }, payload: { amountMinor: 13000, version: 1 } });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().version, 2);
  const conflict = await app.inject({ method: "PATCH", url: `/api/expenses/${id}`, headers: { cookie }, payload: { amountMinor: 14000, version: 1 } });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, "VERSION_CONFLICT");
});

test("lost sync responses can be replayed for create, update and delete", async () => {
  const id = randomUUID();
  const create = { operations: [{ operationId: randomUUID(), type: "createExpense", payload: { id, amountMinor: 999, currency: "EUR", categoryId: "other", occurredAt: "2026-08-03T13:00:00.000Z" } }] };
  const created = await app.inject({ method: "POST", url: "/api/sync", headers: { cookie }, payload: create });
  assert.equal(created.statusCode, 200);
  assert.equal(created.json().results[0].status, "applied");
  assert.equal(created.json().results[0].expense.version, 1);
  const replayedCreate = await app.inject({ method: "POST", url: "/api/sync", headers: { cookie }, payload: create });
  assert.equal(replayedCreate.json().results[0].replayed, true);
  assert.equal(replayedCreate.json().results[0].expense.version, 1);

  const update = { operations: [{ operationId: randomUUID(), type: "updateExpense", payload: { id, amountMinor: 1500, version: 1 } }] };
  const updated = await app.inject({ method: "POST", url: "/api/sync", headers: { cookie }, payload: update });
  assert.equal(updated.json().results[0].status, "applied");
  assert.equal(updated.json().results[0].expense.version, 2);
  assert.equal(updated.json().results[0].expense.amountMinor, 1500);
  const replayedUpdate = await app.inject({ method: "POST", url: "/api/sync", headers: { cookie }, payload: update });
  assert.equal(replayedUpdate.json().results[0].replayed, true);
  assert.equal(replayedUpdate.json().results[0].expense.version, 2);

  const remove = { operations: [{ operationId: randomUUID(), type: "deleteExpense", payload: { id, version: 2 } }] };
  const removed = await app.inject({ method: "POST", url: "/api/sync", headers: { cookie }, payload: remove });
  assert.equal(removed.json().results[0].status, "applied");
  assert.equal(removed.json().results[0].expense.version, 3);
  assert.ok(removed.json().results[0].expense.deletedAt);
  const replayedDelete = await app.inject({ method: "POST", url: "/api/sync", headers: { cookie }, payload: remove });
  assert.equal(replayedDelete.json().results[0].replayed, true);
  assert.equal(replayedDelete.json().results[0].expense.version, 3);
});

test("categories can be created, reordered and archived", async () => {
  const id = randomUUID();
  const created = await app.inject({ method: "POST", url: "/api/categories", headers: { cookie }, payload: { id, name: "Здоровье", placement: "additional", sortOrder: 5, color: "#44AA88" } });
  assert.equal(created.statusCode, 201);
  const retry = await app.inject({ method: "POST", url: "/api/categories", headers: { cookie }, payload: { id, name: "Здоровье", placement: "additional", sortOrder: 5, color: "#44AA88" } });
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.json().id, id);
  const incompatible = await app.inject({ method: "POST", url: "/api/categories", headers: { cookie }, payload: { id, name: "Другое имя", placement: "additional", sortOrder: 5, color: "#44AA88" } });
  assert.equal(incompatible.statusCode, 409);
  assert.equal(incompatible.json().error.code, "IDEMPOTENCY_CONFLICT");
  const list = await app.inject({ method: "GET", url: "/api/categories", headers: { cookie } });
  const ids = list.json().categories.map((category: { id: string }) => category.id).reverse();
  assert.equal((await app.inject({ method: "PUT", url: "/api/categories/order", headers: { cookie }, payload: { ids } })).statusCode, 200);
  const current = (await app.inject({ method: "GET", url: "/api/categories", headers: { cookie } })).json().categories.find((c: { id: string }) => c.id === id);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/categories/${id}`, headers: { cookie }, payload: { version: current.version } })).statusCode, 204);
});

test("analytics groups UTC timestamps by the Belgrade calendar day", async () => {
  const id = randomUUID();
  const created = await app.inject({
    method: "POST",
    url: "/api/expenses",
    headers: { cookie },
    payload: {
      id,
      amountMinor: 4200,
      currency: "RSD",
      categoryId: "products",
      occurredAt: "2026-08-03T22:30:00.000Z",
      note: null
    }
  });
  assert.equal(created.statusCode, 201);

  const analytics = await app.inject({
    method: "GET",
    url: "/api/analytics?from=2026-08-04&to=2026-08-04&currency=RSD",
    headers: { cookie }
  });
  assert.equal(analytics.statusCode, 200);
  assert.equal(analytics.json().totalMinor, 4200);
  assert.equal(analytics.json().daily[0].date, "2026-08-04");
});

test("changing APP_PIN revokes sessions while retaining SESSION_SECRET", async () => {
  const directory = mkdtempSync(join(tmpdir(), "moapp-pin-test-"));
  const databasePath = join(directory, "moapp.sqlite");
  const shared = {
    databasePath, sessionSecret: "the-same-session-secret-longer-than-thirty-two-characters",
    sessionTtlDays: 30, secureCookies: false, frankfurterUrl: "https://example.invalid/v2", defaultAnalyticsCurrency: "RSD"
  };
  try {
    const oldApp = await buildApp({ ...shared, pin: "1111" }, { logger: false, scheduler: false });
    const login = await oldApp.inject({ method: "POST", url: "/api/session", payload: { pin: "1111" } });
    const oldCookie = login.headers["set-cookie"]!.split(";")[0]!;
    assert.equal((await oldApp.inject({ method: "GET", url: "/api/session", headers: { cookie: oldCookie } })).statusCode, 200);
    await oldApp.close();

    const newApp = await buildApp({ ...shared, pin: "2222" }, { logger: false, scheduler: false });
    assert.equal((await newApp.inject({ method: "GET", url: "/api/session", headers: { cookie: oldCookie } })).statusCode, 401);
    assert.equal((await newApp.inject({ method: "POST", url: "/api/session", payload: { pin: "1111" } })).statusCode, 401);
    assert.equal((await newApp.inject({ method: "POST", url: "/api/session", payload: { pin: "2222" } })).statusCode, 200);
    await newApp.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
