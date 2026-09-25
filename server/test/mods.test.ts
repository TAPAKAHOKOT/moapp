import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { registerBybitCardRoutes } from "../src/bybit-card.js";
import { registerCardQueueRoutes } from "../src/card-queue.js";
import { registerModRoutes } from "../src/mods.js";
import { registerTbankStatementRoutes } from "../src/tbank-statement.js";
import { buildTestApp, testConfig } from "./test-app.js";

const config = testConfig();
const origin = { origin: config.appOrigin };
let bybitCalls = 0;

function bybitResponse(result: unknown): Response {
  return new Response(JSON.stringify({ retCode: 0, retMsg: "OK", result }), { status: 200, headers: { "content-type": "application/json" } });
}

/* Bybit с ключом только для чтения: на каждый запрос ленты — одна новая покупка в конце окна. */
const bybitFetch: typeof fetch = async (input, init) => {
  bybitCalls += 1;
  if (String(input).endsWith("/v5/user/query-api")) return bybitResponse({ readOnly: 1, permissions: { BitCard: ["BitCard"] } });
  const window = JSON.parse(String(init?.body)) as { createEndTime: number };
  return bybitResponse({
    pageSize: 100, totalCount: 1,
    data: [{ side: "1", tradeStatus: "1", status: "1", paidAmount: "1500", paidCurrency: "RSD", txnCreate: String(window.createEndTime),
      merchName: `Shop ${bybitCalls}`, txnId: `operation-${bybitCalls}` }]
  });
};

const app = await buildTestApp({
  config,
  plugins: [registerCardQueueRoutes, (instance) => registerBybitCardRoutes(instance, { fetch: bybitFetch }), registerTbankStatementRoutes, registerModRoutes]
});
after(async () => app.close());

type Person = { userId: string; headers: Record<string, string> };
let address = 0;

async function person(displayName: string): Promise<Person> {
  address += 1;
  const response = await app.inject({ method: "POST", url: "/api/identity", headers: { ...origin, "x-forwarded-for": `198.51.100.${address}` }, payload: { displayName } });
  assert.equal(response.statusCode, 201, response.body);
  const session = response.json() as { user: { id: string }; currentSessionId: string };
  const cookie = String(response.headers["set-cookie"]).split(";", 1)[0]!;
  return { userId: session.user.id, headers: { cookie, "x-moapp-expected-user-id": session.user.id, "x-moapp-expected-session-id": session.currentSessionId } };
}

const owner = await person("Owner");
const member = await person("Member");

/* Пространство владельца, куда второй человек уже вошёл по приглашению. */
async function sharedWorkspace(): Promise<string> {
  const id = randomUUID();
  const created = await app.inject({ method: "POST", url: "/api/workspaces", headers: { ...origin, ...owner.headers }, payload: { id, name: "Home" } });
  assert.equal(created.statusCode, 201, created.body);
  app.db.prepare("INSERT INTO memberships(workspace_id,user_id,joined_at,added_by_user_id) VALUES (?,?,?,?)")
    .run(id, member.userId, new Date().toISOString(), owner.userId);
  return id;
}

function call(who: Person, method: "GET" | "PUT" | "POST" | "DELETE", url: string, payload?: Record<string, unknown>) {
  return app.inject({ method, url, headers: method === "GET" ? who.headers : { ...origin, ...who.headers }, ...(payload ? { payload } : {}) });
}

type ModEntry = { id: string; added: boolean; addedAt: string | null; state?: Record<string, unknown> };
const entry = (response: { json: () => unknown }, id: string) => (response.json() as { mods: ModEntry[] }).mods.find((mod) => mod.id === id)!;
const pendingCount = async (workspaceId: string) =>
  (await call(owner, "GET", `/api/workspaces/${workspaceId}/integrations/card-queue`)).json().pendingCount as number;

const statement = [
  ["Имя счёта", "Номер карты", "Дата операции", "Сумма операции", "Валюта операции", "Статус", "Описание", "Учёт в аналитике"],
  ["Black", "*6703", "01.09.2026 09:05:00", "-2500,00", "RUB", "Ок", "selectel", "Да"]
].map((cells) => cells.map((value) => `"${value}"`).join(";")).join("\r\n");

