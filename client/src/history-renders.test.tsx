// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatAnalyticsAmount } from './format'
import * as history from './history'
import { HistoryView } from './screens/History'
import * as workspaceApi from './workspace-api'
import type { Expense, WorkspaceBootstrap } from './types'

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
})

const at = '2026-08-01T00:00:00.000Z'
const today = new Date().toISOString()

function spent(id: string, amountMinor: number, currency = 'RSD', categoryId = 'products'): Expense {
  return { id, amountMinor, currency, categoryId, note: null, occurredAt: today, createdAt: today, updatedAt: today, version: 1, deletedAt: null }
}

// Две категории, две валюты по курсу снимка: 1 000 RSD и 10 EUR — это ≈ 2 170 RSD.
function workspace(overrides: Partial<WorkspaceBootstrap> = {}): WorkspaceBootstrap {
  const summary = { id: 'workspace-a', name: 'Дом', role: 'owner' as const, version: 1, joinedAt: at }
  return {
    workspaceId: summary.id,
    workspace: summary,
    categories: [
      { id: 'products', name: 'Продукты', color: '#758d69', placement: 'main', sortOrder: 0, createdAt: at, updatedAt: at, archivedAt: null, version: 1 },
      { id: 'home', name: 'Для дома', color: '#b08a5a', placement: 'main', sortOrder: 1, createdAt: at, updatedAt: at, archivedAt: null, version: 1 },
    ],
    tags: [],
    currencies: [{ code: 'RSD', name: 'Сербский динар', symbol: 'дин.', decimals: 2 }, { code: 'EUR', name: 'Евро', symbol: '€', decimals: 2 }],
    rates: { base: 'RSD', date: today.slice(0, 10), ratesToRsd: { RSD: 1, EUR: 117 } },
    expenses: [spent('a', 100_000), spent('b', 1_000, 'EUR', 'home')],
    defaultAnalyticsCurrency: 'RSD',
    serverTime: at,
    ...overrides,
  }
}

// Колбэки у приложения стабильны — так же и здесь.
const props = { userId: 'user-a', workspaceId: 'workspace-a', setBootstrap: vi.fn(), edit: vi.fn(), createNew: vi.fn(), refreshPending: vi.fn() }

const total = (container: HTMLElement) => container.querySelector('.history-total')?.textContent
const titles = (container: HTMLElement) => [...container.querySelectorAll('.history-row b')].map((node) => node.textContent)
const amounts = (container: HTMLElement) => [...container.querySelectorAll('.history-row strong')].map((node) => node.textContent)

describe('«История» recounts', () => {
  it('counts the year once when a filter changes, though the filter then goes into the workspace data', () => {
    vi.spyOn(workspaceApi, 'saveMemberSettings').mockImplementation(() => {})
    let data = workspace()
    // Как у приложения: фильтр уходит в bootstrap.settings, и вкладка получает новые данные пространства.
    function Harness() {
      const [bootstrap, setBootstrap] = useState(data)
      data = bootstrap
      return <HistoryView {...props} bootstrap={bootstrap} setBootstrap={setBootstrap}/>
    }
    render(<Harness/>)
    const passes = vi.spyOn(history, 'filterHistoryExpenses')

    fireEvent.click(screen.getByRole('button', { name: 'Период истории' }))
    fireEvent.click(screen.getByRole('button', { name: 'Сегодня' }))
    expect(data.settings?.historyFilters?.period).toBe('today')
    expect(passes).toHaveBeenCalledTimes(1)
  })

  it('does not recount for personal settings the list does not show', () => {
    const bootstrap = workspace()
    const { rerender } = render(<HistoryView {...props} bootstrap={bootstrap}/>)
    const passes = vi.spyOn(history, 'filterHistoryExpenses')
    rerender(<HistoryView {...props} bootstrap={{ ...bootstrap, settings: { lastCurrency: 'EUR' } }}/>)
    rerender(<HistoryView {...props} bootstrap={{ ...bootstrap, settings: { lastCurrency: 'EUR', historyFilters: { categoryIds: [], tagIds: [], currencies: [], period: 'all', from: '', to: '' } } }}/>)
    expect(passes).not.toHaveBeenCalled()
  })

  it('still shows a new expense, a renamed category, a new rate and every change of currency', () => {
    const bootstrap = workspace()
    const { container, rerender } = render(<HistoryView {...props} bootstrap={bootstrap}/>)
    expect(total(container)).toBe(`≈ ${formatAnalyticsAmount(2_170, 'RSD')}`)
    expect(titles(container)).toEqual(['Продукты', 'Для дома'])

    const more = { ...bootstrap, expenses: [spent('c', 30_000), ...bootstrap.expenses] }
    rerender(<HistoryView {...props} bootstrap={more}/>)
    expect(titles(container)).toHaveLength(3)
    expect(total(container)).toBe(`≈ ${formatAnalyticsAmount(2_470, 'RSD')}`)

    const renamed = { ...more, categories: more.categories.map((category) => category.id === 'home' ? { ...category, name: 'Дом и быт' } : category) }
    rerender(<HistoryView {...props} bootstrap={renamed}/>)
    expect(titles(container)).toEqual(['Продукты', 'Продукты', 'Дом и быт'])

    const rated = { ...renamed, rates: { ...renamed.rates, ratesToRsd: { RSD: 1, EUR: 120 } } }
    rerender(<HistoryView {...props} bootstrap={rated}/>)
    expect(total(container)).toBe(`≈ ${formatAnalyticsAmount(2_500, 'RSD')}`)

    // Валюта итога — валюта аналитики человека, без неё — валюта пространства, без неё — валюта по умолчанию.
    rerender(<HistoryView {...props} bootstrap={{ ...rated, settings: { analyticsCurrency: 'EUR' } }}/>)
    expect(total(container)).toBe(`≈ ${formatAnalyticsAmount(1_300 / 120 + 10, 'EUR')}`)
    rerender(<HistoryView {...props} bootstrap={{ ...rated, workspace: { ...rated.workspace, currency: 'EUR' } }}/>)
    expect(total(container)).toBe(`≈ ${formatAnalyticsAmount(1_300 / 120 + 10, 'EUR')}`)
    rerender(<HistoryView {...props} bootstrap={{ ...rated, defaultAnalyticsCurrency: 'EUR' }}/>)
    expect(total(container)).toBe(`≈ ${formatAnalyticsAmount(1_300 / 120 + 10, 'EUR')}`)

    // Справочник валют: у евро теперь нет копеек.
    const whole = { ...rated, currencies: rated.currencies.map((currency) => currency.code === 'EUR' ? { ...currency, decimals: 0 } : currency) }
    rerender(<HistoryView {...props} bootstrap={whole}/>)
    expect(amounts(container)[2]).toMatch(/^1\s000\s€$/)
  })

  it('orders the category filter as this person ordered «Расход»', () => {
    const bootstrap = workspace()
    const { rerender } = render(<HistoryView {...props} bootstrap={bootstrap}/>)
    fireEvent.click(screen.getByRole('button', { name: 'Категория истории' }))
    const options = () => screen.getAllByRole('option').map((option) => option.textContent)
    expect(options()).toEqual(['Все категории', 'Продукты', 'Для дома'])
    rerender(<HistoryView {...props} bootstrap={{ ...bootstrap, settings: { categoryOrder: { shown: ['home', 'products'], more: [] } } }}/>)
    expect(options()).toEqual(['Все категории', 'Для дома', 'Продукты'])
  })
})
