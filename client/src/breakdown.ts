import type { Expense, Tag } from './types'

// Из чего сложилась категория: записи с тегами складываются по тегам, записи без тегов — по названию
// продавца из выписки (первая часть заметки до « · »), а если его нет — по самой заметке.
// Запись с несколькими тегами делится между ними поровну, чтобы доли складывались в 100%.

export type BreakdownGroup = { key: string; label: string; value: number; count: number }

export const BREAKDOWN_LIMIT = 6
export const BREAKDOWN_REST = 'rest'
const UNSIGNED = 'unsigned'

// «215 - MAXI 5288», «VERO 3», «IKEA P-0050» — номер магазина и кассы не делает его другим магазином.
export function merchantKey(note: string) {
  const name = note.split(' · ')[0].trim()
  const words = name.split(/\s+/).filter((word) => !/\d/.test(word) && /\p{L}/u.test(word))
  const label = words.length ? words.join(' ') : name
  return { key: label.toLocaleLowerCase('ru-RU').replace(/[^\p{L}\s]/gu, '').replace(/\s+/g, ' ').trim() || label, label }
}

export function expenseGroupKeys(expense: Pick<Expense, 'tagIds' | 'note'>, tags: Tag[]) {
  const names = new Map(tags.map((tag) => [tag.id, tag.name]))
  const tagged = [...new Set(expense.tagIds ?? [])].filter((id) => names.has(id))
  if (tagged.length) return tagged.map((id) => ({ key: `tag:${id}`, label: `#${names.get(id)}` }))
  if (expense.note?.trim()) { const merchant = merchantKey(expense.note); return [{ key: `name:${merchant.key}`, label: merchant.label }] }
  return [{ key: UNSIGNED, label: 'Без подписи' }]
}

/** Группы по убыванию суммы; после BREAKDOWN_LIMIT хвост сворачивается в «Остальное». */
export function categoryBreakdown(items: Array<{ expense: Pick<Expense, 'tagIds' | 'note'>; value: number }>, tags: Tag[], limit = BREAKDOWN_LIMIT) {
  const groups = new Map<string, BreakdownGroup>()
  for (const { expense, value } of items) {
    const keys = expenseGroupKeys(expense, tags)
    for (const { key, label } of keys) {
      const group = groups.get(key) ?? { key, label, value: 0, count: 0 }
      group.value += value / keys.length
      group.count += 1
      groups.set(key, group)
    }
  }
  const sorted = [...groups.values()].sort((left, right) => right.value - left.value || left.label.localeCompare(right.label, 'ru-RU'))
  if (sorted.length <= limit + 1) return { groups: sorted, rest: [] as string[] }
  const tail = sorted.slice(limit)
  return {
    groups: [...sorted.slice(0, limit), { key: BREAKDOWN_REST, label: 'Остальное', value: tail.reduce((sum, group) => sum + group.value, 0), count: tail.reduce((sum, group) => sum + group.count, 0) }],
    rest: tail.map((group) => group.key),
  }
}

// Оттенки цвета категории: от чуть темнее к заметно светлее, «Остальное» — нейтрально-серое.
export function breakdownColors(base: string, groups: Array<Pick<BreakdownGroup, 'key'>>) {
  const match = /^#([0-9a-f]{6})$/i.exec(base)
  const rgb = match ? [0, 2, 4].map((offset) => parseInt(match[1].slice(offset, offset + 2), 16)) : [117, 141, 105]
  const shades = groups.filter((group) => group.key !== BREAKDOWN_REST).length
  return groups.map((group, index) => {
    if (group.key === BREAKDOWN_REST) return '#a9afa5'
    const t = shades <= 1 ? 0 : -0.35 + 0.8 * index / (shades - 1)
    const target = t < 0 ? 0 : 255
    return `#${rgb.map((channel) => Math.round(channel + (target - channel) * Math.abs(t)).toString(16).padStart(2, '0')).join('')}`
  })
}
