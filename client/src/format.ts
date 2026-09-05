import type { Currency, Expense, WorkspaceBootstrap } from './types'
import { cachedDateTimeFormat, cachedNumberFormat, isoToLocalInput } from './utils'

export type Bootstrap = WorkspaceBootstrap

export function pluralRu(count: number, forms: [string, string, string]) {
  const tail = count % 100
  if (tail >= 11 && tail <= 19) return forms[2]
  const last = tail % 10
  return last === 1 ? forms[0] : last >= 2 && last <= 4 ? forms[1] : forms[2]
}

export function localInputParts(localInput: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(localInput)
  if (!match) return null
  const [, year, month, day, hour, minute] = match
  const date = new Date(`${year}-${month}-${day}T12:00:00Z`)
  return { year, hour, minute, date }
}

export function formatShortWeekday(localInput: string) {
  const parts = localInputParts(localInput)
  return parts ? cachedDateTimeFormat('ru-RU', { weekday: 'short', timeZone: 'UTC' }).format(parts.date) : ''
}

export function formatEntryDate(localInput: string) {
  const parts = localInputParts(localInput)
  if (!parts) return ''
  const calendarDate = cachedDateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(parts.date)
  return `${formatShortWeekday(localInput)} · ${calendarDate} ${parts.year}, ${parts.hour}:${parts.minute}`
}

export function formatShortDate(dateKey: string) {
  return cachedDateTimeFormat('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${dateKey}T12:00:00Z`)).replace(' г.', '')
}

// Диапазон дат для чипа фильтра: «3–5 сент.», «28 авг. – 5 сент.», и только через год — с годами.
export function formatDateRange(from: string, to: string) {
  if (from === to) return formatShortDate(from)
  const day = (key: string) => Number(key.slice(8))
  const month = (key: string) => cachedDateTimeFormat('ru-RU', { timeZone: 'UTC', month: 'short' }).format(new Date(`${key}T12:00:00Z`))
  if (from.slice(0, 7) === to.slice(0, 7)) return `${day(from)}–${day(to)} ${month(to)}`
  if (from.slice(0, 4) === to.slice(0, 4)) return `${day(from)} ${month(from)} – ${day(to)} ${month(to)}`
  return `${formatShortDate(from)} – ${formatShortDate(to)}`
}

export function formatHistoryDate(dateKey: string) {
  const localInput = `${dateKey}T12:00`
  const parts = localInputParts(localInput)
  if (!parts) return ''
  const calendarDate = cachedDateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(parts.date)
  return `${formatShortWeekday(localInput)} · ${calendarDate} ${parts.year}`
}

// Крупные суммы иначе упираются в многоточие: шрифт ступенчато уменьшается по числу цифр.
// Общая функция для карточки расхода и для строки суммы разбора — пороги должны совпадать.
export function amountSize(amount: string) {
  const digits = amount.replace(/\D/g, '').length
  return digits > 10 ? 'long' : digits > 7 ? 'medium' : 'normal'
}

export function money(amountMinor: number, currency: string, currencies: Currency[]) {
  const decimals = currencies.find((item) => item.code === currency)?.decimals ?? 2
  return cachedNumberFormat('ru-RU', { style: 'currency', currency, maximumFractionDigits: decimals }).format(amountMinor / 10 ** decimals)
}

export function amountNumber(amountMinor: number, currency: string, currencies: Currency[]) {
  const decimals = currencies.find((item) => item.code === currency)?.decimals ?? 2
  return cachedNumberFormat('ru-RU', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(amountMinor / 10 ** decimals)
}

export function inputFromExpense(expense: Expense, currencies: Currency[]) {
  const decimals = currencies.find((item) => item.code === expense.currency)?.decimals ?? 2
  return {
    amount: String(expense.amountMinor / 10 ** decimals),
    currency: expense.currency,
    note: expense.note || '',
    occurredAt: isoToLocalInput(expense.occurredAt),
    tagIds: [...(expense.tagIds ?? [])].sort(),
    categoryId: expense.categoryId,
  }
}

export function formatAnalyticsAmount(value:number,currency:string) {
  return `${cachedNumberFormat('ru-RU',{maximumFractionDigits:0}).format(value)} ${currency}`
}

export function formatCompactNumber(value:number) {
  return cachedNumberFormat('ru-RU',{notation:'compact',maximumFractionDigits:1}).format(value)
}

export function formatWeekRange(from:string,to:string) {
  const start=new Date(`${from}T12:00:00Z`),end=new Date(`${to}T12:00:00Z`)
  const sameMonth=start.getUTCFullYear()===end.getUTCFullYear()&&start.getUTCMonth()===end.getUTCMonth()
  const startLabel=start.toLocaleDateString('ru-RU',{timeZone:'UTC',day:'numeric',...(sameMonth?{}:{month:'short'})}).replace('.','')
  const endLabel=end.toLocaleDateString('ru-RU',{timeZone:'UTC',day:'numeric',month:sameMonth?'long':'short'}).replace('.','')
  return `${startLabel}–${endLabel}`
}

// «Ссылка действует 3 дня» вместо даты с секундами.
export function formatLinkLifetime(expiresAt: string) {
  const hours = Math.round((Date.parse(expiresAt) - Date.now()) / 3_600_000)
  if (hours >= 47) { const days = Math.round(hours / 24); return `Ссылка действует ${days} ${pluralRu(days, ['день', 'дня', 'дней'])}` }
  if (hours >= 1) return `Ссылка действует ${hours} ${pluralRu(hours, ['час', 'часа', 'часов'])}`
  return 'Ссылка действует меньше часа'
}

export function formatRelativeTime(iso: string) {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  if (minutes < 1) return 'только что'
  if (minutes < 60) return `${minutes} ${pluralRu(minutes, ['минуту', 'минуты', 'минут'])} назад`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} ${pluralRu(hours, ['час', 'часа', 'часов'])} назад`
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
}
