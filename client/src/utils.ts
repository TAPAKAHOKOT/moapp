import type { Currency, Expense, RateSnapshot } from './types'

export const DEFAULT_TIME_ZONE = 'Europe/Belgrade'

// Календарь телефона: по нему считаются день покупки, «сегодня» и курс дня. Пояс перечитывается не реже раза в
// секунду, чтобы после переезда или смены часового пояса в настройках всё пересчиталось без перезапуска —
// включая старые записи, которые могут перейти на соседний день.
let zoneCache = { value: '', at: 0 }
export function appTimeZone(): string {
  const now = Date.now()
  if (!zoneCache.value || now - zoneCache.at > 1000) {
    let value = DEFAULT_TIME_ZONE
    try { value = Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIME_ZONE } catch { /* нет Intl — остаёмся на поясе по умолчанию */ }
    zoneCache = { value, at: now }
  }
  return zoneCache.value
}
export const MAX_AMOUNT_INTEGER_DIGITS = 12

const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER)

function validDecimals(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 20) throw new RangeError('Invalid currency decimals')
  return value
}

function amountAsMinor(value: string, decimals: number) {
  const match = /^(\d*)(?:[.,](\d*))?$/.exec(value)
  if (!match || (!match[1] && !match[2])) return null
  const whole = BigInt(match[1] || '0')
  const fraction = match[2] || ''
  const scale = 10n ** BigInt(decimals)
  const paddedFraction = fraction.slice(0, decimals).padEnd(decimals, '0')
  let minor = whole * scale + BigInt(paddedFraction || '0')
  if (fraction.length > decimals && fraction[decimals]! >= '5') minor += 1n
  return minor
}

export function swipeDirection(dx: number) {
  return dx > 0 ? 'older' as const : 'newer' as const
}

export function amountToMinor(value: string, currency: string, currencies: Currency[]) {
  const decimals = validDecimals(currencies.find((item) => item.code === currency)?.decimals ?? 2)
  if (!value) return 0
  const minor = amountAsMinor(value, decimals)
  if (minor === null) return Number.NaN
  if (minor > MAX_SAFE_MINOR) throw new RangeError('Amount exceeds the safe integer limit')
  return Number(minor)
}

export function applyKeypad(amount: string, key: string, maxDecimals = 2) {
  if (key === '⌫') return amount.slice(0, -1)
  const decimals = validDecimals(maxDecimals)
  if (key === ',') return decimals === 0 || amount.includes('.') ? amount : `${amount || '0'}.`
  if (!/^\d$/.test(key)) return amount
  const separator = amount.indexOf('.')
  if (separator >= 0 && amount.length - separator - 1 >= decimals) return amount

  const candidate = amount === '0' ? key : `${amount}${key}`
  const integer = candidate.split('.')[0] || '0'
  if (integer.length > MAX_AMOUNT_INTEGER_DIGITS) return amount
  const minor = amountAsMinor(candidate, decimals)
  return minor !== null && minor <= MAX_SAFE_MINOR ? candidate : amount
}

// Строка ввода хранится с точкой и без разрядов; на экране сумма читается как в истории: «1 250,5».
// Хвост сохраняется как набран («12,» и «12,50»), чтобы клавиатура не переставляла введённое.
export function formatAmountInput(amount: string) {
  if (!amount) return ''
  const [whole, fraction] = amount.split('.')
  const grouped = (whole || '0').replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return fraction === undefined ? grouped : `${grouped},${fraction}`
}

// Курс к динару на день покупки, если сервер прислал его для этого дня; иначе — последний известный. 0 — курса нет.
export function rateToRsd(rates: RateSnapshot, code: string, date?: string) {
  const table = date ? rates.daily?.[date] : undefined
  return table?.[code] ?? rates.ratesToRsd[code] ?? (code === 'RSD' ? 1 : 0)
}

export function hasRate(rates: RateSnapshot, source: string, target: string, date?: string) {
  return source === target || Boolean(rateToRsd(rates, source, date) && rateToRsd(rates, target, date))
}

