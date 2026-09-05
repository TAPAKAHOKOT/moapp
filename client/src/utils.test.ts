import { describe, expect, it } from 'vitest'
import { amountToMinor, applyKeypad, convertExpense, countCalendarWeekdays, formatAmountInput, isoToLocalInput, localDateKey, localInputToIso, monthDateRange, shiftDateKey, startOfWeekDateKey, swipeDirection, weekdayFromDateKey, weekDateRange } from './utils'
import type { Currency, Expense } from './types'

const currencies: Currency[] = [
  { code: 'RSD', name: 'Сербский динар', symbol: 'дин.', decimals: 2 },
  { code: 'EUR', name: 'Евро', symbol: '€', decimals: 2 },
  { code: 'KWD', name: 'Кувейтский динар', symbol: 'KWD', decimals: 3 },
  { code: 'CLF', name: 'Унидад де Фоменто', symbol: 'CLF', decimals: 4 },
]

describe('money helpers', () => {
  it('uses integer minor units', () => expect(amountToMinor('12.34', 'EUR', currencies)).toBe(1234))
  it('converts currency decimals without floating-point drift', () => {
    expect(amountToMinor('1.005', 'KWD', currencies)).toBe(1005)
    expect(amountToMinor('1.005', 'EUR', currencies)).toBe(101)
    expect(amountToMinor('12,34', 'EUR', currencies)).toBe(1234)
  })
  it('limits keypad fractional digits for each currency precision', () => {
    expect(applyKeypad('12.34', '5')).toBe('12.34')
    expect(applyKeypad('12.34', '5', 3)).toBe('12.345')
    expect(applyKeypad('12', ',', 0)).toBe('12')
  })
  it('handles decimal comma and backspace predictably', () => {
    expect(applyKeypad('', ',')).toBe('0.')
    expect(applyKeypad('12.', ',')).toBe('12.')
    expect(applyKeypad('0.', '⌫')).toBe('0')
    expect(applyKeypad('0', '⌫')).toBe('')
  })
  it('limits the whole part to twelve digits', () => {
    expect(applyKeypad('99999999999', '9', 2)).toBe('999999999999')
    expect(applyKeypad('999999999999', '9', 2)).toBe('999999999999')
  })
  it('never lets keypad input exceed a safe minor-unit integer', () => {
    expect(applyKeypad('99999999999', '9', 4)).toBe('99999999999')
    expect(applyKeypad('900719925474.099', '1', 4)).toBe('900719925474.0991')
    expect(applyKeypad('900719925474.099', '2', 4)).toBe('900719925474.099')
  })
  it('rejects conversion beyond the safe minor-unit integer', () => {
    expect(amountToMinor('90071992547409.91', 'EUR', currencies)).toBe(Number.MAX_SAFE_INTEGER)
    expect(() => amountToMinor('90071992547409.92', 'EUR', currencies)).toThrow(RangeError)
  })
  it('converts through RSD rates', () => {
    const expense = { amountMinor: 1000, currency: 'EUR' } as Expense
    expect(convertExpense(expense, 'RSD', currencies, { base: 'RSD', date: '2026-08-03', ratesToRsd: { EUR: 117, RSD: 1 } })).toBe(1170)
  })
  it('prefers the rate of the purchase day over the latest snapshot', () => {
    const rates = { base: 'RSD' as const, date: '2026-09-05', ratesToRsd: { RSD: 1, EUR: 117.5, USD: 101 }, daily: { '2026-08-03': { RSD: 1, EUR: 117 } } }
    const expense: Expense = { id: 'e', amountMinor: 1_000, currency: 'EUR', categoryId: 'food', note: null, occurredAt: '2026-08-03T10:00:00.000Z', createdAt: '2026-08-03T10:00:00.000Z', updatedAt: '2026-08-03T10:00:00.000Z', version: 1, deletedAt: null }
    expect(convertExpense(expense, 'RSD', currencies, rates)).toBe(1170)
    // A day the server did not list falls back to the snapshot.
    expect(convertExpense({ ...expense, occurredAt: '2026-09-01T10:00:00.000Z' }, 'RSD', currencies, rates)).toBe(1175)
    // A currency missing from that day's table also falls back to the snapshot instead of counting as unavailable.
    expect(convertExpense(expense, 'USD', currencies, rates)).toBeCloseTo(1170 / 101, 6)
  })

  it('keeps an identity conversion even when the rate snapshot is empty', () => {
    const expense = { amountMinor: 1000, currency: 'EUR' } as Expense
    expect(convertExpense(expense, 'EUR', currencies, { base: 'RSD', date: null, ratesToRsd: {} })).toBe(10)
  })
})

describe('expense timeline gestures', () => {
  it('moves right into older expenses and left into newer expenses', () => {
    expect(swipeDirection(80)).toBe('older')
    expect(swipeDirection(-80)).toBe('newer')
  })
})

describe('Belgrade date helpers', () => {
  it('formats winter and summer offsets for datetime-local', () => {
    expect(isoToLocalInput('2026-01-03T11:30:00.000Z')).toBe('2026-01-03T12:30')
    expect(isoToLocalInput('2026-08-03T11:30:00.000Z')).toBe('2026-08-03T13:30')
  })
  it('converts datetime-local back to UTC across DST', () => {
    expect(localInputToIso('2026-08-03T13:30')).toBe('2026-08-03T11:30:00.000Z')
  })
  it('groups a late UTC expense by Belgrade day', () => {
    expect(localDateKey('2026-08-03T22:30:00.000Z')).toBe('2026-08-04')
    expect(weekdayFromDateKey('2026-08-03')).toBe(0)
  })
  it('finds a Monday-to-Sunday budget week', () => {
    expect(startOfWeekDateKey('2026-08-09')).toBe('2026-08-03')
    expect(shiftDateKey(startOfWeekDateKey('2026-08-09'), 6)).toBe('2026-08-09')
    expect(startOfWeekDateKey('2026-08-03')).toBe('2026-08-03')
  })
  it('moves between complete budget weeks', () => {
    expect(weekDateRange('2026-08-09')).toEqual({ from: '2026-08-03', to: '2026-08-09' })
    expect(weekDateRange('2026-08-09', -1)).toEqual({ from: '2026-07-27', to: '2026-08-02' })
  })
  it('moves between complete calendar months', () => {
    expect(monthDateRange('2026-08-09')).toEqual({ from: '2026-08-01', to: '2026-08-31' })
    expect(monthDateRange('2026-03-09', -1)).toEqual({ from: '2026-02-01', to: '2026-02-28' })
  })
  it('counts weekday occurrences for fair all-time averages', () => {
    expect(countCalendarWeekdays('2026-08-03', '2026-08-09')).toEqual([1, 1, 1, 1, 1, 1, 1])
    expect(countCalendarWeekdays('2026-08-03', '2026-08-16')).toEqual([2, 2, 2, 2, 2, 2, 2])
  })
})

describe('amount display', () => {
  it('shows the typed amount with a comma and thousands groups, keeping the typed tail', () => {
    expect(formatAmountInput('')).toBe('')
    expect(formatAmountInput('1250')).toBe('1\u00a0250')
    expect(formatAmountInput('924.89')).toBe('924,89')
    expect(formatAmountInput('12.')).toBe('12,')
    expect(formatAmountInput('12.50')).toBe('12,50')
    expect(formatAmountInput('1000000.5')).toBe('1\u00a0000\u00a0000,5')
  })
})
