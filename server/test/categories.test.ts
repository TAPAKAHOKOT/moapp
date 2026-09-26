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
const now = "2026-09-01T10:00:00.000Z";
const workspaceId = randomUUID();

const owner = createUser(app.db, "Owner", now);
// Сессия живёт 30 дней от реального времени: с фиксированной датой она протухает, и тесты падают в CI ровно через месяц.
const session = createSession(app.db, config, { userId: owner.id });
const headers = {
  cookie: `${sessionCookieName(config)}=${app.signCookie(session.token)}`,
  origin: config.appOrigin,
  "x-moapp-expected-user-id": owner.id,
  "x-moapp-expected-session-id": session.id
};
app.db.transaction(() => {
  app.db.prepare("INSERT INTO workspaces(id,name,owner_user_id,version,created_at,updated_at) VALUES (?,?,?,1,?,?)").run(workspaceId, "W", owner.id, now, now);
  app.db.prepare("INSERT INTO memberships(workspace_id,user_id,joined_at,added_by_user_id) VALUES (?,?,?,NULL)").run(workspaceId, owner.id, now);
  seedWorkspaceCategories(app.db, workspaceId);
})();
after(async () => app.close());

const api = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, payload?: unknown) =>
  app.inject({ method, url: `/api/workspaces/${workspaceId}${path}`, headers, ...(payload === undefined ? {} : { payload }) });

const category = (id: string) => app.db.prepare("SELECT * FROM categories WHERE workspace_id=? AND id=?")
  .get(workspaceId, id) as { name: string; archived_at: string | null; placement: string; color: string | null } | undefined;

test("a hidden category comes back instead of a second one with the same name", async () => {
  const expenseId = randomUUID();
  const spent = await api("POST", "/expenses", { id: expenseId, amountMinor: 4500, currency: "RSD", categoryId: "home", occurredAt: now });
  assert.equal(spent.statusCode, 201, spent.body);

  const hidden = await api("DELETE", "/categories/home", { version: 1 });
  assert.equal(hidden.statusCode, 204, hidden.body);
  assert.ok(category("home")!.archived_at);

  // Имя занято скрытой категорией, поэтому создание отдаёт её обратно — вместе с расходом и под новым цветом.
  const again = await api("POST", "/categories", { id: randomUUID(), name: "для дома", placement: "main", sortOrder: 0, color: "#7cb98b" });
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().id, "home");
  assert.equal(again.json().archivedAt, null);
  assert.equal(again.json().name, "для дома");
  assert.equal(again.json().placement, "main");
  assert.equal(again.json().color, "#7cb98b");
  assert.equal(app.db.prepare("SELECT count(*) FROM categories WHERE workspace_id=?").pluck().get(workspaceId), 6);
  const kept = await api("GET", "/expenses?categoryId=home");
  assert.deepEqual(kept.json().expenses.map((item: { id: string }) => item.id), [expenseId], "старый расход остался у вернувшейся категории");
});

test("the name of an active category is taken, in Cyrillic case too", async () => {
  const duplicate = await api("POST", "/categories", { id: randomUUID(), name: "  Продукты ", placement: "additional", sortOrder: 9, color: "#7cb98b" });
  assert.equal(duplicate.statusCode, 409, duplicate.body);
  assert.equal(duplicate.json().error.code, "DUPLICATE");
  assert.equal(duplicate.json().error.details.current.id, "products");

  // SQLite NOCASE складывает только латиницу: до сравнения имён в JS «продукты» создавали второй категорией.
  const lowercased = await api("POST", "/categories", { id: randomUUID(), name: "продукты", placement: "additional", sortOrder: 9, color: "#7cb98b" });
  assert.equal(lowercased.statusCode, 409, lowercased.body);
  assert.equal(lowercased.json().error.details.current.id, "products");
  assert.equal(app.db.prepare("SELECT count(*) FROM categories WHERE workspace_id=?").pluck().get(workspaceId), 6);

  const renamed = await api("PATCH", "/categories/subscriptions", { name: "ПРОДУКТЫ", version: 1 });
  assert.equal(renamed.statusCode, 409, renamed.body);
  assert.equal(renamed.json().error.code, "DUPLICATE");
  assert.equal(renamed.json().error.details.current.id, "products");
  assert.equal(category("subscriptions")!.name, "Подписки");
});

test("a hidden category is restored by clearing archivedAt", async () => {
  const hidden = await api("DELETE", "/categories/entertainment", { version: 1 });
  assert.equal(hidden.statusCode, 204, hidden.body);
  const listed = await api("GET", "/categories");
  assert.ok(!listed.json().categories.some((item: { id: string }) => item.id === "entertainment"));

  const restored = await api("PATCH", "/categories/entertainment", { archivedAt: null, version: 2 });
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal(restored.json().archivedAt, null);
  assert.equal(restored.json().name, "Развлечения");
  const again = await api("GET", "/categories");
  assert.ok(again.json().categories.some((item: { id: string }) => item.id === "entertainment"));
});

test("a category carries one emoji for everybody, and a joined emoji fits into its name", async () => {
  const body = { id: randomUUID(), name: "🧑‍🍳 Готовим дома", placement: "additional", sortOrder: 9, color: "#7cb98b", emoji: "🧑‍🍳" };
  const created = await api("POST", "/categories", body);
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().name, "🧑‍🍳 Готовим дома");
  assert.equal(created.json().emoji, "🧑‍🍳");
  assert.equal((await api("POST", "/categories", body)).statusCode, 200, "a retry of the same creation is not a conflict");
  assert.equal((await api("POST", "/categories", { ...body, emoji: "🍳" })).json().error.code, "IDEMPOTENCY_CONFLICT");

  const heart = await api("PATCH", `/categories/${body.id}`, { emoji: "❤", version: 1 });
  assert.equal(heart.json().emoji, "❤️", "a text heart from a Mac keyboard becomes a picture");
  const renamed = await api("PATCH", `/categories/${body.id}`, { name: "Готовим дома", version: 2 });
  assert.equal(renamed.json().emoji, "❤️", "a change without the field keeps the emoji");
  const cleared = await api("PATCH", `/categories/${body.id}`, { emoji: null, version: 3 });
  assert.equal(cleared.json().emoji, null);

  for (const emoji of ["ab", "🍕🍔", "К", 5, "\u200d"]) {
    const refused = await api("PATCH", "/categories/products", { emoji, version: 1 });
    assert.equal(refused.statusCode, 400, JSON.stringify(emoji));
  }
  // Невидимые символы вне эмодзи по-прежнему не проходят: ими прячут текст.
  for (const name of ["Кафе\u200dтест", "Скрыто\u200b", "\u202eреклама"]) {
    const refused = await api("POST", "/categories", { id: randomUUID(), name, placement: "additional", sortOrder: 9 });
    assert.equal(refused.statusCode, 400, JSON.stringify(name));
  }
  const products = (await api("GET", "/categories")).json().categories.find((item: { id: string }) => item.id === "products");
  assert.equal(products.emoji, null, "a category nobody gave an emoji keeps its colour square");
});
