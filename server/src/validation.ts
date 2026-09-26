export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isCurrency(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) return false;
  try { return Intl.supportedValuesOf("currency").includes(value); } catch { return true; }
}

export function normalizeCurrencyCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const code = value.trim().toUpperCase();
  return isCurrency(code) ? code : undefined;
}

export function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/**
 * Validates a calendar date without accepting JavaScript's overflow dates
 * (for example, 2026-02-30 becoming a date in March).
 */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

export function minorDigits(currency: string): number {
  return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

/*
 * Невидимые и управляющие символы в именах запрещены: ими прячут текст и подделывают одинаковые на вид имена.
 * Исключение — внутри эмодзи: соединитель U+200D склеивает 🧑‍🍳 из двух картинок, а теговые символы собирают флаги
 * вроде 🏴󠁧󠁢󠁳󠁣󠁴󠁿. Поэтому эмодзи из списка Unicode (RGI) сначала вырезаются, а проверяется остаток.
 * Флаг `v` задан строкой: литерал с ним TypeScript пропускает только для ES2024.
 */
const RGI_EMOJI = new RegExp("\\p{RGI_Emoji}", "gv");
const SINGLE_EMOJI = new RegExp("^\\p{RGI_Emoji}$", "v");
const HIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}]/u;

export function hasHiddenCharacters(name: string): boolean {
  return HIDDEN_CHARACTERS.test(name.replace(RGI_EMOJI, ""));
}

/** Значок — ровно один эмодзи. Сердце с клавиатуры Mac приходит без U+FE0F и без него рисуется буквой: дописываем. */
export function normalizeEmoji(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const emoji = value.trim();
  if (SINGLE_EMOJI.test(emoji)) return emoji;
  return SINGLE_EMOJI.test(`${emoji}️`) ? `${emoji}️` : undefined;
}

export function jsonError(code: string, message: string, details?: unknown) {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}
