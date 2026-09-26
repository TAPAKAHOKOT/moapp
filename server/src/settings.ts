import type { Database } from "better-sqlite3";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hasWorkspaceMembership, noStore, requireMutationOrigin, sendWorkspaceNotFound, workspaceContext } from "./tenant-domain-guard.js";
import { isCalendarDate, jsonError, normalizeCurrencyCode } from "./validation.js";

/*
 * Личные настройки: как выглядит приложение у человека и что оно за ним запоминает. Видит и меняет их только
 * он сам. Живут они в аккаунте, поэтому переезжают на новый телефон и переживают выход. Настройки бывают
 * общими для всех пространств человека (тема) и своими в каждом пространстве (валюты, фильтры истории, плитки);
 * вторые исчезают вместе с участием в пространстве. Какие ключи бывают и что в них можно положить — в каталогах
 * ниже. Незнакомый ключ — ошибка, `null` — возврат к значению по умолчанию.
 */

/** Возвращает приведённое значение или `undefined`, если такое значение в настройке лежать не может. */
type Normalize = (value: unknown) => unknown;

const MAX_VALUE_LENGTH = 8192;
const MAX_KEYS_PER_CHANGE = 20;
const HISTORY_PERIODS = ["all", "today", "this-week", "this-month", "range"];

const oneOf = (...allowed: string[]): Normalize => (value) => typeof value === "string" && allowed.includes(value) ? value : undefined;

/* Внешний вид: тема, свой цвет интерфейса и размер текста. Палитры цветов живут в клиенте (appearance.ts). */
const ACCOUNT_SETTINGS: Readonly<Record<string, Normalize>> = {
  theme: oneOf("system", "light", "dark"),
  accent: oneOf("sage", "terracotta", "sand", "blue", "lilac", "graphite"),
  textSize: oneOf("normal", "large")
};

function idList(value: unknown, valid: (item: string) => boolean, max = 50): string[] | undefined {
  if (!Array.isArray(value) || value.length > max) return undefined;
  if (!value.every((item) => typeof item === "string" && valid(item))) return undefined;
  return [...new Set(value as string[])];
}

const isId = (item: string) => item.length >= 1 && item.length <= 100;

/* Фильтры истории — без строки поиска: поиск разовый, его незачем помнить на другом телефоне. */
function historyFilters(value: unknown) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const fields = ["period", "from", "to", "categoryIds", "tagIds", "currencies"];
  if (Object.keys(input).some((key) => !fields.includes(key))) return undefined;
  if (typeof input.period !== "string" || !HISTORY_PERIODS.includes(input.period)) return undefined;
  const date = (item: unknown) => item === "" || isCalendarDate(item);
  if (!date(input.from) || !date(input.to)) return undefined;
  const categoryIds = idList(input.categoryIds, isId);
  const tagIds = idList(input.tagIds, isId);
  const currencies = idList(input.currencies, (item) => normalizeCurrencyCode(item) === item);
  if (!categoryIds || !tagIds || !currencies) return undefined;
  return { period: input.period, from: input.from, to: input.to, categoryIds, tagIds, currencies };
}

/*
 * Что человек видит на экране «Расход»: `shown` — плитки категорий или теги в ряду, по порядку, `more` — остальное
 * за «Ещё», тоже по порядку. Категории и теги общие, поэтому ссылка на удалённую не ошибка: клиент её пропускает,
 * а то, чего нет ни в одном списке (например, созданное другим участником), ставит в конец «Ещё».
 */
function screenOrder(value: unknown) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "shown" && key !== "more")) return undefined;
  const shown = idList(input.shown, isId, 20);
  const more = idList(input.more, isId, 100);
  if (!shown || !more || shown.some((id) => more.includes(id))) return undefined;
  return { shown, more };
}

const MEMBER_SETTINGS: Readonly<Record<string, Normalize>> = {
  lastCurrency: normalizeCurrencyCode,
  analyticsCurrency: normalizeCurrencyCode,
  historyFilters,
  categoryOrder: screenOrder,
  tagOrder: screenOrder
};

type SettingRow = { key: string; value_json: string };

/* Строки, чьи ключи пропали из каталога, не отдаются: клиент видит только то, что сервер ещё понимает. */
function settingsFromRows(rows: SettingRow[], catalog: Readonly<Record<string, Normalize>>): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const row of rows) if (Object.hasOwn(catalog, row.key)) settings[row.key] = JSON.parse(row.value_json) as unknown;
  return settings;
}