// История и офлайн-аналитика считают по курсу дня покупки — так же, как сервер, поэтому итоги на экранах совпадают.
export function convertExpense(expense: Expense, target: string, currencies: Currency[], rates: RateSnapshot) {
  const decimals = currencies.find((item) => item.code === expense.currency)?.decimals ?? 2
  if (expense.currency === target) return expense.amountMinor / 10 ** decimals
  const date = localDateKey(expense.occurredAt)
  const sourceRate = rateToRsd(rates, expense.currency, date)
  const targetRate = rateToRsd(rates, target, date)
  return targetRate ? expense.amountMinor / 10 ** decimals * sourceRate / targetRate : 0
}

// Intl formatters are expensive to construct (WebKit: ~0.1 ms each) and the history screen used to build
// thousands per render. Formatters are immutable, so one instance per locale + options serves every call.
const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>()
const numberFormatters = new Map<string, Intl.NumberFormat>()

export function cachedDateTimeFormat(locale: string, options: Intl.DateTimeFormatOptions) {
  const key = `${locale}|${JSON.stringify(options)}`
  let formatter = dateTimeFormatters.get(key)
  if (!formatter) { formatter = new Intl.DateTimeFormat(locale, options); dateTimeFormatters.set(key, formatter) }
  return formatter
}

export function cachedNumberFormat(locale: string, options: Intl.NumberFormatOptions) {
  const key = `${locale}|${JSON.stringify(options)}`
  let formatter = numberFormatters.get(key)
  if (!formatter) { formatter = new Intl.NumberFormat(locale, options); numberFormatters.set(key, formatter) }
  return formatter
}

function dateParts(date: Date, timeZone = appTimeZone()) {
  const parts = cachedDateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date)
  return Object.fromEntries(parts.map((part) => [part.type, part.value])) as Record<string, string>
}

export function isoToLocalInput(iso: string, timeZone = appTimeZone()) {
  const parts = dateParts(new Date(iso), timeZone)
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}

export function localInputToIso(value: string, timeZone = appTimeZone()) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!match) throw new Error('Invalid local date and time')
  const [, year, month, day, hour, minute] = match.map(Number)
  const wallUtc = Date.UTC(year!, month! - 1, day, hour, minute)
  let guess = wallUtc
  for (let index = 0; index < 2; index++) {
    const parts = dateParts(new Date(guess), timeZone)
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute))
    guess += wallUtc - represented
  }
  return new Date(guess).toISOString()
}

export function localDateKey(value: string | Date, timeZone = appTimeZone()) {
  const parts = dateParts(typeof value === 'string' ? new Date(value) : value, timeZone)
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function weekdayFromDateKey(key: string) {
  return (new Date(`${key}T12:00:00Z`).getUTCDay() + 6) % 7
}

export function shiftDateKey(key: string, days: number) {
  const date = new Date(`${key}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function startOfWeekDateKey(key: string) {
  return shiftDateKey(key, -weekdayFromDateKey(key))
}

export function weekDateRange(key: string, offset = 0) {
  const from = shiftDateKey(startOfWeekDateKey(key), offset * 7)
  return { from, to: shiftDateKey(from, 6) }
}

export function monthDateRange(key: string, offset = 0) {
  const date = new Date(`${key}T12:00:00Z`)
  date.setUTCDate(1)
  date.setUTCMonth(date.getUTCMonth() + offset)
  const from = date.toISOString().slice(0, 10)
  date.setUTCMonth(date.getUTCMonth() + 1)
  return { from, to: shiftDateKey(date.toISOString().slice(0, 10), -1) }
}

export function countCalendarWeekdays(from: string, to: string) {
  const counts = Array.from({ length: 7 }, () => 0)
  for (let date = from; date <= to; date = shiftDateKey(date, 1)) {
    counts[new Date(`${date}T12:00:00Z`).getUTCDay()]!++
  }
  return counts
}
