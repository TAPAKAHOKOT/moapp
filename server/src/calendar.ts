// Календарь клиента. Телефон присылает свой часовой пояс (?tz=…), и день покупки, «сегодня» и курс дня считаются
// по нему — так итоги истории на клиенте и аналитика сервера сходятся, где бы человек ни был. Без пояса или с
// неизвестным значением работает календарь по умолчанию.
export const DEFAULT_TIME_ZONE = "Europe/Belgrade";

const known = new Map<string, boolean>();

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-]*(?:\/[A-Za-z0-9_+\-]+){0,3}$/.test(value)) return false;
  let valid = known.get(value);
  if (valid === undefined) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: value }); valid = true; } catch { valid = false; }
    if (known.size > 500) known.clear();
    known.set(value, valid);
  }
  return valid;
}

export function requestTimeZone(value: unknown): string {
  return isTimeZone(value) ? value : DEFAULT_TIME_ZONE;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

export function localDateKey(value: string | Date, timeZone = DEFAULT_TIME_ZONE): string {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(typeof value === "string" ? new Date(value) : value);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

// Начало окна первичной загрузки: первый день месяца на `months` месяцев раньше месяца сегодняшнего дня.
// Более ранние записи клиент подгружает отдельно по запросу.
export function bootstrapWindowStart(today: string, months = 12): string {
  const [year, month] = today.split("-").map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1 - months, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-01`;
}