export function readUserSettings(db: Database, userId: string): Record<string, unknown> {
  return settingsFromRows(db.prepare("SELECT key,value_json FROM user_settings WHERE user_id=?").all(userId) as SettingRow[], ACCOUNT_SETTINGS);
}

export function readMemberSettings(db: Database, workspaceId: string, userId: string): Record<string, unknown> {
  return settingsFromRows(db.prepare("SELECT key,value_json FROM member_settings WHERE workspace_id=? AND user_id=?")
    .all(workspaceId, userId) as SettingRow[], MEMBER_SETTINGS);
}

type Change = { key: string; valueJson: string | null };

/* Тело `{settings: {ключ: значение | null}}` → список изменений, либо ключ, на котором проверка споткнулась. */
function parseChanges(body: unknown, catalog: Readonly<Record<string, Normalize>>): { changes: Change[] } | { invalid: string | null } {
  const settings = (body as { settings?: unknown }).settings;
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return { invalid: null };
  const entries = Object.entries(settings as Record<string, unknown>);
  if (!entries.length || entries.length > MAX_KEYS_PER_CHANGE || Object.keys(body as object).some((key) => key !== "settings")) return { invalid: null };
  const changes: Change[] = [];
  for (const [key, value] of entries) {
    if (!Object.hasOwn(catalog, key)) return { invalid: key };
    if (value === null) { changes.push({ key, valueJson: null }); continue; }
    const normalized = catalog[key]!(value);
    const valueJson = normalized === undefined ? undefined : JSON.stringify(normalized);
    if (valueJson === undefined || valueJson.length > MAX_VALUE_LENGTH) return { invalid: key };
    changes.push({ key, valueJson });
  }
  return { changes };
}

function sendInvalid(reply: FastifyReply, key: string | null) {
  return reply.code(400).send(jsonError("VALIDATION", key ? `Setting ${key} has an invalid value or is unknown` : "Body must be {settings: {...}} with 1-20 keys", key ? { key } : undefined));
}

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  const mutation = (request: FastifyRequest, reply: FastifyReply) => requireMutationOrigin(app, request, reply);

  /* Настройки аккаунта меняются по ключам: что не прислали, остаётся как было. Ответ — все настройки целиком. */
  app.patch("/api/me/settings", { preHandler: [app.requireAuth, mutation], onSend: noStore }, async (request, reply) => {
    const userId = request.auth!.userId;
    const parsed = parseChanges(request.body, ACCOUNT_SETTINGS);
    if ("invalid" in parsed) return sendInvalid(reply, parsed.invalid);
    const now = new Date().toISOString();
    app.db.transaction(() => {
      for (const change of parsed.changes) {
        if (change.valueJson === null) app.db.prepare("DELETE FROM user_settings WHERE user_id=? AND key=?").run(userId, change.key);
        else app.db.prepare(`INSERT INTO user_settings(user_id,key,value_json,updated_at) VALUES (?,?,?,?)
          ON CONFLICT(user_id,key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run(userId, change.key, change.valueJson, now);
      }
    })();
    return { settings: readUserSettings(app.db, userId) };
  });

  /* Настройки человека в одном пространстве: другие участники их не видят и не меняют. */
  app.patch("/api/workspaces/:workspaceId/me/settings", { preHandler: [app.requireWorkspaceMember, mutation], onSend: noStore }, async (request, reply) => {
    const { workspaceId, userId } = workspaceContext(request);
    const parsed = parseChanges(request.body, MEMBER_SETTINGS);
    if ("invalid" in parsed) return sendInvalid(reply, parsed.invalid);
    const now = new Date().toISOString();
    const saved = app.db.transaction(() => {
      if (!hasWorkspaceMembership(app, workspaceId, userId)) return false;
      for (const change of parsed.changes) {
        if (change.valueJson === null) app.db.prepare("DELETE FROM member_settings WHERE workspace_id=? AND user_id=? AND key=?").run(workspaceId, userId, change.key);
        else app.db.prepare(`INSERT INTO member_settings(workspace_id,user_id,key,value_json,updated_at) VALUES (?,?,?,?,?)
          ON CONFLICT(workspace_id,user_id,key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
          .run(workspaceId, userId, change.key, change.valueJson, now);
      }
      return true;
    })();
    if (!saved) return sendWorkspaceNotFound(reply);
    return { settings: readMemberSettings(app.db, workspaceId, userId) };
  });
}
