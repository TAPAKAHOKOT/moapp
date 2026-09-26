import type { AccountSettings, BlockLayout } from './types'

/*
 * Экраны из блоков. Что стоит на «Расходе», «Истории» и «Аналитике», решает сам человек прямо на экране, в режиме
 * «Настройка экрана»: убирает блок, возвращает его, переставляет, а карточки аналитики делает маленькими. Раскладка
 * живёт в аккаунте и одна на все пространства. Основа экрана не убирается: без неё экран теряет смысл. Кто ничего не
 * трогал, видит блоки в исходном порядке — экраны как раньше.
 */

export type BlockScreen = 'entry' | 'history' | 'analytics'

export type BlockInfo = {
  id: string
  name: string
  hint: string
  /** Всегда на экране: только переставляется (клавиатура и плитки на «Расходе»). */
  fixed?: boolean
  /** Место не меняется: суммы по дням живут у дат. */
  pinned?: boolean
  /** Новый блок: стоит на экране только у того, кто его поставил. */
  optional?: boolean
  /** Карточка бывает маленькой — в полширины, две в ряд. */
  resizable?: boolean
}

type ScreenInfo = {
  title: string
  setting: 'entryBlocks' | 'historyBlocks' | 'analyticsBlocks'
  /** Порядок по умолчанию: так экран выглядит у того, кто его не трогал, и сюда возвращается убранный блок. */
  blocks: BlockInfo[]
}

export const SCREENS: Readonly<Record<BlockScreen, ScreenInfo>> = {
  entry: {
    title: 'Расход', setting: 'entryBlocks',
    blocks: [
      { id: 'keypad', name: 'Клавиатура', hint: 'цифры для суммы', fixed: true },
      { id: 'tiles', name: 'Плитки', hint: 'категории одним касанием', fixed: true },
      { id: 'note', name: 'Заметка', hint: 'кнопка «＋ Заметка»' },
      { id: 'tags', name: 'Теги', hint: 'ряд тегов' },
    ],
  },
  history: {
    title: 'История', setting: 'historyBlocks',
    blocks: [
      { id: 'filters', name: 'Фильтры и поиск', hint: 'даты, категории, валюты и теги' },
      { id: 'total', name: 'Итог', hint: 'сумма и число записей' },
      { id: 'day-totals', name: 'Суммы по дням', hint: 'сколько потрачено за день, рядом с датой', pinned: true },
    ],
  },
  analytics: {
    title: 'Аналитика', setting: 'analyticsBlocks',
    blocks: [
      { id: 'trend', name: 'Динамика', hint: 'график трат по дням', resizable: true },
      { id: 'categories', name: 'Категории', hint: 'круг и список категорий', resizable: true },
      { id: 'tags', name: 'Теги', hint: 'круг и список тегов', resizable: true },
      { id: 'weekdays', name: 'По дням недели', hint: 'в какие дни тратите больше, за месяц', resizable: true },
    ],
  },
}

export const BLOCK_SCREENS = Object.keys(SCREENS) as BlockScreen[]

export const blockInfo = (screen: BlockScreen, id: string) => SCREENS[screen].blocks.find((block) => block.id === id)!

/** `small` — какие карточки человек сделал маленькими; размер помнится и у убранной карточки. */
export type Blocks = { screen: BlockScreen; shown: BlockInfo[]; hidden: BlockInfo[]; small: string[] }

/** Поставить блок на его место по умолчанию: сразу за ближайшим, кто стоит перед ним в каталоге. */
function placeAtDefault(screen: BlockScreen, list: BlockInfo[], block: BlockInfo) {
  const catalog = SCREENS[screen].blocks
  const rank = catalog.indexOf(block)
  let at = 0
  list.forEach((item, index) => { if (catalog.indexOf(item) < rank) at = index + 1 })
  return [...list.slice(0, at), block, ...list.slice(at)]
}

/**
 * Блоки экрана у этого человека. Незнакомые имена пропускаются. Блок, о котором сохранённая раскладка ещё не знает
 * (появился в приложении позже), встаёт на своё место по умолчанию, а новый необязательный — ждёт среди убранных.
 * Неубираемый блок в списке убранных (раскладка другой версии приложения) всё равно стоит на экране.
 */
export function screenBlocks(screen: BlockScreen, saved?: BlockLayout): Blocks {
  const catalog = SCREENS[screen].blocks
  const byId = new Map(catalog.map((block) => [block.id, block]))
  const taken = new Set<string>()
  const pick = (ids: string[] = []) => ids.flatMap((id) => {
    const block = byId.get(id)
    if (!block || taken.has(id)) return []
    taken.add(id)
    return [block]
  })
  let shown = pick(saved?.shown)
  const hidden = pick(saved?.hidden).filter((block) => {
    if (!block.fixed) return true
    shown = placeAtDefault(screen, shown, block)
    return false
  })
  for (const block of catalog) {
    if (taken.has(block.id)) continue
    if (block.optional) hidden.push(block)
    else shown = placeAtDefault(screen, shown, block)
  }
  const small = [...new Set(saved?.small ?? [])].filter((id) => byId.get(id)?.resizable)
  return { screen, shown, hidden, small }
}

export const blocksOf = (screen: BlockScreen, settings?: AccountSettings) => screenBlocks(screen, settings?.[SCREENS[screen].setting])

export const isShown = (blocks: Blocks, id: string) => blocks.shown.some((block) => block.id === id)

export const isSmall = (blocks: Blocks, id: string) => blocks.small.includes(id)

/** Убрать с экрана: первым в списке убранных. Неубираемый блок остаётся на месте. */
export function hideBlock(blocks: Blocks, id: string): Blocks {
  const block = blocks.shown.find((item) => item.id === id)
  return block && !block.fixed ? { ...blocks, shown: blocks.shown.filter((item) => item !== block), hidden: [block, ...blocks.hidden] } : blocks
}

/** Вернуть на экран — на его место по умолчанию, рядом с теми, кто стоял там же. */
export function showBlock(blocks: Blocks, id: string): Blocks {
  const block = blocks.hidden.find((item) => item.id === id)
  return block ? { ...blocks, shown: placeAtDefault(blocks.screen, blocks.shown, block), hidden: blocks.hidden.filter((item) => item !== block) } : blocks
}

export const toggleBlock = (blocks: Blocks, id: string) => isShown(blocks, id) ? hideBlock(blocks, id) : showBlock(blocks, id)

export const toggleSize = (blocks: Blocks, id: string): Blocks => ({ ...blocks, small: isSmall(blocks, id) ? blocks.small.filter((item) => item !== id) : [...blocks.small, id] })

export function reorderBlocks(blocks: Blocks, ids: string[]): Blocks {
  const rank = new Map(ids.map((id, index) => [id, index]))
  const last = blocks.shown.length
  return { ...blocks, shown: [...blocks.shown].sort((left, right) => (rank.get(left.id) ?? last) - (rank.get(right.id) ?? last)) }
}

export const toBlockLayout = (blocks: Blocks): BlockLayout => ({
  shown: blocks.shown.map((block) => block.id),
  hidden: blocks.hidden.map((block) => block.id),
  ...(blocks.small.length ? { small: blocks.small } : {}),
})

/** Сколько блоков человек убрал со всех экранов — значение строки «Мои экраны». Не поставленные новые блоки не в счёт. */
export const hiddenBlockCount = (settings?: AccountSettings) => BLOCK_SCREENS.reduce((sum, screen) => sum + blocksOf(screen, settings).hidden.filter((block) => !block.optional).length, 0)
