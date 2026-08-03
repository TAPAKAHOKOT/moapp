import type { Currency, Expense, RateSnapshot } from './types'

export const APP_TIME_ZONE = 'Europe/Belgrade'

export function swipeDirection(dx: number) {
  return dx < 0 ? 'older' as const : 'newer' as const
}

export function amountToMinor(value: string, currency: string, currencies: Currency[]) {
  const decimals = currencies.find((item) => item.code === currency)?.decimals ?? 2
  return Math.round(Number(value || 0) * 10 ** decimals)
}

export function applyKeypad(amount: string, key: string, maxDecimals = 2) {
  if (key === '⌫') return amount.slice(0, -1)
  if (key === ',') return amount.includes('.') ? amount : `${amount || '0'}.`
  const fraction = amount.split('.')[1] || ''
  if (fraction.length >= maxDecimals) return amount
  return amount === '0' ? key : `${amount}${key}`
}

export function convertExpense(expense: Expense, target: string, currencies: Currency[], rates: RateSnapshot) {
  const decimals = currencies.find((item) => item.code === expense.currency)?.decimals ?? 2
  const sourceRate = rates.ratesToRsd[expense.currency] ?? (expense.currency === 'RSD' ? 1 : 0)
  const targetRate = rates.ratesToRsd[target] ?? (target === 'RSD' ? 1 : 0)
  return targetRate ? expense.amountMinor / 10 ** decimals * sourceRate / targetRate : 0
}

function dateParts(date: Date, timeZone = APP_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date)
  return Object.fromEntries(parts.map((part) => [part.type, part.value])) as Record<string, string>
}

export function isoToLocalInput(iso: string, timeZone = APP_TIME_ZONE) {
  const parts = dateParts(new Date(iso), timeZone)
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}

export function localInputToIso(value: string, timeZone = APP_TIME_ZONE) {
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

export function localDateKey(value: string | Date, timeZone = APP_TIME_ZONE) {
  const parts = dateParts(typeof value === 'string' ? new Date(value) : value, timeZone)
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function weekdayFromDateKey(key: string) {
  return (new Date(`${key}T12:00:00Z`).getUTCDay() + 6) % 7
}
