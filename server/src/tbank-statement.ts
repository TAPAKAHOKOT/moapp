import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DEFAULT_TIME_ZONE, isTimeZone } from "./calendar.js";
import { pendingCount, voidCardTransaction } from "./card-queue.js";
import { hasWorkspaceMembership, noStore, requireMutationOrigin, workspaceContext } from "./tenant-domain-guard.js";
import { isCurrency, jsonError, minorDigits } from "./validation.js";

/*
 * Выписка Т‑Банка. Открытого API для личных карт у банка нет, поэтому человек выгружает операции
 * на tbank.ru в CSV и загружает файл сюда; траты встают в ту же очередь разбора, что и операции Bybit.
 *
 * Номера операции в файле нет, а выгрузки идут внахлёст, поэтому операцию узнают по отпечатку:
 * карта + время до секунды + сумма + валюта, и порядковый номер среди полностью одинаковых строк файла.
 * Описание, имя счёта, сумма в валюте счёта и статус в отпечаток не входят — банк и человек их меняют.
 */

/* Год‑другой операций весит сотни килобайт; запас — на выгрузку за всё время. */
const MAX_STATEMENT_BYTES = 8 * 1024 * 1024;
const MAX_ZONE_SHIFT_MS = 14 * 60 * 60 * 1000;
const ZONE_STEP_MS = 15 * 60 * 1000;

type StatementStatus = "ok" | "pending" | "failed";

export type StatementRow = {
  card: string;
  account: string | null;
  /** Время операции так, как оно записано в файле, без пояса: `2026-09-23T17:05:26`. */
  wall: string;
  outflow: boolean;
  amountMinor: number;
  currency: string;
  status: StatementStatus;
  description: string | null;
  category: string | null;
  mcc: string | null;
  /** «Учёт в аналитике»: «Нет» стоит у переводов между своими счетами и у неуспешных операций. */
  counted: boolean;
  accountAmount: string | null;
  accountCurrency: string | null;
};

/* Колонки ищутся по названию: банк уже менял и порядок, и набор колонок. */
const COLUMNS = {
  wall: ["дата операции"],
  amount: ["сумма операции"],
  currency: ["валюта операции"],
  status: ["статус"],
  description: ["описание"],
  card: ["номер карты"],
  account: ["имя счета"],
  mcc: ["mcc"],
  category: ["категория по-умолчанию", "категория по умолчанию", "категория"],
  counted: ["учет в аналитике"],
  accountAmount: ["сумма в валюте счета"],
  accountCurrency: ["валюта счета"]
} as const;
const REQUIRED_COLUMNS = ["wall", "amount", "currency", "status"] as const;

function headerName(value: string): string {
  return value.replace(/^﻿/, "").trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");
}

function detectDelimiter(text: string): string {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const counts = [";", ",", "\t"].map((delimiter) => [delimiter, firstLine.split(delimiter).length] as const);
  return counts.sort((left, right) => right[1] - left[1])[0]![0];
}

export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = false;
    } else if (char === '"' && field === "") quoted = true;
    else if (char === delimiter) { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((cells) => cells.some((cell) => cell.trim()));
}

function wallTime(value: string): string | null {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const [, day, month, year, hour, minute, second = "00"] = match;
  const wall = `${year}-${month}-${day}T${hour!.padStart(2, "0")}:${minute}:${second}`;
  const ms = Date.parse(`${wall}Z`);
  // 31.02 и 25:00 не превращаются молча в другой день.
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === wall ? wall : null;
}

function signedAmount(value: string): number | null {
  const cleaned = value.replace(/[\s  ]/g, "").replace(/[−–]/g, "-").replace(",", ".");
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const amount = Number(cleaned);
  return Number.isFinite(amount) ? amount : null;
}

function statusOf(value: string): StatementStatus {
  const status = value.trim().toLowerCase();
  if (!status || status === "ок" || status === "ok") return "ok";
  if (/ошибк|отмен|отклон|fail|cancel|declin|reject/.test(status)) return "failed";
  // Что‑то вроде «В обработке»: деньги уже заняты, но банк ещё не списал — как открытая авторизация Bybit.
  return "pending";
}

function cell(value: string | undefined, max = 200): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

