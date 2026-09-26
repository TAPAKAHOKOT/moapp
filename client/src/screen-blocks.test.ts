import { describe, expect, it } from 'vitest'
import { hiddenBlockCount, hideBlock, isShown, reorderBlocks, screenBlocks, showBlock, toBlockLayout } from './screen-blocks'

const ids = (blocks: Array<{ id: string }>) => blocks.map((block) => block.id)

describe('screens made of blocks', () => {
  it('shows every block in the usual order to someone who never changed a screen', () => {
    const blocks = screenBlocks('analytics')
    expect([ids(blocks.shown), ids(blocks.hidden)]).toEqual([['trend', 'categories', 'tags', 'weekdays'], []])
    expect(isShown(screenBlocks('history'), 'day-totals')).toBe(true)
  })

  it('follows the saved layout, skips unknown names and shows a block the layout does not know yet at the end', () => {
    const blocks = screenBlocks('analytics', { shown: ['weekdays', 'future', 'categories', 'weekdays'], hidden: ['trend', 'removed'] })
    expect(ids(blocks.shown)).toEqual(['weekdays', 'categories', 'tags'])
    expect(ids(blocks.hidden)).toEqual(['trend'])
  })

  it('hides a block at the top of the removed ones, brings it back at the end and reorders what is shown', () => {
    const start = screenBlocks('analytics')
    const hidden = hideBlock(start, 'categories')
    expect([ids(hidden.shown), ids(hidden.hidden)]).toEqual([['trend', 'tags', 'weekdays'], ['categories']])
    const back = showBlock(hidden, 'categories')
    expect(ids(back.shown)).toEqual(['trend', 'tags', 'weekdays', 'categories'])
    expect(toBlockLayout(reorderBlocks(back, ['categories', 'trend']))).toEqual({ shown: ['categories', 'trend', 'tags', 'weekdays'], hidden: [] })
    expect(showBlock(back, 'trend')).toBe(back)
  })

  it('counts what was removed from all screens', () => {
    expect(hiddenBlockCount()).toBe(0)
    expect(hiddenBlockCount({ entryBlocks: { shown: [], hidden: ['note', 'tags'] }, analyticsBlocks: { shown: ['trend'], hidden: ['weekdays'] } })).toBe(3)
  })
})
