import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { registerCardQueueRoutes } from "../src/card-queue.js";
import { registerModRoutes } from "../src/mods.js";
import { parseTbankStatement, registerTbankStatementRoutes, wallTimeToIso } from "../src/tbank-statement.js";
import { registerTenantDomainRoutes } from "../src/tenant-domain.js";
import { buildTestApp, testConfig } from "./test-app.js";

const config = testConfig();
const app = await buildTestApp({ config, plugins: [registerTenantDomainRoutes, registerCardQueueRoutes, registerTbankStatementRoutes, registerModRoutes] });
const origin = { origin: config.appOrigin };
let cookie = "";
let userId = "";
let sessionId = "";
let workspaceId = "";

function contextHeaders() {
  return { cookie, "x-moapp-expected-user-id": userId, "x-moapp-expected-session-id": sessionId };
}

/* Шапка и строки — в точности как в выгрузке tbank.ru сентября 2026: UTF‑8, `;`, всё в кавычках, CRLF. */
const HEADER = ["Имя счёта", "Номер карты", "Дата операции", "Сумма операции", "Валюта операции", "Сумма в валюте счёта", "Валюта счёта",
  "Статус", "Категория по-умолчанию", "Ваша категория", "MCC", "Описание", "Сообщение", "Округление", "Сумма операции с округлением",
  "Бонусы (включая кэшбэк)", "Учёт в аналитике"];

type Line = { card?: string; at: string; amount: string; currency?: string; status?: string; category?: string; mcc?: string; description: string; counted?: string };

function line(item: Line): string[] {
  const currency = item.currency ?? "RUB";
  return ["Black Premium", item.card ?? "*6703", item.at, item.amount, currency, item.amount, "RUB", item.status ?? "Ок",
    item.category ?? "Различные товары", "", item.mcc ?? "", item.description, "", "0,00", item.amount, "0,00", item.counted ?? "Да"];
}

function statement(lines: Line[]): string {
  return [HEADER, ...lines.map(line)].map((cells) => cells.map((value) => `"${value.replace(/"/g, '""')}"`).join(";")).join("\r\n") + "\r\n";
}

const hosting: Line = { at: "01.09.2026 09:05:00", amount: "-2500,00", mcc: "5734", description: "selectel" };
const ownTransfer: Line = { at: "01.09.2026 09:04:55", amount: "2500,00", category: "Переводы", description: "Между своими счетами", counted: "Нет" };
const trains: Line = { at: "20.08.2026 12:55:18", amount: "-10302,60", category: "Ж/д билеты", mcc: "4112", description: "Федеральная пассажирская компания" };
const outgoingOwn: Line = { at: "29.08.2026 16:01:56", amount: "-8700,00", category: "Переводы", description: "Между своими счетами", counted: "Нет" };
const declined: Line = { at: "23.09.2026 17:05:26", amount: "-449,00", status: "Ошибка", category: "Экосистема Яндекс", mcc: "3990", description: "Яндекс Плюс", counted: "Нет" };
const noCard: Line = { card: "", at: "10.09.2026 16:02:55", amount: "-10,00", category: "Связь", mcc: "4816", description: "vpn.example" };

function upload(csv: string, timeZone = "Europe/Belgrade", headers: Record<string, string> = { ...origin, ...contextHeaders() }) {
  return app.inject({
    method: "POST", url: `/api/workspaces/${workspaceId}/integrations/tbank/statement`, headers, payload: { csv, timeZone }
  });
}

