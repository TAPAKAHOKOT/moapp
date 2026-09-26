import type { AccountSettings, BlockLayout } from './types'

/*
 * Экраны из блоков. Что стоит на «Расходе», «Истории» и «Аналитике», решает сам человек прямо на экране, в режиме
 * «Настройка экрана»: убирает блок, возвращает его и в аналитике переставляет. Раскладка живёт в аккаунте и одна на все
 * пространства. Основа экрана не убирается: без неё экран теряет смысл. Кто ничего не трогал, видит все блоки
 * в исходном порядке — экраны как раньше.
 */

export type BlockScreen = 'entry' | 'history' | 'analytics'

export type BlockInfo = { id: string; name: string; hint: string }

type ScreenInfo = {
  title: string
  setting: 'entryBlocks' | 'historyBlocks' | 'analyticsBlocks'
  blocks: BlockInfo[]
}

export const SCREENS: Readonly<Record<BlockScreen, ScreenInfo>> = {
  entry: {
    title: 'Расход', setting: 'entryBlocks',
    blocks: [
      { id: 'note', name: 'Заметка', hint: 'кнопка «＋ Заметка» под плитками' },
      { id: 'tags', name: 'Теги', hint: 'ряд тегов под плитками' },
    ],
  },
  history: {
    title: 'История', setting: 'historyBlocks',
    blocks: [
      { id: 'filters', name: 'Фильтры и поиск', hint: 'даты, категории, валюты и теги' },
      { id: 'total', name: 'Итог', hint: 'сумма и число записей' },
      { id: 'day-totals', name: 'Суммы по дням', hint: 'сколько потрачено за день, рядом с датой' },
    ],
  },
  // Карточки аналитики переставляются; на «Расходе» и в «Истории» у каждого блока своё место.
  analytics: {
    title: 'Аналитика', setting: 'analyticsBlocks',
    blocks: [
      { id: 'trend', name: 'Динамика', hint: 'график трат по дням' },
      { id: 'categories', name: 'Категории', hint: 'круг и список категорий' },
      { id: 'tags', name: 'Теги', hint: 'круг и список тегов' },
      { id: 'weekdays', name: 'По дням недели', hint: 'в какие дни тратите больше, за месяц' },
    ],
  },
}

export const BLOCK_SCREENS = Object.keys(SCREENS) as BlockScreen[]

export const blockInfo = (screen: BlockScreen, id: string) => SCREENS[screen].blocks.find((block) => block.id === id)!

export type Blocks = { shown: BlockInfo[]; hidden: BlockInfo[] }

/**
 * Блоки экрана у этого человека. Незнакомые имена пропускаются, а блок, о котором сохранённая раскладка ещё не знает
 * (появился в приложении позже), стоит на экране — в конце.
 */
export function screenBlocks(screen: BlockScreen, saved?: BlockLayout): Blocks {
  const catalog = SCREENS[screen].blocks
  if (!saved) return { shown: [...catalog], hidden: [] }
  const byId = new Map(catalog.map((block) => [block.id, block]))
  const taken = new Set<string>()
  const pick = (ids: string[]) => ids.flatMap((id) => {
    const block = byId.get(id)
    if (!block || taken.has(id)) return []
    taken.add(id)
    return [block]
  })
  const shown = pick(saved.shown)
  const hidden = pick(saved.hidden)
  return { shown: [...shown, ...catalog.filter((block) => !taken.has(block.id))], hidden }
}

export const blocksOf = (screen: BlockScreen, settings?: AccountSettings) => screenBlocks(screen, settings?.[SCREENS[screen].setting])

export const isShown = (blocks: Blocks, id: string) => blocks.shown.some((block) => block.id === id)

/** Убрать с экрана: первым в списке убранных, чтобы было видно, куда он делся. */
export function hideBlock(blocks: Blocks, id: string): Blocks {
  const block = blocks.shown.find((item) => item.id === id)
  return block ? { shown: blocks.shown.filter((item) => item !== block), hidden: [block, ...blocks.hidden] } : blocks
}

/** Вернуть на экран: в конец. */
export function showBlock(blocks: Blocks, id: string): Blocks {
  const block = blocks.hidden.find((item) => item.id === id)
  return block ? { shown: [...blocks.shown, block], hidden: blocks.hidden.filter((item) => item !== block) } : blocks
}

export const toggleBlock = (blocks: Blocks, id: string) => isShown(blocks, id) ? hideBlock(blocks, id) : showBlock(blocks, id)

export function reorderBlocks(blocks: Blocks, ids: string[]): Blocks {
  const rank = new Map(ids.map((id, index) => [id, index]))
  const last = blocks.shown.length
  return { ...blocks, shown: [...blocks.shown].sort((left, right) => (rank.get(left.id) ?? last) - (rank.get(right.id) ?? last)) }
}

export const toBlockLayout = (blocks: Blocks): BlockLayout => ({ shown: blocks.shown.map((block) => block.id), hidden: blocks.hidden.map((block) => block.id) })

/** Сколько блоков убрано со всех экранов — значение строки «Мои экраны». */
export const hiddenBlockCount = (settings?: AccountSettings) => BLOCK_SCREENS.reduce((sum, screen) => sum + blocksOf(screen, settings).hidden.length, 0)
