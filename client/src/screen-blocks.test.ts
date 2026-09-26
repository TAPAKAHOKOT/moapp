import { describe, expect, it } from 'vitest'
import { hiddenBlockCount, hideBlock, isShown, isSmall, reorderBlocks, screenBlocks, showBlock, toBlockLayout, toggleSize } from './screen-blocks'

const ids = (blocks: Array<{ id: string }>) => blocks.map((block) => block.id)

describe('screens made of blocks', () => {
  it('shows every block in the usual order to someone who never changed a screen', () => {
    const blocks = screenBlocks('analytics')
    // Новые блоки ждут среди убранных, пока человек их не поставит.
    expect([ids(blocks.shown), ids(blocks.hidden), blocks.small]).toEqual([['trend', 'categories', 'tags', 'weekdays'], ['pace', 'top', 'calendar'], []])
    expect([ids(screenBlocks('entry').shown), ids(screenBlocks('entry').hidden)]).toEqual([['keypad', 'tiles', 'note', 'tags'], ['today', 'usual']])
    // Поставленный новый блок встаёт на своё место: «Темп» — сразу за «Динамикой».
    expect(ids(showBlock(blocks, 'pace').shown)).toEqual(['trend', 'pace', 'categories', 'tags', 'weekdays'])
    expect(isShown(screenBlocks('history'), 'day-totals')).toBe(true)
  })

  it('follows the saved layout, skips unknown names and puts a block the layout does not know yet in its usual place', () => {
    const blocks = screenBlocks('analytics', { shown: ['weekdays', 'future', 'trend', 'weekdays'], hidden: ['categories', 'removed'] })
    expect(ids(blocks.shown)).toEqual(['weekdays', 'trend', 'tags'])
    expect(ids(blocks.hidden)).toEqual(['categories', 'pace', 'top', 'calendar'])
    // Раскладка «Расхода», сохранённая до того, как клавиатура и плитки стали блоками: они встают на свои места.
    expect(ids(screenBlocks('entry', { shown: ['tags'], hidden: ['note'] }).shown)).toEqual(['keypad', 'tiles', 'tags'])
  })

  it('keeps a block that cannot be removed on the screen even if a layout says otherwise', () => {
    const blocks = screenBlocks('entry', { shown: ['tags', 'tiles'], hidden: ['keypad', 'note'] })
    expect([ids(blocks.shown), ids(blocks.hidden)]).toEqual([['keypad', 'tags', 'tiles'], ['note', 'today', 'usual']])
    expect(hideBlock(blocks, 'keypad')).toBe(blocks)
  })

  it('hides a block at the top of the removed ones, brings it back to its usual place and reorders what is shown', () => {
    const start = screenBlocks('analytics')
    const hidden = hideBlock(start, 'categories')
    expect([ids(hidden.shown), ids(hidden.hidden)]).toEqual([['trend', 'tags', 'weekdays'], ['categories', 'pace', 'top', 'calendar']])
    const back = showBlock(hidden, 'categories')
    expect(ids(back.shown)).toEqual(['trend', 'categories', 'tags', 'weekdays'])
    // Переставленные блоки не мешают: вернувшийся встаёт сразу за тем, кто обычно стоит перед ним.
    const moved = hideBlock(reorderBlocks(start, ['weekdays', 'tags', 'trend', 'categories']), 'trend')
    expect(ids(showBlock(moved, 'trend').shown)).toEqual(['trend', 'weekdays', 'tags', 'categories'])
    expect(toBlockLayout(reorderBlocks(back, ['categories', 'trend']))).toEqual({ shown: ['categories', 'trend', 'tags', 'weekdays'], hidden: ['pace', 'top', 'calendar'] })
    expect(showBlock(back, 'trend')).toBe(back)
  })

  it('remembers which cards are small, even for a removed card, and only for cards that can be small', () => {
    const blocks = screenBlocks('analytics', { shown: ['trend'], hidden: ['categories'], small: ['categories', 'categories', 'unknown'] })
    expect(blocks.small).toEqual(['categories'])
    const both = toggleSize(blocks, 'trend')
    expect([isSmall(both, 'trend'), isSmall(toggleSize(both, 'trend'), 'trend')]).toEqual([true, false])
    expect(toBlockLayout(both)).toEqual({ shown: ['trend', 'tags', 'weekdays'], hidden: ['categories', 'pace', 'top', 'calendar'], small: ['categories', 'trend'] })
    expect(screenBlocks('entry', { shown: [], hidden: [], small: ['tiles'] }).small).toEqual([])
  })

  it('counts what was removed from all screens', () => {
    expect(hiddenBlockCount()).toBe(0)
    expect(hiddenBlockCount({ entryBlocks: { shown: [], hidden: ['note', 'tags'] }, analyticsBlocks: { shown: ['trend'], hidden: ['weekdays'] } })).toBe(3)
  })
})