async function queue() {
  const response = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/integrations/card-queue/transactions`, headers: contextHeaders() });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as { transactions: Array<Record<string, unknown>>; pendingCount: number };
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
  const mod = await app.inject({ method: "PUT", url: `/api/workspaces/${workspaceId}/mods/tbank`, headers: { ...origin, ...contextHeaders() }, payload: {} });
  assert.equal(mod.statusCode, 200, mod.body);
});

after(async () => app.close());

test("the statement parser reads the real export by column names and skips unreadable rows", () => {
  const csv = `﻿${statement([hosting, ownTransfer])}"Black Premium";"*6703";"not a date";"-1,00";"RUB";"-1,00";"RUB";"Ок";"";"";"";"x";"";"0,00";"-1,00";"0,00";"Да"\r\n`;
  const parsed = parseTbankStatement(csv);
  assert.ok(!("error" in parsed));
  assert.equal(parsed.skipped, 1);
  assert.deepEqual(parsed.rows.map((row) => [row.wall, row.outflow, row.amountMinor, row.currency, row.status, row.counted, row.mcc, row.description]), [
    ["2026-09-01T09:05:00", true, 250000, "RUB", "ok", true, "5734", "selectel"],
    ["2026-09-01T09:04:55", false, 250000, "RUB", "ok", false, null, "Между своими счетами"]
  ]);
  const reordered = parseTbankStatement(`"Описание";"Статус";"Валюта операции";"Сумма операции";"Дата операции"\n"Кафе";"OK";"eur";"-12,5";"02.09.2026 10:00"\n`);
  assert.ok(!("error" in reordered));
  assert.deepEqual(reordered.rows.map((row) => [row.wall, row.amountMinor, row.currency, row.card, row.counted]), [["2026-09-02T10:00:00", 1250, "EUR", "", true]]);
  assert.ok("error" in parseTbankStatement("Date,Amount\n2026-09-01,-10\n"), "a foreign file is refused, not half-imported");
});

test("statement times are read in the uploading device's time zone", () => {
  assert.equal(wallTimeToIso("2026-09-23T17:05:26", "Europe/Belgrade"), "2026-09-23T15:05:26.000Z");
  assert.equal(wallTimeToIso("2026-12-01T10:00:00", "Europe/Belgrade"), "2026-12-01T09:00:00.000Z");
  assert.equal(wallTimeToIso("2026-09-23T17:05:26", "Europe/Moscow"), "2026-09-23T14:05:26.000Z");
  assert.equal(wallTimeToIso("2026-03-29T03:30:00", "Europe/Belgrade"), "2026-03-29T01:30:00.000Z", "the hour after the spring jump");
});

test("only counted card spending enters the queue, in the purchase currency", async () => {
  const first = await upload(statement([declined, noCard, hosting, ownTransfer, outgoingOwn, trains]));
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(first.json(), { imported: 3, known: 0, skipped: 0, pendingCount: 3 });
  const { transactions } = await queue();
  assert.deepEqual(transactions.map((item) => [item.source, item.merchantName, item.amountMinor, item.currency, item.mccCode, item.merchantCategory, item.occurredAt, item.settled]), [
    ["tbank", "Федеральная пассажирская компания", 1030260, "RUB", "4112", "Ж/д билеты", "2026-08-20T10:55:18.000Z", true],
    ["tbank", "selectel", 250000, "RUB", "5734", "Различные товары", "2026-09-01T07:05:00.000Z", true],
    ["tbank", "vpn.example", 1000, "RUB", "4816", "Связь", "2026-09-10T14:02:55.000Z", true]
  ]);
});

test("an overlapping statement adds only what is new", async () => {
  const later: Line = { at: "24.09.2026 08:15:00", amount: "-275,00", mcc: "3990", description: "Бери заряд" };
  const again = await upload(statement([later, declined, noCard, hosting, ownTransfer]));
  assert.equal(again.statusCode, 200, again.body);
  assert.deepEqual(again.json(), { imported: 1, known: 2, skipped: 0, pendingCount: 4 });
  const same = await upload(statement([later, declined, noCard, hosting, ownTransfer, outgoingOwn, trains]));
  assert.deepEqual(same.json(), { imported: 0, known: 4, skipped: 0, pendingCount: 4 });
  assert.equal((app.db.prepare("SELECT count(*) count FROM card_transactions WHERE workspace_id=? AND source='tbank'").get(workspaceId) as { count: number }).count, 4,
    "transfers between own accounts and declined operations are never stored");
});

test("identical rows are separate operations and stay separate on the next upload", async () => {
  const metro: Line = { at: "05.09.2026 08:00:01", amount: "-60,00", category: "Транспорт", mcc: "4111", description: "Метро" };
  const twice = await upload(statement([metro, metro]));
  assert.deepEqual(twice.json(), { imported: 2, known: 0, skipped: 0, pendingCount: 6 });
  const overlap = await upload(statement([metro, metro, hosting]));
  assert.deepEqual(overlap.json(), { imported: 0, known: 3, skipped: 0, pendingCount: 6 });
});

test("a statement exported in another time zone does not duplicate operations", async () => {
  /* Та же выгрузка с компьютера, переставленного на час вперёд: все времена сдвинулись, операции те же. */
  const shift = (item: Line): Line => {
    const [date, time] = item.at.split(" ") as [string, string];
    const [hour, rest] = [Number(time.slice(0, 2)), time.slice(2)];
    return { ...item, at: `${date} ${String(hour + 1).padStart(2, "0")}${rest}` };
  };
  const moved = await upload(statement([shift(noCard), shift(hosting), shift(trains)]), "Europe/Moscow");
  assert.deepEqual(moved.json(), { imported: 0, known: 3, skipped: 0, pendingCount: 6 });
  /* А две настоящие покупки из одного файла, ровно через час одна от другой, остаются двумя. */
  const coffee: Line = { at: "12.09.2026 09:10:11", amount: "-250,00", mcc: "5814", description: "Кофейня" };
  const both = await upload(statement([coffee, shift(coffee)]));
  assert.deepEqual(both.json(), { imported: 2, known: 0, skipped: 0, pendingCount: 8 });
});

test("a recorded operation that later fails leaves the totals but stays in history", async () => {
  const pending = (await queue()).transactions.find((item) => item.merchantName === "selectel")!;
  const classified = await app.inject({
    method: "POST", url: `/api/workspaces/${workspaceId}/integrations/card-queue/transactions/${pending.id}/classify`,
    headers: { ...origin, ...contextHeaders() }, payload: { categoryId: "products", comment: "сервер" }
  });
  assert.equal(classified.statusCode, 200, classified.body);
  assert.equal(classified.json().expense.currency, "RUB");
  assert.equal(classified.json().expense.note, "selectel · сервер");
  const failed = await upload(statement([{ ...hosting, status: "Ошибка", counted: "Нет" }]));
  assert.deepEqual(failed.json(), { imported: 0, known: 1, skipped: 0, pendingCount: 7 });
  const expense = app.db.prepare("SELECT voided_at,void_reason FROM expenses WHERE workspace_id=? AND id=?")
    .get(workspaceId, classified.json().expense.id) as { voided_at: string | null; void_reason: string };
  assert.ok(expense.voided_at);
  assert.deepEqual(JSON.parse(expense.void_reason), { provider: "tbank", kind: "declined", txnId: null, merchantName: "selectel", amountMinor: 250000, currency: "RUB" });
  const status = await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/integrations/card-queue`, headers: contextHeaders() });
  assert.deepEqual(status.json(), { pendingCount: 7 });
});

