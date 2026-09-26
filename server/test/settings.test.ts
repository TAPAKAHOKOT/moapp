import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { cleanupExpiredAccessRows } from "../src/access/index.js";
import { createSession, sessionCookieName } from "../src/auth.js";
import { registerSettingsRoutes } from "../src/settings.js";
import { registerTenantDomainRoutes } from "../src/tenant-domain.js";
import { createUser } from "../src/users.js";
import { buildTestApp, testConfig } from "./test-app.js";

const config = testConfig();
const app = await buildTestApp({ config, plugins: [registerTenantDomainRoutes, registerSettingsRoutes] });
after(async () => app.close());

type Device = { userId: string; headers: Record<string, string> };

/* Ещё одна сессия того же человека — как второй телефон. Сессия живёт от реального времени, см. tags.test.ts. */
function device(userId: string): Device {
  const session = createSession(app.db, config, { userId });
  return { userId, headers: {
    cookie: `${sessionCookieName(config)}=${app.signCookie(session.token)}`,
    origin: config.appOrigin,
    "x-moapp-expected-user-id": userId,
    "x-moapp-expected-session-id": session.id
  } };
}

function person(displayName: string): Device {
  return device(createUser(app.db, displayName).id);
}

function workspaceOf(owner: Device, ...members: Device[]): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  app.db.transaction(() => {
    app.db.prepare("INSERT INTO workspaces(id,name,owner_user_id,version,created_at,updated_at) VALUES (?,?,?,1,?,?)").run(id, "Дом", owner.userId, now, now);
    for (const who of [owner, ...members]) app.db.prepare("INSERT INTO memberships(workspace_id,user_id,joined_at,added_by_user_id) VALUES (?,?,?,NULL)").run(id, who.userId, now);
  })();
  return id;
}