export function parseTbankStatement(text: string): { rows: StatementRow[]; skipped: number } | { error: string } {
  const table = parseCsv(text.replace(/^﻿/, ""), detectDelimiter(text));
  const header = table[0]?.map(headerName) ?? [];
  const index = Object.fromEntries(Object.entries(COLUMNS).map(([key, names]) => [
    key, header.findIndex((name) => (names as readonly string[]).includes(name))
  ])) as Record<keyof typeof COLUMNS, number>;
  if (REQUIRED_COLUMNS.some((key) => index[key] < 0)) {
    return { error: "The file is not a T-Bank operations export: date, amount, currency and status columns are required" };
  }
  const rows: StatementRow[] = [];
  let skipped = 0;
  for (const cells of table.slice(1)) {
    const read = (key: keyof typeof COLUMNS) => (index[key] >= 0 ? cells[index[key]] : undefined);
    const wall = wallTime(read("wall") ?? "");
    const amount = signedAmount(read("amount") ?? "");
    const currency = (read("currency") ?? "").trim().toUpperCase();
    if (!wall || amount === null || !isCurrency(currency)) { skipped += 1; continue; }
    const amountMinor = Math.round(Math.abs(amount) * 10 ** minorDigits(currency));
    if (!Number.isSafeInteger(amountMinor)) { skipped += 1; continue; }
    const accountCurrency = (read("accountCurrency") ?? "").trim().toUpperCase();
    rows.push({
      card: cell(read("card"), 20) ?? "",
      account: cell(read("account"), 100),
      wall,
      outflow: amount < 0,
      amountMinor,
      currency,
      status: statusOf(read("status") ?? ""),
      description: cell(read("description")),
      category: cell(read("category")),
      mcc: cell(read("mcc"), 10),
      counted: (read("counted") ?? "").trim().toLowerCase() !== "нет",
      accountAmount: cell(read("accountAmount"), 30),
      accountCurrency: isCurrency(accountCurrency) ? accountCurrency : null
    });
  }
  return { rows, skipped };
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneOffsetMs(instant: number, timeZone: string): number {
  let formatter = zoneFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
    });
    zoneFormatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map((part) => [part.type, Number(part.value)]));
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour! % 24, parts.minute!, parts.second!) - instant;
}

/* Время в файле — по часам телефона или компьютера, с которого выгружали; переводим его в момент по поясу загрузившего. */
export function wallTimeToIso(wall: string, timeZone: string): string {
  const local = Date.parse(`${wall}Z`);
  const guess = local - zoneOffsetMs(local, timeZone);
  return new Date(local - zoneOffsetMs(guess, timeZone)).toISOString();
}

function fingerprint(row: StatementRow): string {
  return `${row.card || "-"}|${row.wall}|${row.amountMinor}|${row.currency}`;
}

function keyParts(externalKey: string): { card: string; wall: string } | null {
  const [card, wall] = externalKey.split("#", 1)[0]!.split("|");
  return card && wall ? { card, wall } : null;
}

function storedMetadata(row: StatementRow): string {
  return JSON.stringify({
    account: row.account, card: row.card || null, time: row.wall, status: row.status, counted: row.counted,
    accountAmount: row.accountAmount, accountCurrency: row.accountCurrency
  });
}

type ExistingRow = { id: string; external_key: string; provider_status: string };

/*
 * Операции кладутся в очередь одной транзакцией. Строка, чей отпечаток уже есть, только обновляет статус
 * и описание; неуспешная снимает уже записанный расход из итогов; новая трата встаёт в очередь.
 * Поступления и строки, которые банк сам не считает тратами («Учёт в аналитике: Нет»), не сохраняются.
 */
