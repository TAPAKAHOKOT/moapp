import { describe, expect, it } from 'vitest'
import { categoryLayout, inOrder, moveToMore, moveToShown, reorderGroup, tagLayout, toScreenOrder } from './screen-order'
import type { Category, Tag } from './types'

const category = (id: string, placement: Category['placement'], sortOrder: number, archivedAt: string | null = null): Category => ({
  id, name: id, color: null, placement, sortOrder, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', archivedAt, version: 1,
})
const tag = (id: string, sortOrder: number): Tag => ({ id, name: id, color: null, sortOrder, version: 1, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' })
const ids = (items: Array<{ id: string }>) => items.map((item) => item.id)

const categories = [
  category('home', 'additional', 0), category('eating-out', 'main', 1), category('products', 'main', 0),
  category('other', 'additional', 1), category('hidden', 'main', 2, '2026-09-01T00:00:00.000Z'),
]

describe('what stands on «Расход»', () => {
  it('shows the shared starting layout to someone who never arranged it', () => {
    const layout = categoryLayout(categories)
    expect([ids(layout.shown), ids(layout.more)]).toEqual([['products', 'eating-out'], ['home', 'other']])
    const tags = tagLayout([tag('f', 5), tag('a', 0), tag('b', 1), tag('c', 2), tag('d', 3), tag('e', 4)])
    expect([ids(tags.shown), ids(tags.more)]).toEqual([['a', 'b', 'c', 'd', 'e'], ['f']])
  })

  it('follows the person, skips what is gone and puts a category added later at the end of «Ещё»', () => {
    const layout = categoryLayout([...categories, category('new', 'additional', 999)], { shown: ['home', 'removed', 'hidden', 'products'], more: ['other', 'home'] })
    expect(ids(layout.shown)).toEqual(['home', 'products'])
    expect(ids(layout.more)).toEqual(['other', 'eating-out', 'new'])
    expect(ids(inOrder(layout))).toEqual(['home', 'products', 'other', 'eating-out', 'new'])
  })

  it('moves a tile behind «Ещё» at its top, back to the end of the row, and reorders inside one group', () => {
    const layout = categoryLayout(categories)
    const hidden = moveToMore(layout, 'products')
    expect([ids(hidden.shown), ids(hidden.more)]).toEqual([['eating-out'], ['products', 'home', 'other']])
    const back = moveToShown(hidden, 'other')
    expect([ids(back.shown), ids(back.more)]).toEqual([['eating-out', 'other'], ['products', 'home']])
    expect(ids(reorderGroup(back, 'more', ['home', 'products']).more)).toEqual(['home', 'products'])
    expect(moveToShown(back, 'eating-out')).toBe(back)
  })

  it('writes only ids, within what the server accepts', () => {
    const many = Array.from({ length: 25 }, (_, index) => category(`c${index}`, 'main', index))
    const order = toScreenOrder(categoryLayout(many))
    expect(order.shown).toHaveLength(20)
    expect(order.more).toEqual([])
    expect(toScreenOrder(categoryLayout(categories))).toEqual({ shown: ['products', 'eating-out'], more: ['home', 'other'] })
  })
})
