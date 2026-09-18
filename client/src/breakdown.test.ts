import { describe, expect, it } from 'vitest'
import { BREAKDOWN_REST, breakdownColors, categoryBreakdown, merchantKey } from './breakdown'

const now = new Date().toISOString()
const tags = ['впн', 'иишки', 'йеттел', 'дайс'].map((name, index) => ({ id: `tag-${name}`, name, color: null, sortOrder: index, createdAt: now, updatedAt: now, version: 1 }))

describe('category breakdown', () => {
  it('adds records up by tag and splits a record with two tags between them evenly', () => {
    const { groups } = categoryBreakdown([
      { expense: { tagIds: ['tag-впн'], note: null }, value: 700 },
      { expense: { tagIds: ['tag-впн', 'tag-дайс'], note: null }, value: 1_000 },
      { expense: { tagIds: ['tag-йеттел'], note: 'пополнение' }, value: 300 },
    ], tags)
    expect(groups.map((group) => [group.label, group.value, group.count])).toEqual([['#впн', 1_200, 2], ['#дайс', 500, 1], ['#йеттел', 300, 1]])
    expect(groups.reduce((sum, group) => sum + group.value, 0)).toBe(2_000)
  })

  it('groups untagged records by the shop from the card statement, ignoring store and till numbers', () => {
    expect(merchantKey('215 - MAXI 5288')).toEqual({ key: 'maxi', label: 'MAXI' })
    expect(merchantKey('VERO 3').key).toBe(merchantKey('VERO 11').key)
    expect(merchantKey('GOOGLE *YouTubePremium · ютуб').label).toBe('GOOGLE *YouTubePremium')
    const { groups } = categoryBreakdown([
      { expense: { note: 'VERO 3' }, value: 400 },
      { expense: { note: 'VERO 11' }, value: 200 },
      { expense: { note: '215 - MAXI 5288' }, value: 100 },
      { expense: { note: null }, value: 50 },
    ], tags)
    expect(groups.map((group) => [group.label, group.value, group.count])).toEqual([['VERO', 600, 2], ['MAXI', 100, 1], ['Без подписи', 50, 1]])
  })

  it('folds the tail past the limit into «Остальное» and paints it grey', () => {
    const items = Array.from({ length: 9 }, (_, index) => ({ expense: { note: `Shop${'abcdefghi'[index]}` }, value: 100 - index }))
    const { groups, rest } = categoryBreakdown(items, tags)
    expect(groups).toHaveLength(7)
    expect(groups[6]).toMatchObject({ key: BREAKDOWN_REST, label: 'Остальное', value: 94 + 93 + 92, count: 3 })
    expect(rest).toHaveLength(3)
    const colors = breakdownColors('#758d69', groups)
    expect(colors[6]).toBe('#a9afa5')
    expect(new Set(colors).size).toBe(7)
  })
})
