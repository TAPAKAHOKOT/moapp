import { afterEach, describe, expect, it, vi } from 'vitest'
import { isoToLocalInput, localDateKey, localInputToIso } from './utils'

// Прежняя реализация — эталон: новая обязана давать те же строки. Форматтер на пояс создаётся один раз, как и прежде.
const legacyFormats = new Map<string, Intl.DateTimeFormat>()
function legacyParts(date: Date, timeZone: string) {
  let format = legacyFormats.get(timeZone)
  if (!format) { format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); legacyFormats.set(timeZone, format) }
  return Object.fromEntries(format.formatToParts(date).map((part) => [part.type, part.value])) as Record<string, string>
}
function legacyLocalDateKey(value: string | Date, timeZone: string) {
  const parts = legacyParts(typeof value === 'string' ? new Date(value) : value, timeZone)
  return `${parts.year}-${parts.month}-${parts.day}`
}
function legacyIsoToLocalInput(iso: string, timeZone: string) {
  const parts = legacyParts(new Date(iso), timeZone)
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}
function legacyLocalInputToIso(value: string, timeZone: string) {
  const [, year, month, day, hour, minute] = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)!.map(Number)
  const wallUtc = Date.UTC(year!, month! - 1, day, hour, minute)
  let guess = wallUtc
  for (let index = 0; index < 2; index++) {
    const parts = legacyParts(new Date(guess), timeZone)
    guess += wallUtc - Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute))
  }
  return new Date(guess).toISOString()
}

const ZONES = ['Europe/Belgrade', 'America/New_York', 'Asia/Kolkata', 'Pacific/Auckland']

// Переходы на летнее и зимнее время 2026 года во всех поясах и полночи вокруг них.
const ANCHORS = [
  '2026-03-29T01:00:00.000Z', '2026-10-25T01:00:00.000Z', // Белград
  '2026-03-08T07:00:00.000Z', '2026-11-01T06:00:00.000Z', // Нью-Йорк
  '2026-04-04T14:00:00.000Z', '2026-09-26T14:00:00.000Z', // Окленд
  '2026-08-03T18:30:00.000Z', // полночь в Калькутте
  '2026-12-31T23:00:00.000Z', // Новый год в Белграде
]

function instants() {
  const list: string[] = []
  for (const anchor of ANCHORS) {
    const base = Date.parse(anchor)
    for (let minutes = -30 * 60; minutes <= 30 * 60; minutes += 20) {
      const at = base + minutes * 60_000
      list.push(new Date(at).toISOString(), new Date(at - 1).toISOString(), new Date(at + 1).toISOString())
    }
  }
  list.push('1970-01-01T00:00:00.000Z', '2099-12-31T23:59:59.999Z', '2026-08-03T23:30:00+02:00', '2026-08-03', '2026-02-28T23:59:59.999Z')
  return list
}

afterEach(() => { vi.restoreAllMocks() })

describe('local day keys', () => {
  it('match the formatter they replace in every zone, across DST switches and midnights, on repeated calls too', () => {
    const list = instants()
    for (const timeZone of ZONES) {
      for (const iso of list) {
        const expected = legacyLocalDateKey(iso, timeZone)
        expect(localDateKey(iso, timeZone)).toBe(expected)
        expect(localDateKey(iso, timeZone)).toBe(expected)
        expect(localDateKey(new Date(iso), timeZone)).toBe(expected)
      }
    }
    // Без пояса — календарь телефона (в тестах Белград).
    for (const iso of list) expect(localDateKey(iso)).toBe(legacyLocalDateKey(iso, 'Europe/Belgrade'))
  })

  it('gives another day when the zone changes, whichever zone asked first', () => {
    const iso = '2026-08-03T23:30:00.000Z'
    for (let round = 0; round < 3; round += 1) {
      expect(localDateKey(iso, 'Europe/Belgrade')).toBe('2026-08-04')
      expect(localDateKey(iso, 'America/New_York')).toBe('2026-08-03')
      expect(localDateKey(iso, 'Pacific/Auckland')).toBe('2026-08-04')
    }
    expect(localDateKey(iso)).toBe('2026-08-04')
  })

  it('still refuses an invalid date on every call', () => {
    expect(() => legacyLocalDateKey('not a date', 'Europe/Belgrade')).toThrow(RangeError)
    expect(() => localDateKey('not a date')).toThrow(RangeError)
    expect(() => localDateKey('not a date')).toThrow(RangeError)
    expect(() => localDateKey(new Date(Number.NaN))).toThrow(RangeError)
  })

  it('stays exact after the remembered days overflow', () => {
    const start = Date.parse('2031-01-01T00:00:00.000Z')
    const list = Array.from({ length: 25_000 }, (_, index) => new Date(start + index * 7 * 60_000).toISOString())
    for (const iso of list) expect(localDateKey(iso, 'Asia/Kolkata')).toBe(legacyLocalDateKey(iso, 'Asia/Kolkata'))
    for (const iso of list.slice(0, 50)) expect(localDateKey(iso, 'Asia/Kolkata')).toBe(legacyLocalDateKey(iso, 'Asia/Kolkata'))
  })

  it('works out the day of a recorded time once per zone', () => {
    const formatToParts = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts')
    const iso = '2032-05-17T21:13:08.123Z'
    expect(localDateKey(iso, 'Asia/Kolkata')).toBe('2032-05-18')
    expect(localDateKey(iso, 'Asia/Kolkata')).toBe('2032-05-18')
    expect(localDateKey(iso, 'Asia/Kolkata')).toBe('2032-05-18')
    expect(formatToParts).toHaveBeenCalledTimes(1)
    expect(localDateKey(iso, 'America/New_York')).toBe('2032-05-17')
    expect(formatToParts).toHaveBeenCalledTimes(2)
  })

  it('takes the formatter of a zone without serialising its options on every call', () => {
    const stringify = vi.spyOn(JSON, 'stringify')
    localDateKey(new Date(), 'Pacific/Auckland')
    localDateKey('2033-01-01T00:00:00.000Z', 'Pacific/Auckland')
    isoToLocalInput('2033-01-01T00:00:00.000Z', 'Pacific/Auckland')
    localInputToIso('2033-01-01T13:00', 'Pacific/Auckland')
    expect(stringify).not.toHaveBeenCalled()
  })
})

describe('datetime-local conversion', () => {
  it('matches the formatter it replaces in every zone, both ways', () => {
    for (const timeZone of ZONES) {
      for (const iso of instants().filter((_, index) => index % 5 === 0)) {
        const local = isoToLocalInput(iso, timeZone)
        expect(local).toBe(legacyIsoToLocalInput(iso, timeZone))
        expect(localInputToIso(local, timeZone)).toBe(legacyLocalInputToIso(local, timeZone))
      }
    }
    expect(() => localInputToIso('2026-08-03 13:30')).toThrow('Invalid local date and time')
  })
})