test("a pending bank status is reviewable and settles on the next upload", async () => {
  const hold: Line = { at: "15.09.2026 20:00:00", amount: "-1200,00", status: "В обработке", mcc: "5812", description: "Ресторан" };
  await upload(statement([hold]));
  const queued = (await queue()).transactions.find((item) => item.merchantName === "Ресторан")!;
  assert.equal(queued.settled, false);
  await upload(statement([{ ...hold, status: "Ок" }]));
  assert.equal((await queue()).transactions.find((item) => item.id === queued.id)!.settled, true);
});

test("the upload refuses foreign files, other workspaces and cross-site requests", async () => {
  const foreign = await upload("Date,Amount\n2026-09-01,-10\n");
  assert.equal(foreign.statusCode, 422, foreign.body);
  assert.equal(foreign.json().error.code, "TBANK_STATEMENT_INVALID");
  const empty = await upload("");
  assert.equal(empty.statusCode, 400, empty.body);
  const crossSite = await upload(statement([hosting]), "Europe/Belgrade", { origin: "https://evil.example", ...contextHeaders() });
  assert.equal(crossSite.statusCode, 403, crossSite.body);
  const stranger = await app.inject({
    method: "POST", url: `/api/workspaces/${randomUUID()}/integrations/tbank/statement`,
    headers: { ...origin, ...contextHeaders() }, payload: { csv: statement([hosting]), timeZone: "Europe/Belgrade" }
  });
  assert.equal(stranger.statusCode, 404, stranger.body);
});