export function importTbankStatement(app: FastifyInstance, workspaceId: string, rows: StatementRow[], timeZone: string): { imported: number; known: number } {
  const now = new Date().toISOString();
  const occurrences = new Map<string, number>();
  const keyed = rows.filter((row) => row.outflow && row.amountMinor > 0).map((row) => {
    const base = fingerprint(row);
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    return { row, key: `${base}#${occurrence}`, occurredAt: wallTimeToIso(row.wall, timeZone) };
  });
  const fileKeys = new Set(keyed.map((item) => item.key));
  const claimed = new Set<string>();
  const exact = app.db.prepare(`SELECT id,external_key,provider_status FROM card_transactions
    WHERE workspace_id=? AND source='tbank' AND external_key=?`);
  const nearby = app.db.prepare(`SELECT id,external_key,provider_status FROM card_transactions
    WHERE workspace_id=? AND source='tbank' AND split_of_id IS NULL AND currency=? AND amount_minor=? AND occurred_at BETWEEN ? AND ?
    ORDER BY occurred_at,external_key`);
  const insert = app.db.prepare(`INSERT INTO card_transactions
    (id,workspace_id,source,connection_id,external_key,txn_id,order_no,side,trade_status,provider_status,amount_minor,currency,
      merchant_name,merchant_country,merchant_city,mcc_code,merchant_category,occurred_at,review_status,expense_id,raw_json,created_at,updated_at)
    VALUES (?,?,'tbank',NULL,?,NULL,NULL,'debit',?,'1',?,?,?,NULL,NULL,?,?,?,'pending',NULL,?,?,?)`);
  const refresh = app.db.prepare(`UPDATE card_transactions SET trade_status=?,merchant_name=?,mcc_code=?,merchant_category=?,raw_json=?,updated_at=?
    WHERE id=?`);
  /*
   * Если компьютер, с которого выгружали, сменил часовой пояс, та же операция приходит со сдвигом на целые
   * часы (или четверти часа). Её узнают по той же карте, сумме и секундам, но только если прежнего ключа
   * в этом файле нет — две настоящие операции из одного файла друг друга не поглотят.
   */
  const shifted = (row: StatementRow, occurredAt: string): ExistingRow | undefined => {
    const at = Date.parse(occurredAt);
    // Момент прежней строки считался по поясу её загрузки, поэтому окно поиска вдвое шире самого сдвига.
    const candidates = nearby.all(workspaceId, row.currency, row.amountMinor,
      new Date(at - 2 * MAX_ZONE_SHIFT_MS).toISOString(), new Date(at + 2 * MAX_ZONE_SHIFT_MS).toISOString()) as ExistingRow[];
    return candidates.find((candidate) => {
      if (claimed.has(candidate.id) || fileKeys.has(candidate.external_key)) return false;
      const parts = keyParts(candidate.external_key);
      if (!parts || parts.card !== (row.card || "-")) return false;
      const shift = Date.parse(`${parts.wall}Z`) - Date.parse(`${row.wall}Z`);
      return shift !== 0 && Math.abs(shift) <= MAX_ZONE_SHIFT_MS && shift % ZONE_STEP_MS === 0;
    });
  };
  let imported = 0;
  let known = 0;
  for (const { row, key, occurredAt } of keyed) {
    const existing = (exact.get(workspaceId, key) as ExistingRow | undefined) ?? shifted(row, occurredAt);
    if (existing) {
      claimed.add(existing.id);
      known += 1;
      if (existing.provider_status === "2") continue;
      if (row.status === "failed") {
        voidCardTransaction(app, workspaceId, "tbank", existing.external_key,
          { tradeStatus: "2", providerStatus: "2", rawJson: storedMetadata(row), kind: "declined" }, now);
      } else {
        refresh.run(row.status === "ok" ? "1" : "0", row.description, row.mcc, row.category, storedMetadata(row), now, existing.id);
      }
      continue;
    }
    if (row.status === "failed" || !row.counted) continue;
    insert.run(
      randomUUID(), workspaceId, key, row.status === "ok" ? "1" : "0", row.amountMinor, row.currency, row.description,
      row.mcc, row.category, occurredAt, storedMetadata(row), now, now
    );
    imported += 1;
  }
  return { imported, known };
}

function fail(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send(jsonError(code, message));
}

export async function registerTbankStatementRoutes(app: FastifyInstance): Promise<void> {
  const mutation = (request: FastifyRequest, reply: FastifyReply) => requireMutationOrigin(app, request, reply);
  app.post("/api/workspaces/:workspaceId/integrations/tbank/statement", {
    bodyLimit: MAX_STATEMENT_BYTES, preHandler: [app.requireWorkspaceMember, mutation], onSend: noStore
  }, async (request, reply) => {
    const { workspaceId, userId } = workspaceContext(request);
    const body = (request.body ?? {}) as { csv?: unknown; timeZone?: unknown };
    if (typeof body.csv !== "string" || !body.csv.trim()) return fail(reply, 400, "VALIDATION", "csv is required");
    const timeZone = isTimeZone(body.timeZone) ? body.timeZone : DEFAULT_TIME_ZONE;
    const parsed = parseTbankStatement(body.csv);
    if ("error" in parsed) return fail(reply, 422, "TBANK_STATEMENT_INVALID", parsed.error);
    const result = app.db.transaction(() => (
      hasWorkspaceMembership(app, workspaceId, userId) ? importTbankStatement(app, workspaceId, parsed.rows, timeZone) : null
    ))();
    if (!result) return fail(reply, 404, "NOT_FOUND", "Workspace not found");
    return { ...result, skipped: parsed.skipped, pendingCount: pendingCount(app, workspaceId) };
  });
}
