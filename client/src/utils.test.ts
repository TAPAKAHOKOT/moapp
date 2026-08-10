import { describe, expect, it } from 'vitest'
import { amountToMinor, applyKeypad, convertExpense, countCalendarWeekdays, isoToLocalInput, localDateKey, localInputToIso, monthDateRange, shiftDateKey, startOfWeekDateKey, swipeDirection, weekdayFromDateKey, weekDateRange } from './utils'
import type { Currency, Expense } from './types'

const currencies: Currency[] = [
  { code: 'RSD', name: 'Сербский динар', symbol: 'дин.', decimals: 2 },
  { code: 'EUR', name: 'Евро', symbol: '€', decimals: 2 },
]

describe('money helpers', () => {
  it('uses integer minor units', () => expect(amountToMinor('12.34', 'EUR', currencies)).toBe(1234))
  it('limits keypad fractional digits', () => expect(applyKeypad('12.34', '5')).toBe('12.34'))
  it('converts through RSD rates', () => {
    const expense = { amountMinor: 1000, currency: 'EUR' } as Expense
    expect(convertExpense(expense, 'RSD', currencies, { base: 'RSD', date: '2026-08-03', ratesToRsd: { EUR: 117, RSD: 1 } })).toBe(1170)
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