const session = (who: Device) => app.inject({ method: "GET", url: "/api/session", headers: { cookie: who.headers.cookie! } });
const bootstrap = (who: Device, workspaceId: string) => app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/bootstrap`, headers: who.headers });
const saveAccount = (who: Device, settings: unknown, headers: Record<string, string> = who.headers) =>
  app.inject({ method: "PATCH", url: "/api/me/settings", headers, payload: { settings } });
const saveMember = (who: Device, workspaceId: string, settings: unknown) =>
  app.inject({ method: "PATCH", url: `/api/workspaces/${workspaceId}/me/settings`, headers: who.headers, payload: { settings } });

test("a new profile has no settings, and the theme it picks follows it to another device", async () => {
  const phone = person("Аня");
  assert.deepEqual((await session(phone)).json().settings, {});

  const saved = await saveAccount(phone, { theme: "dark" });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(saved.json(), { settings: { theme: "dark" } });

  const laptop = device(phone.userId);
  assert.deepEqual((await session(laptop)).json().settings, { theme: "dark" });
  assert.deepEqual((await session(person("Боря"))).json().settings, {}, "another person keeps the defaults");
});

test("the appearance of a profile is its theme, its own colour and its text size", async () => {
  const phone = person("Аня");
  const saved = await saveAccount(phone, { theme: "dark", accent: "terracotta", textSize: "large" });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(saved.json(), { settings: { theme: "dark", accent: "terracotta", textSize: "large" } });
  for (const settings of [{ accent: "red" }, { accent: "#ff0000" }, { textSize: "huge" }, { textSize: 1.2 }]) {
    const refused = await saveAccount(phone, settings);
    assert.equal(refused.statusCode, 400, JSON.stringify(settings));
    assert.equal(refused.json().error.details.key, Object.keys(settings)[0]);
  }
  assert.deepEqual((await session(device(phone.userId))).json().settings, { theme: "dark", accent: "terracotta", textSize: "large" });
});

test("unknown keys and impossible values are refused, and null returns a setting to its default", async () => {
  const phone = person("Аня");
  for (const settings of [{ theme: "purple" }, { fontSize: 18 }, { theme: ["dark"] }]) {
    const refused = await saveAccount(phone, settings);
    assert.equal(refused.statusCode, 400, refused.body);
    assert.equal(refused.json().error.code, "VALIDATION");
    assert.equal(refused.json().error.details.key, Object.keys(settings)[0]);
  }
  for (const payload of [{ settings: {} }, { settings: null }, { settings: { theme: "dark" }, extra: 1 }, {}]) {
    const refused = await app.inject({ method: "PATCH", url: "/api/me/settings", headers: phone.headers, payload });
    assert.equal(refused.statusCode, 400, refused.body);
  }
  assert.deepEqual((await session(phone)).json().settings, {}, "a refused change stores nothing");

  await saveAccount(phone, { theme: "light" });
  const reset = await saveAccount(phone, { theme: null });
  assert.deepEqual(reset.json(), { settings: {} });
});

test("settings change only from the app itself and only for the session the app expects", async () => {
  const phone = person("Аня");
  const { origin: _origin, ...withoutOrigin } = phone.headers;
  assert.equal((await saveAccount(phone, { theme: "dark" }, withoutOrigin)).statusCode, 403);
  const { "x-moapp-expected-session-id": _session, ...withoutContext } = phone.headers;
  const stale = await saveAccount(phone, { theme: "dark" }, withoutContext);
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.code, "SESSION_CONTEXT_CHANGED");
  assert.equal((await app.inject({ method: "PATCH", url: "/api/me/settings", payload: { settings: { theme: "dark" } }, headers: { origin: config.appOrigin } })).statusCode, 401);
  assert.deepEqual((await session(phone)).json().settings, {});
});

test("settings in a workspace are personal: each member sees only their own", async () => {
  const owner = person("Ваня");
  const member = person("Уля");
  const workspaceId = workspaceOf(owner, member);

  const ownerSaved = await saveMember(owner, workspaceId, { lastCurrency: "eur", analyticsCurrency: "USD" });
  assert.equal(ownerSaved.statusCode, 200, ownerSaved.body);
  assert.deepEqual(ownerSaved.json(), { settings: { lastCurrency: "EUR", analyticsCurrency: "USD" } });
  const filters = { period: "range", from: "2026-09-01", to: "2026-09-25", categoryIds: ["products"], tagIds: [], currencies: ["RSD"] };
  assert.equal((await saveMember(member, workspaceId, { historyFilters: filters })).statusCode, 200);

  assert.deepEqual((await bootstrap(owner, workspaceId)).json().settings, { lastCurrency: "EUR", analyticsCurrency: "USD" });
  assert.deepEqual((await bootstrap(member, workspaceId)).json().settings, { historyFilters: filters });
  assert.deepEqual((await session(owner)).json().settings, {}, "workspace settings are not account settings");
});

test("history filters keep their shape and never carry the search text", async () => {
  const owner = person("Ваня");
  const workspaceId = workspaceOf(owner);
  const valid = { period: "all", from: "", to: "", categoryIds: [], tagIds: [], currencies: [] };
  for (const historyFilters of [
    { ...valid, query: "кофе" },
    { ...valid, period: "yesterday" },
    { ...valid, from: "2026-02-30" },
    { ...valid, currencies: ["rsd"] },
    { ...valid, categoryIds: Array.from({ length: 51 }, (_, index) => `c${index}`) },
    "all"
  ]) {
    const refused = await saveMember(owner, workspaceId, { historyFilters });
    assert.equal(refused.statusCode, 400, JSON.stringify(historyFilters));
  }
  assert.equal((await saveMember(owner, workspaceId, { lastCurrency: "XYZ" })).statusCode, 400);
  assert.equal((await saveMember(owner, workspaceId, { theme: "dark" })).statusCode, 400, "account keys do not belong to a workspace");
  const saved = await saveMember(owner, workspaceId, { historyFilters: { ...valid, categoryIds: ["a", "a", "b"] } });
  assert.deepEqual(saved.json().settings.historyFilters.categoryIds, ["a", "b"]);
});

test("tiles and tags on «Расход» are a member's own, and a stale reference does not break them", async () => {
  const owner = person("Ваня");
  const member = person("Уля");
  const workspaceId = workspaceOf(owner, member);
  const categoryOrder = { shown: ["eating-out", "products", "gone"], more: ["home", "other"] };
  const saved = await saveMember(owner, workspaceId, { categoryOrder, tagOrder: { shown: [], more: ["t1", "t1", "t2"] } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(saved.json().settings, { categoryOrder, tagOrder: { shown: [], more: ["t1", "t2"] } }, "an id of a removed category may stay");
  assert.deepEqual((await bootstrap(member, workspaceId)).json().settings, {}, "another member keeps the shared layout");

  for (const order of [
    { shown: ["products"], more: ["products"] },
    { shown: ["products"] },
    { shown: ["products"], more: [], hidden: [] },
    { shown: Array.from({ length: 21 }, (_, index) => `c${index}`), more: [] },
    { shown: [""], more: [] },
    ["products"]
  ]) {
    const refused = await saveMember(owner, workspaceId, { categoryOrder: order });
    assert.equal(refused.statusCode, 400, JSON.stringify(order));
    assert.equal(refused.json().error.details.key, "categoryOrder");
  }
  assert.equal((await saveMember(owner, workspaceId, { categoryOrder: null })).json().settings.categoryOrder, undefined, "null returns the shared layout");
});

test("leaving a workspace forgets the settings there, and nobody outside can write them", async () => {
  const owner = person("Ваня");
  const member = person("Уля");
  const removed = person("Гость");
  const stranger = person("Чужой");
  const workspaceId = workspaceOf(owner, member, removed);
  const rows = (who: Device) => (app.db.prepare("SELECT count(*) count FROM member_settings WHERE workspace_id=? AND user_id=?").get(workspaceId, who.userId) as { count: number }).count;
  for (const who of [owner, member, removed]) assert.equal((await saveMember(who, workspaceId, { lastCurrency: "EUR" })).statusCode, 200);

  const strangerWrite = await saveMember(stranger, workspaceId, { lastCurrency: "EUR" });
  assert.equal(strangerWrite.statusCode, 404);
  assert.equal(strangerWrite.json().error.code, "WORKSPACE_NOT_FOUND");

  assert.equal((await app.inject({ method: "DELETE", url: `/api/workspaces/${workspaceId}/members/me`, headers: member.headers })).statusCode, 204);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/workspaces/${workspaceId}/members/${removed.userId}`, headers: owner.headers })).statusCode, 204);
  assert.equal(rows(member), 0);
  assert.equal(rows(removed), 0);
  assert.equal(rows(owner), 1);
});

test("a profile nobody can reach any more is cleaned up together with its settings", () => {
  const orphan = createUser(app.db, "Забытый");
  app.db.prepare("INSERT INTO user_settings(user_id,key,value_json,updated_at) VALUES (?,?,?,?)").run(orphan.id, "theme", "\"dark\"", new Date().toISOString());
  cleanupExpiredAccessRows(app.db);
  assert.equal(app.db.prepare("SELECT 1 FROM users WHERE id=?").get(orphan.id), undefined);
  assert.equal(app.db.prepare("SELECT 1 FROM user_settings WHERE user_id=?").get(orphan.id), undefined);
});
