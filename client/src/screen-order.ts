import type { Category, ScreenOrder, Tag } from './types'

/*
 * Что стоит на экране «Расход», у каждого человека своё (`MemberSettings.categoryOrder` и `tagOrder`): плитки
 * категорий и теги в ряду, по порядку, а остальное — за «Ещё», тоже по порядку. Кто ничего не собирал, видит
 * общую стартовую раскладку — ровно ту, что была до личной настройки: категории «на главном экране» плитками
 * и первые пять тегов. Категории и теги общие, поэтому раскладка терпит чужие изменения: удалённое пропадает,
 * а новое, которого нет ни в одном списке, встаёт в конец «Ещё».
 */

/** Сколько тегов стоит в ряду у того, кто ряд не настраивал. Выбранные в расходе видны всегда. */
export const VISIBLE_TAGS = 5

/** Больше плиток в ряд на узком телефоне не помещается без обрезанных подписей. */
export const ROOMY_TILES = 4

// Пределы сервера (settings.ts): длиннее списки он не примет.
const MAX_SHOWN = 20
const MAX_MORE = 100

export type Layout<T> = { shown: T[]; more: T[] }

function arrange<T extends { id: string }>(ordered: T[], starting: Layout<T>, order: ScreenOrder | undefined): Layout<T> {
  if (!order) return starting
  const byId = new Map(ordered.map((item) => [item.id, item]))
  const taken = new Set<string>()
  const pick = (ids: string[]) => ids.flatMap((id) => {
    const item = byId.get(id)
    if (!item || taken.has(id)) return []
    taken.add(id)
    return [item]
  })
  const shown = pick(order.shown)
  const more = pick(order.more)
  return { shown, more: [...more, ...ordered.filter((item) => !taken.has(item.id))] }
}

const sharedCategoryOrder = (left: Category, right: Category) =>
  Number(left.placement === 'additional') - Number(right.placement === 'additional') || left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, 'ru-RU')

/** Плитки и «Ещё» этого человека. Скрытые категории не участвуют. */
export function categoryLayout(categories: Category[], order?: ScreenOrder): Layout<Category> {
  const active = categories.filter((item) => !item.archivedAt).sort(sharedCategoryOrder)
  return arrange(active, { shown: active.filter((item) => item.placement === 'main'), more: active.filter((item) => item.placement === 'additional') }, order)
}

/** Теги в ряду и за «Ещё» у этого человека. */
export function tagLayout(tags: Tag[], order?: ScreenOrder): Layout<Tag> {
  const sorted = [...tags].sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, 'ru-RU'))
  return arrange(sorted, { shown: sorted.slice(0, VISIBLE_TAGS), more: sorted.slice(VISIBLE_TAGS) }, order)
}

/** Всё в порядке этого человека: сначала то, что на «Расходе», потом «Ещё». Так же идут списки и фильтры. */
export const inOrder = <T>(layout: Layout<T>): T[] => [...layout.shown, ...layout.more]

/** Раскладка для аккаунта: только id и не длиннее, чем принимает сервер. */
export function toScreenOrder(layout: Layout<{ id: string }>): ScreenOrder {
  return { shown: layout.shown.slice(0, MAX_SHOWN).map((item) => item.id), more: layout.more.slice(0, MAX_MORE).map((item) => item.id) }
}

/** Убрать с «Расхода»: первым в «Ещё», чтобы было видно, куда он делся. */
export function moveToMore<T extends { id: string }>(layout: Layout<T>, id: string): Layout<T> {
  const item = layout.shown.find((entry) => entry.id === id)
  return item ? { shown: layout.shown.filter((entry) => entry !== item), more: [item, ...layout.more] } : layout
}

/** Поставить на «Расход»: в конец ряда. */
export function moveToShown<T extends { id: string }>(layout: Layout<T>, id: string): Layout<T> {
  const item = layout.more.find((entry) => entry.id === id)
  return item ? { shown: [...layout.shown, item], more: layout.more.filter((entry) => entry !== item) } : layout
}

/** Новый порядок внутри ряда или «Ещё»; чужие id и пропуски не ломают раскладку. */
export function reorderGroup<T extends { id: string }>(layout: Layout<T>, group: keyof Layout<T>, ids: string[]): Layout<T> {
  const items = layout[group]
  const rank = new Map(ids.map((id, index) => [id, index]))
  const sorted = [...items].sort((left, right) => (rank.get(left.id) ?? items.length) - (rank.get(right.id) ?? items.length))
  return { ...layout, [group]: sorted }
}
