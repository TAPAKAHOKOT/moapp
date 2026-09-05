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
const otherWorkspaceId = randomUUID();

function identity(displayName: string) {
  const user = createUser(app.db, displayName, now);
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
const stranger = identity("Stranger");
app.db.transaction(() => {
  for (const [id, ownerId] of [[workspaceId, owner.user.id], [otherWorkspaceId, stranger.user.id]] as const) {
    app.db.prepare("INSERT INTO workspaces(id,name,owner_user_id,version,created_at,updated_at) VALUES (?,?,?,1,?,?)").run(id, "W", ownerId, now, now);
    app.db.prepare("INSERT INTO memberships(workspace_id,user_id,joined_at,added_by_user_id) VALUES (?,?,?,NULL)").run(id, ownerId, now);
    seedWorkspaceCategories(app.db, id);
  }
})();
after(async () => app.close());

const api = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, payload?: unknown, headers = owner.headers) =>
  app.inject({ method, url: `/api/workspaces/${workspaceId}${path}`, headers, ...(payload === undefined ? {} : { payload }) });

test("tags are created, renamed, deduplicated by name and listed in the bootstrap", async () => {
  const created = await api("POST", "/tags", { name: "  Поездка   в Ниш " });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().name, "Поездка в Ниш");
  const duplicate = await api("POST", "/tags", { name: "поездка в ниш" });
  assert.equal(duplicate.statusCode, 409, duplicate.body);
  assert.equal(duplicate.json().error.code, "DUPLICATE");
  assert.equal(duplicate.json().error.details.current.id, created.json().id);
  const tooLong = await api("POST", "/tags", { name: "x".repeat(31) });
  assert.equal(tooLong.statusCode, 400, tooLong.body);

  assert.equal(created.json().color, null);
  assert.equal(created.json().sortOrder, 0);
  const badColor = await api("POST", "/tags", { name: "Цвет", color: "red" });
  assert.equal(badColor.statusCode, 400, badColor.body);
  const renamed = await api("PATCH", `/tags/${created.json().id}`, { name: "Ниш", color: "#D98F70", version: 1 });
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal(renamed.json().version, 2);
  assert.equal(renamed.json().color, "#d98f70");
  const recolored = await api("PATCH", `/tags/${created.json().id}`, { color: null, version: 2 });
  assert.equal(recolored.statusCode, 200, recolored.body);
  assert.equal(recolored.json().name, "Ниш", "a patch without name keeps it");
  assert.equal(recolored.json().color, null);
  const second = await api("POST", "/tags", { name: "Аренда", color: "#819978" });
  assert.equal(second.json().sortOrder, 1);
  const badOrder = await api("PUT", "/tags/order", { ids: [second.json().id] });
  assert.equal(badOrder.statusCode, 400, badOrder.body);
  const reordered = await api("PUT", "/tags/order", { ids: [second.json().id, created.json().id] });
  assert.equal(reordered.statusCode, 200, reordered.body);
  assert.deepEqual(reordered.json().tags.map((tag: { name: string; sortOrder: number }) => [tag.name, tag.sortOrder]), [["Аренда", 0], ["Ниш", 1]]);
  const stale = await api("PATCH", `/tags/${created.json().id}`, { name: "Опять", version: 1 });
  assert.equal(stale.statusCode, 409, stale.body);
  const afterReorder = await api("GET", "/tags");
  assert.deepEqual(afterReorder.json().tags.map((tag: { name: string }) => tag.name), ["Аренда", "Ниш"]);
  const removedSecond = await api("DELETE", `/tags/${second.json().id}`, { version: second.json().version + 1 });
  assert.equal(removedSecond.statusCode, 204, removedSecond.body);
  const bootstrap = await api("GET", "/bootstrap");
  assert.equal(bootstrap.statusCode, 200, bootstrap.body);
  assert.deepEqual(bootstrap.json().tags.map((tag: { name: string }) => tag.name), ["Ниш"]);
});

test("expenses carry tags through create, update, filters, sync and tag deletion", async () => {
  const [work, food] = await Promise.all([api("POST", "/tags", { name: "Работа" }), api("POST", "/tags", { name: "Еда" })]);
  const workId = work.json().id as string;
  const foodId = food.json().id as string;
  const expenseId = randomUUID();
  const base = { id: expenseId, amountMinor: 1500, currency: "RSD", categoryId: "products", occurredAt: now };

  const unknownTag = await api("POST", "/expenses", { ...base, tagIds: [randomUUID()] });
  assert.equal(unknownTag.statusCode, 400, unknownTag.body);
  assert.equal(unknownTag.json().error.code, "TAG_INVALID");
  const duplicateTags = await api("POST", "/expenses", { ...base, tagIds: [workId, workId] });
  assert.equal(duplicateTags.statusCode, 400, duplicateTags.body);

  const created = await api("POST", "/expenses", { ...base, tagIds: [workId, foodId] });
  assert.equal(created.statusCode, 201, created.body);
  assert.deepEqual(created.json().tagIds, [workId, foodId].sort());
  const replay = await api("POST", "/expenses", { ...base, tagIds: [foodId, workId] });
  assert.equal(replay.statusCode, 200, replay.body);
  const conflicting = await api("POST", "/expenses", { ...base, tagIds: [foodId] });
  assert.equal(conflicting.statusCode, 409, conflicting.body);

  const untouched = await api("PATCH", `/expenses/${expenseId}`, { note: "обед", version: 1 });
  assert.equal(untouched.statusCode, 200, untouched.body);
  assert.deepEqual(untouched.json().tagIds, [workId, foodId].sort(), "a patch without tagIds keeps the tags");
  const retagged = await api("PATCH", `/expenses/${expenseId}`, { tagIds: [foodId], version: 2 });
  assert.equal(retagged.statusCode, 200, retagged.body);
  assert.deepEqual(retagged.json().tagIds, [foodId]);

  const byWork = await api("GET", `/expenses?tagId=${workId}`);
  assert.deepEqual(byWork.json().expenses, []);
  const byFood = await api("GET", `/expenses?tagId=${foodId}`);
  assert.deepEqual(byFood.json().expenses.map((item: { id: string }) => item.id), [expenseId]);

  const syncedId = randomUUID();
  const synced = await api("POST", "/sync", { operations: [{ operationId: randomUUID(), type: "createExpense", payload: { ...base, id: syncedId, tagIds: [workId] } }] });
  assert.equal(synced.statusCode, 200, synced.body);
  assert.deepEqual(synced.json().results[0].expense.tagIds, [workId]);

  const foreign = await app.inject({ method: "GET", url: `/api/workspaces/${otherWorkspaceId}/expenses?tagId=${foodId}`, headers: stranger.headers });
  assert.deepEqual(foreign.json().expenses, [], "tags never leak across workspaces");
  const crossWorkspaceTag = await app.inject({ method: "POST", url: `/api/workspaces/${otherWorkspaceId}/expenses`, headers: stranger.headers, payload: { ...base, id: randomUUID(), tagIds: [foodId] } });
  assert.equal(crossWorkspaceTag.statusCode, 400, crossWorkspaceTag.body);

  const removed = await api("DELETE", `/tags/${foodId}`, { version: 1 });
  assert.equal(removed.statusCode, 204, removed.body);
  const afterDelete = await api("GET", `/expenses/${expenseId}`);
  assert.deepEqual(afterDelete.json().tagIds, [], "deleting a tag only detaches it");
  assert.equal(afterDelete.json().note, "обед");
});