const workspaceId = await sharedWorkspace();

test("the catalog lists every mod, and any member adds or removes one", async () => {
  const listed = await call(member, "GET", `/api/workspaces/${workspaceId}/mods`);
  assert.equal(listed.statusCode, 200, listed.body);
  assert.deepEqual((listed.json().mods as ModEntry[]).map((mod) => [mod.id, mod.added, mod.addedAt]), [["bybit-card", false, null], ["tbank", false, null]]);

  const added = await call(member, "PUT", `/api/workspaces/${workspaceId}/mods/tbank`, {});
  assert.equal(added.statusCode, 200, added.body);
  const addedAt = entry(added, "tbank").addedAt;
  assert.ok(addedAt, "a member adds a mod without asking the owner");
  assert.equal(app.db.prepare("SELECT added_by_user_id FROM workspace_mods WHERE workspace_id=? AND mod_id='tbank'").pluck().get(workspaceId), member.userId);
  const again = await call(owner, "PUT", `/api/workspaces/${workspaceId}/mods/tbank`, {});
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(entry(again, "tbank").addedAt, addedAt, "adding twice keeps the first date");

  const unknown = await call(member, "PUT", `/api/workspaces/${workspaceId}/mods/zenmoney`, {});
  assert.equal(unknown.statusCode, 404, unknown.body);
  assert.equal(unknown.json().error.code, "MOD_NOT_FOUND");
  const crossSite = await app.inject({ method: "PUT", url: `/api/workspaces/${workspaceId}/mods/bybit-card`, headers: { ...member.headers, origin: "https://evil.example" }, payload: {} });
  assert.equal(crossSite.statusCode, 403, crossSite.body);
  const stranger = await call(member, "GET", `/api/workspaces/${randomUUID()}/mods`);
  assert.equal(stranger.statusCode, 404, stranger.body);

  const removed = await call(owner, "DELETE", `/api/workspaces/${workspaceId}/mods/tbank`, {});
  assert.equal(removed.statusCode, 200, removed.body);
  assert.deepEqual(entry(removed, "tbank"), { id: "tbank", added: false, addedAt: null });
  const removedAgain = await call(member, "DELETE", `/api/workspaces/${workspaceId}/mods/tbank`, {});
  assert.equal(removedAgain.statusCode, 200, "removing twice is not an error");
});

test("a statement needs its mod, and removing the mod leaves its operations in review", async () => {
  const upload = () => call(member, "POST", `/api/workspaces/${workspaceId}/integrations/tbank/statement`, { csv: statement, timeZone: "Europe/Belgrade" });
  const refused = await upload();
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(refused.json().error.code, "MOD_NOT_ADDED");

  assert.equal((await call(member, "PUT", `/api/workspaces/${workspaceId}/mods/tbank`, {})).statusCode, 200);
  const first = await upload();
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().imported, 1);

  assert.equal((await call(member, "DELETE", `/api/workspaces/${workspaceId}/mods/tbank`, {})).statusCode, 200);
  assert.equal(await pendingCount(workspaceId), 1, "the unreviewed spending waits for people, not for the mod");
  assert.equal((await upload()).statusCode, 409, "a removed mod takes no new files");

  assert.equal((await call(member, "PUT", `/api/workspaces/${workspaceId}/mods/tbank`, {})).statusCode, 200);
  const repeated = await upload();
  assert.equal(repeated.statusCode, 200, repeated.body);
  assert.deepEqual([repeated.json().imported, repeated.json().known], [0, 1], "the same file does not enter review twice after the mod comes back");
});

test("any member connects Bybit, and removing the mod forgets the key but keeps its operations", async () => {
  const connect = (who: Person, id = workspaceId) => call(who, "POST", `/api/workspaces/${id}/integrations/bybit-card`,
    { apiKey: "read-only-card-key", apiSecret: "super-secret", region: "global" });
  const callsBefore = bybitCalls;
  const refused = await connect(member);
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(refused.json().error.code, "MOD_NOT_ADDED");
  assert.equal(bybitCalls, callsBefore, "the key is not even checked while the mod is missing");

  assert.equal((await call(member, "PUT", `/api/workspaces/${workspaceId}/mods/bybit-card`, {})).statusCode, 200);
  const connected = await connect(member);
  assert.equal(connected.statusCode, 201, connected.body);
  assert.equal(connected.json().connected, true);
  const listed = await call(owner, "GET", `/api/workspaces/${workspaceId}/mods`);
  assert.equal(entry(listed, "bybit-card").state?.connected, true);
  assert.doesNotMatch(listed.body, /read-only-card-key|super-secret|credentials/);
  assert.equal(await pendingCount(workspaceId), 2, "the statement row and the new Bybit purchase");

  const removed = await call(owner, "DELETE", `/api/workspaces/${workspaceId}/mods/bybit-card`, {});
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal(entry(removed, "bybit-card").added, false);
  assert.equal(app.db.prepare("SELECT count(*) FROM bybit_card_connections WHERE workspace_id=?").pluck().get(workspaceId), 0, "the key is gone");
  const status = await call(member, "GET", `/api/workspaces/${workspaceId}/integrations/bybit-card`);
  assert.equal(status.json().connected, false);
  const leftover = app.db.prepare("SELECT id,connection_id,review_status FROM card_transactions WHERE workspace_id=? AND source='bybit-card'")
    .all(workspaceId) as Array<{ id: string; connection_id: string | null; review_status: string }>;
  assert.deepEqual(leftover.map((row) => [row.connection_id, row.review_status]), [[null, "pending"]]);
  assert.equal(await pendingCount(workspaceId), 2);
  const classified = await call(member, "POST", `/api/workspaces/${workspaceId}/integrations/card-queue/transactions/${leftover[0]!.id}/classify`, { categoryId: "products" });
  assert.equal(classified.statusCode, 200, "an operation of a removed mod is still reviewed as usual");
});

test("a member who leaves takes their own Bybit key along, never someone else's", async () => {
  const connect = (who: Person, id: string) => call(who, "POST", `/api/workspaces/${id}/integrations/bybit-card`,
    { apiKey: "read-only-card-key", apiSecret: "super-secret", region: "global" });
  const keys = (id: string) => app.db.prepare("SELECT count(*) FROM bybit_card_connections WHERE workspace_id=?").pluck().get(id);

  const ownersCard = await sharedWorkspace();
  assert.equal((await call(owner, "PUT", `/api/workspaces/${ownersCard}/mods/bybit-card`, {})).statusCode, 200);
  assert.equal((await connect(owner, ownersCard)).statusCode, 201);
  const left = await app.inject({ method: "DELETE", url: `/api/workspaces/${ownersCard}/members/me`, headers: { ...origin, ...member.headers } });
  assert.equal(left.statusCode, 204, left.body);
  assert.equal(keys(ownersCard), 1, "the owner's key stays when someone else leaves");

  for (const departure of ["leaves", "is removed"] as const) {
    const membersCard = await sharedWorkspace();
    assert.equal((await call(member, "PUT", `/api/workspaces/${membersCard}/mods/bybit-card`, {})).statusCode, 200);
    assert.equal((await connect(member, membersCard)).statusCode, 201);
    const gone = departure === "leaves"
      ? await app.inject({ method: "DELETE", url: `/api/workspaces/${membersCard}/members/me`, headers: { ...origin, ...member.headers } })
      : await app.inject({ method: "DELETE", url: `/api/workspaces/${membersCard}/members/${member.userId}`, headers: { ...origin, ...owner.headers } });
    assert.equal(gone.statusCode, 204, gone.body);
    assert.equal(keys(membersCard), 0, `the key goes when the person who inserted it ${departure}`);
    assert.equal(entry(await call(owner, "GET", `/api/workspaces/${membersCard}/mods`), "bybit-card").added, true, "the mod itself stays");
    assert.equal(await pendingCount(membersCard), 1, "purchases already fetched stay in review");
  }
});
