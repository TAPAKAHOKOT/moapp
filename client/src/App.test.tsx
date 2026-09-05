// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as accessFlow from './access-flow'
import { AnalyticsView, BybitReviewView, CapabilityScreen, CreateWorkspaceSheet, EntryView, fallbackAnalytics, formatEntryDate, formatHistoryDate, HistoryView, pagerTabsAt, RecoverySave, SettingsView, useToast, WorkspaceSwitcher } from './App'
import * as workspaceApi from './workspace-api'
import type { AuthenticatedSession, WorkspaceBootstrap } from './types'

// Фильтры истории выбирают несколько значений: шит остаётся открытым до «Готово».
function chooseOption(label: string, ...options: string[]) {
  fireEvent.click(screen.getByLabelText(label))
  for (const option of options) fireEvent.click(screen.getByRole('option', { name: (name) => name === option || name.startsWith(`${option}, `) }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Готово' }))
}

function choosePeriod(option: string) {
  fireEvent.click(screen.getByLabelText('Период истории'))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: option }))
}

// Даты в фильтрах выбираются в календарной шторке: листаем к нужному месяцу и нажимаем день.
function pickDay(label: string, dateKey: string) {
  if (!screen.queryByRole('dialog')) fireEvent.click(screen.getByLabelText(label))
  const dialog = screen.getByRole('dialog')
  const targetMonth = `${dateKey.slice(0, 7)}-01`
  for (let guard = 0; guard < 36; guard += 1) {
    const shown = dialog.querySelector<HTMLElement>('[data-month]')?.dataset.month ?? ''
    if (shown === targetMonth) break
    fireEvent.click(within(dialog).getByLabelText(shown < targetMonth ? 'Следующий месяц' : 'Предыдущий месяц'))
  }
  fireEvent.click(within(dialog).getByRole('button', { name: formatHistoryDate(dateKey) }))
}

const prepared = {
  recoveryUrl: `https://example.test/#/recover/${'a'.repeat(43)}`,
  completionToken: 'complete',
  expiresAt: '2030-01-01T00:00:00.000Z',
  nextGeneration: 1,
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true })
  Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: undefined })
  document.querySelectorAll('[data-test-opener]').forEach((node) => node.remove())
})

function ToastHarness() {
  const { toast, notify, dismiss } = useToast()
  return <>
    <button onClick={() => notify('Пространство создано')}>Создать</button>
    <button onClick={() => notify('Второе сообщение')}>Повторить</button>
    {toast && <button onClick={dismiss}>{toast.text}</button>}
  </>
}

function expenseBootstrap(overrides: Partial<WorkspaceBootstrap> = {}): WorkspaceBootstrap {
  const workspace = { id: 'workspace-a', name: 'Дом', role: 'owner' as const, version: 1, joinedAt: '2026-08-01T00:00:00.000Z' }
  return {
    workspaceId: workspace.id,
    workspace,
    categories: [{ id: 'products', name: 'Продукты', color: '#758d69', placement: 'main', sortOrder: 0, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', archivedAt: null, version: 1 }],
    currencies: [{ code: 'RSD', name: 'Сербский динар', symbol: 'дин.', decimals: 2 }],
    rates: { base: 'RSD', date: '2026-08-10', ratesToRsd: { RSD: 1 } },
    tags: [],
    expenses: [],
    defaultAnalyticsCurrency: 'RSD',
    serverTime: '2026-08-10T14:00:00.000Z',
    ...overrides,
  }
}

describe('global notices', () => {
  it('auto-dismisses a workspace-created notice and resets its timer for a new message', () => {
    vi.useFakeTimers()
    render(<ToastHarness />)

    fireEvent.click(screen.getByRole('button', { name: 'Создать' }))
    act(() => vi.advanceTimersByTime(2500))
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    act(() => vi.advanceTimersByTime(2500))
    expect(screen.getByRole('button', { name: 'Второе сообщение' })).not.toBeNull()

    act(() => vi.advanceTimersByTime(100))
    expect(screen.queryByRole('button', { name: 'Второе сообщение' })).toBeNull()
  })
})

describe('pager lazy mounting', () => {
  it('keeps entry alive and prepares only the pages touching the current swipe position', () => {
    expect(pagerTabsAt(0, 390)).toEqual(['entry'])
    expect(pagerTabsAt(390 * 1.25, 390)).toEqual(['entry', 'history', 'analytics'])
    expect(pagerTabsAt(390 * 3, 390)).toEqual(['entry', 'settings'])
    expect(pagerTabsAt(390 * 4, 390)).toEqual(['entry', 'settings'])
    expect(pagerTabsAt(390, 0)).toEqual(['entry'])
  })
})

describe('expense card swipe', () => {
  it('snaps back without changing expense when the pointer gesture is cancelled', () => {
    vi.useFakeTimers()
    const setCurrentId = vi.fn()
    const bootstrap: WorkspaceBootstrap = {
      workspaceId: 'workspace-a',
      workspace: { id: 'workspace-a', name: 'Дом', role: 'owner', version: 1, joinedAt: '2026-08-01T00:00:00.000Z' },
      categories: [{ id: 'products', name: 'Продукты', color: '#758d69', placement: 'main', sortOrder: 0, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', archivedAt: null, version: 1 }],
      currencies: [{ code: 'RSD', name: 'Сербский динар', symbol: 'дин.', decimals: 2 }],
      rates: { base: 'RSD', date: '2026-08-10', ratesToRsd: { RSD: 1 } },
      expenses: [
        { id: 'newer', amountMinor: 2_000, currency: 'RSD', categoryId: 'products', note: null, occurredAt: '2026-08-10T13:00:00.000Z', createdAt: '2026-08-10T13:00:00.000Z', updatedAt: '2026-08-10T13:00:00.000Z', version: 1, deletedAt: null },
        { id: 'older', amountMinor: 1_000, currency: 'RSD', categoryId: 'products', note: null, occurredAt: '2026-08-09T13:00:00.000Z', createdAt: '2026-08-09T13:00:00.000Z', updatedAt: '2026-08-09T13:00:00.000Z', version: 1, deletedAt: null },
      ],
      defaultAnalyticsCurrency: 'RSD',
      serverTime: '2026-08-10T14:00:00.000Z',
    }
    render(<EntryView
      userId="user-a"
      workspaceId="workspace-a"
      bootstrap={bootstrap}
      setBootstrap={vi.fn()}
      currentId="newer"
      setCurrentId={setCurrentId}
      refreshPending={vi.fn()}
      onDraftDirtyChange={vi.fn()}
      active
    />)
    const entry = screen.getByRole('region', { name: 'Ввод суммы' })
    const track = entry.querySelector<HTMLElement>('.entry-track')!

    fireEvent.pointerDown(entry, { pointerType: 'mouse', button: 0, clientX: 100, clientY: 20 })
    fireEvent.pointerMove(entry, { pointerType: 'mouse', clientX: 200, clientY: 20 })
    expect(track.style.transform).toBe('translateX(100px)')

    fireEvent.pointerCancel(entry, { pointerType: 'mouse' })
    act(() => vi.runAllTimers())

    expect(track.style.transform).toBe('')
    expect(setCurrentId).not.toHaveBeenCalled()
  })

  // Отдельной кнопки «новый расход» нет: пустая карточка лежит справа от самой свежей записи.
  it('swipes from the newest expense to a blank card', () => {
    vi.useFakeTimers()
    const setCurrentId = vi.fn()
    const bootstrap: WorkspaceBootstrap = {
      workspaceId: 'workspace-a',
      workspace: { id: 'workspace-a', name: 'Дом', role: 'owner', version: 1, joinedAt: '2026-08-01T00:00:00.000Z' },
      categories: [],
      currencies: [{ code: 'RSD', name: 'Сербский динар', symbol: 'дин.', decimals: 2 }],
      rates: { base: 'RSD', date: '2026-08-10', ratesToRsd: { RSD: 1 } },
      expenses: [{ id: 'old', amountMinor: 1_000, currency: 'RSD', categoryId: 'products', note: null, occurredAt: '2026-08-09T13:00:00.000Z', createdAt: '2026-08-09T13:00:00.000Z', updatedAt: '2026-08-09T13:00:00.000Z', version: 1, deletedAt: null }],
      defaultAnalyticsCurrency: 'RSD',
      serverTime: '2026-08-10T14:00:00.000Z',
    }
    render(<EntryView userId="user-a" workspaceId="workspace-a" bootstrap={bootstrap} setBootstrap={vi.fn()} currentId="old" setCurrentId={setCurrentId} refreshPending={vi.fn()} onDraftDirtyChange={vi.fn()} active/>)

    const entry = screen.getByRole('region', { name: 'Ввод суммы' })
    fireEvent.pointerDown(entry, { pointerType: 'mouse', button: 0, clientX: 300, clientY: 20 })
    fireEvent.pointerMove(entry, { pointerType: 'mouse', clientX: 150, clientY: 20 })
    fireEvent.pointerUp(entry, { pointerType: 'mouse', clientX: 150, clientY: 20 })
    act(() => vi.runAllTimers())

    expect(setCurrentId).toHaveBeenCalledWith(null)
  })

  it('asks before a swipe discards changes to the current expense', async () => {
    vi.useFakeTimers()
    const setCurrentId = vi.fn()
    const bootstrap = expenseBootstrap({ expenses: [
      { id: 'newer', amountMinor: 2_000, currency: 'RSD', categoryId: 'products', note: null, occurredAt: '2026-08-10T13:00:00.000Z', createdAt: '2026-08-10T13:00:00.000Z', updatedAt: '2026-08-10T13:00:00.000Z', version: 1, deletedAt: null },
      { id: 'older', amountMinor: 1_000, currency: 'RSD', categoryId: 'products', note: null, occurredAt: '2026-08-09T13:00:00.000Z', createdAt: '2026-08-09T13:00:00.000Z', updatedAt: '2026-08-09T13:00:00.000Z', version: 1, deletedAt: null },
    ] })
    render(<EntryView userId="user-a" workspaceId="workspace-a" bootstrap={bootstrap} setBootstrap={vi.fn()} currentId="newer" setCurrentId={setCurrentId} refreshPending={vi.fn()} onDraftDirtyChange={vi.fn()} active/>)
    fireEvent.click(screen.getByRole('button', { name: '1' }))
    const entry = screen.getByRole('region', { name: 'Ввод суммы' })
    fireEvent.pointerDown(entry, { pointerType: 'mouse', button: 0, clientX: 100, clientY: 20 })
    fireEvent.pointerMove(entry, { pointerType: 'mouse', clientX: 200, clientY: 20 })
    fireEvent.pointerUp(entry, { pointerType: 'mouse', clientX: 200, clientY: 20 })

    expect(screen.getByRole('alertdialog', { name: 'Перейти к другому расходу?' })).not.toBeNull()
    expect(setCurrentId).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))
    act(() => vi.runAllTimers())
    expect(setCurrentId).not.toHaveBeenCalled()
  })
})

describe('expense editing and saving', () => {
  it('uses an explicit save action for an existing expense and retains its archived category', async () => {
    const submit = vi.spyOn(workspaceApi, 'submitExpenseOperation').mockResolvedValue(null)
    const archived = { id: 'old-category', name: 'Старое кафе', color: '#758d69', placement: 'main' as const, sortOrder: 0, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z', archivedAt: '2026-08-03T00:00:00.000Z', version: 2 }
    const expense = { id: 'old', amountMinor: 1_000, currency: 'RSD', categoryId: archived.id, note: null, occurredAt: '2026-08-09T13:00:00.000Z', createdAt: '2026-08-09T13:00:00.000Z', updatedAt: '2026-08-09T13:00:00.000Z', version: 1, deletedAt: null }
    render(<EntryView userId="user-a" workspaceId="workspace-a" bootstrap={expenseBootstrap({ categories: [archived], expenses: [expense] })} setBootstrap={vi.fn()} currentId="old" setCurrentId={vi.fn()} refreshPending={vi.fn()} onDraftDirtyChange={vi.fn()} active/>)

    expect(screen.getByRole('region', { name: 'Ввод суммы' }).querySelector('.entry-save')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '1' }))
    expect(submit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /^Сохранить/ }))

    await waitFor(() => expect(submit).toHaveBeenCalled())
    expect(submit.mock.calls[0]?.[3]).toEqual(expect.objectContaining({ categoryId: archived.id }))
  })

  it('locks conflicting controls while a new expense is being saved', async () => {
    vi.spyOn(workspaceApi, 'submitExpenseOperation').mockImplementation(() => new Promise(() => {}))
    render(<EntryView userId="user-a" workspaceId="workspace-a" bootstrap={expenseBootstrap()} setBootstrap={vi.fn()} currentId={null} setCurrentId={vi.fn()} refreshPending={vi.fn()} onDraftDirtyChange={vi.fn()} active/>)

    expect(screen.queryByRole('button', { name: 'Удалить расход' })).toBeNull()
    // Плитка категории только выбирает; сохраняет одна кнопка, и до выбора она сообщает, чего не хватает.
    expect(screen.getByRole('button', { name: 'Введите сумму' })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '1' }))
    expect(screen.getByRole('button', { name: 'Выберите категорию' })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Продукты' }))
    expect(workspaceApi.submitExpenseOperation).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить 1 RSD' }))

    await waitFor(() => expect((screen.getByRole('button', { name: '1' }) as HTMLButtonElement).disabled).toBe(true))
    expect((screen.getByRole('button', { name: 'RSD' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Добавить заметку' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('expense dates', () => {
  it('shows a short weekday in entry and history dates', () => {
    expect(formatEntryDate('2026-08-30T09:37')).toBe('вс · 30 августа 2026, 09:37')
    expect(formatHistoryDate('2026-08-30')).toBe('вс · 30 августа 2026')
  })
})

describe('history discovery', () => {
  it('lets the recovery reminder be postponed and collapses it into one line after a few shows', () => {
    const bootstrap = expenseBootstrap({ expenses: [{ id: 'a', amountMinor: 1_000, currency: 'RSD', categoryId: 'products', note: null, occurredAt: '2026-08-31T09:37:00.000Z', createdAt: '2026-08-31T09:37:00.000Z', updatedAt: '2026-08-31T09:37:00.000Z', version: 1, deletedAt: null }] })
    const onSave = vi.fn(); const onLater = vi.fn()
    const { unmount } = render(<HistoryView userId="user-a" workspaceId="workspace-a" bootstrap={bootstrap} setBootstrap={vi.fn()} edit={vi.fn()} createNew={vi.fn()} refreshPending={vi.fn()} reminder={{ onSave, onLater, compact: false }}/>)
    expect(screen.getByText('Иначе без этого телефона расходы не вернуть')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Позже' }))
    expect(onLater).toHaveBeenCalledTimes(1)
    unmount()
    render(<HistoryView userId="user-a" workspaceId="workspace-a" bootstrap={bootstrap} setBootstrap={vi.fn()} edit={vi.fn()} createNew={vi.fn()} refreshPending={vi.fn()} reminder={{ onSave, onLater, compact: true }}/>)
    expect(screen.queryByText('Иначе без этого телефона расходы не вернуть')).toBeNull()
    expect(screen.getByText('Сохраните ссылку доступа')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('offers to load expenses older than the bootstrap window', () => {
    const bootstrap = expenseBootstrap({ expenses: [{ id: 'a', amountMinor: 1_000, currency: 'RSD', categoryId: 'products', note: null, occurredAt: '2026-08-31T09:37:00.000Z', createdAt: '2026-08-31T09:37:00.000Z', updatedAt: '2026-08-31T09:37:00.000Z', version: 1, deletedAt: null }], expensesSince: '2025-09-01', olderExpenses: 12 })
    const load = vi.fn()
    render(<HistoryView userId="user-a" workspaceId="workspace-a" bootstrap={bootstrap} setBootstrap={vi.fn()} edit={vi.fn()} createNew={vi.fn()} refreshPending={vi.fn()} older={{ count: 12, since: '2025-09-01', busy: false, load }}/>)
    expect(screen.getByText('Ещё 12 записей до сентября 2025')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Показать' }))
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('offers a first-expense action instead of a useless empty search field', () => {
    const createNew = vi.fn()
    render(<HistoryView userId="user-a" workspaceId="workspace-a" bootstrap={expenseBootstrap()} setBootstrap={vi.fn()} edit={vi.fn()} createNew={createNew} refreshPending={vi.fn()}/>)
    expect(screen.queryByRole('searchbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Добавить первый расход' }))
    expect(createNew).toHaveBeenCalledTimes(1)
  })

  it('searches expenses by note, amount and weekday-aware date', () => {
    const bootstrap = expenseBootstrap({ expenses: [{ id: 'expense-a', amountMinor: 12_345, currency: 'RSD', categoryId: 'products', note: 'IKEA полка', occurredAt: '2026-08-30T09:37:00.000Z', createdAt: '2026-08-30T09:37:00.000Z', updatedAt: '2026-08-30T09:37:00.000Z', version: 1, deletedAt: null }] })
    render(<HistoryView userId="user-a" workspaceId="workspace-a" bootstrap={bootstrap} setBootstrap={vi.fn()} edit={vi.fn()} createNew={vi.fn()} refreshPending={vi.fn()}/>)
    // Поле поиска скрыто за иконкой: экран начинается с записей, а не с фильтров.
    expect(screen.queryByRole('searchbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Поиск' }))
    const search = screen.getByRole('searchbox')
    fireEvent.change(search, { target: { value: 'полка' } })
    expect(screen.getByRole('button', { name: /Продукты/ })).not.toBeNull()
    fireEvent.change(search, { target: { value: 'вс' } })
    expect(screen.getByRole('button', { name: /Продукты/ })).not.toBeNull()
    fireEvent.change(search, { target: { value: '123,45' } })
    expect(screen.getByRole('button', { name: /Продукты/ })).not.toBeNull()
  })

  it('filters the visible history by category and period', () => {
    const transport = { id: 'transport', name: 'Транспорт', color: '#826f62', placement: 'main' as const, sortOrder: 1, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', archivedAt: null, version: 1 }
    const bootstrap = expenseBootstrap({
      categories: [...expenseBootstrap().categories, transport],
      expenses: [
        { id: 'products', amountMinor: 1_000, currency: 'RSD', categoryId: 'products', note: null, occurredAt: '2026-08-30T09:37:00.000Z', createdAt: '2026-08-30T09:37:00.000Z', updatedAt: '2026-08-30T09:37:00.000Z', version: 1, deletedAt: null },
        { id: 'transport', amountMinor: 2_000, currency: 'RSD', categoryId: 'transport', note: null, occurredAt: '2026-08-31T09:37:00.000Z', createdAt: '2026-08-31T09:37:00.000Z', updatedAt: '2026-08-31T09:37:00.000Z', version: 1, deletedAt: null },
      ],
    })
    render(<HistoryView userId="user-a" workspaceId="workspace-a" bootstrap={bootstrap} setBootstrap={vi.fn()} edit={vi.fn()} createNew={vi.fn()} refreshPending={vi.fn()}/>)

    chooseOption('Категория истории', 'Транспорт')
    expect(screen.queryByRole('button', { name: /Продукты/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Транспорт/ })).not.toBeNull()
    expect(screen.getByLabelText('Категория истории').textContent).toBe('Транспорт')

    // Вторая категория добавляется к первой («или»), чип показывает счёт.
    chooseOption('Категория истории', 'Продукты')
    expect(screen.getByRole('button', { name: /Продукты/ })).not.toBeNull()
    expect(screen.getByRole('button', { name: /Транспорт/ })).not.toBeNull()
    expect(screen.getByLabelText('Категория истории').textContent).toBe('2 категории')
    chooseOption('Категория истории', 'Продукты')
    expect(screen.queryByRole('button', { name: /Продукты/ })).toBeNull()

    // Один день — два тапа по одной дате в календаре диапазона.
    choosePeriod('Выбрать даты')
    pickDay('Период истории', '2026-08-30')
    pickDay('Период истории', '2026-08-30')
    expect(screen.getByText('Ничего не найдено')).not.toBeNull()
  })

  it('filters by currency and restores history filters after reopening', () => {
    const bootstrap = expenseBootstrap({
      currencies: [
        { code: 'RSD', name: 'Сербский динар', symbol: 'дин.', decimals: 2 },
        { code: 'EUR', name: 'Евро', symbol: '€', decimals: 2 },
      ],
      expenses: [
        { id: 'rsd', amountMinor: 1_000, currency: 'RSD', categoryId: 'products', note: 'рынок', occurredAt: '2026-08-31T09:37:00.000Z', createdAt: '2026-08-31T09:37:00.000Z', updatedAt: '2026-08-31T09:37:00.000Z', version: 1, deletedAt: null },
        { id: 'eur', amountMinor: 2_000, currency: 'EUR', categoryId: 'products', note: 'кофе', occurredAt: '2026-08-30T09:37:00.000Z', createdAt: '2026-08-30T09:37:00.000Z', updatedAt: '2026-08-30T09:37:00.000Z', version: 1, deletedAt: null },
      ],
    })
    const props = { userId: 'user-a', workspaceId: 'workspace-a', bootstrap, setBootstrap: vi.fn(), edit: vi.fn(), createNew: vi.fn(), refreshPending: vi.fn() }
    render(<HistoryView {...props}/>)

    chooseOption('Валюта истории', 'EUR')
    choosePeriod('Выбрать даты')
    pickDay('Период истории', '2026-08-30')
    pickDay('Период истории', '2026-08-30')
    fireEvent.click(screen.getByRole('button', { name: 'Поиск' }))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'кофе' } })
    expect(screen.getAllByRole('button', { name: /Продукты/ })).toHaveLength(1)

    cleanup()
    render(<HistoryView {...props}/>)

    // Чипы показывают само значение, а не «Все …»: так видно, что включено.
    expect(screen.getByLabelText('Валюта истории').textContent).toBe('EUR')
    expect(screen.getByLabelText('Период истории').textContent).toBe('30 авг. 2026')
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('кофе')
    expect(screen.getAllByRole('button', { name: /Продукты/ })).toHaveLength(1)
  })
})

describe('history totals', () => {
  it('shows the sum of the visible rows next to the counter', () => {
    const bootstrap = expenseBootstrap({ expenses: [
      { id: 'a', amountMinor: 1_000, currency: 'RSD', categoryId: 'products', note: null, occurredAt: '2026-08-31T09:37:00.000Z', createdAt: '2026-08-31T09:37:00.000Z', updatedAt: '2026-08-31T09:37:00.000Z', version: 1, deletedAt: null },
      { id: 'b', amountMinor: 2_000, currency: 'RSD', categoryId: 'products', note: 'кофе', occurredAt: '2026-08-30T09:37:00.000Z', createdAt: '2026-08-30T09:37:00.000Z', updatedAt: '2026-08-30T09:37:00.000Z', version: 1, deletedAt: null },
    ] })
    render(<HistoryView userId="user-a" workspaceId="workspace-a" bootstrap={bootstrap} setBootstrap={vi.fn()} edit={vi.fn()} createNew={vi.fn()} refreshPending={vi.fn()}/>)
    expect(screen.getByLabelText(/Сумма показанных расходов/).textContent).toMatch(/30,00\s*RSD/)
    fireEvent.click(screen.getByRole('button', { name: 'Поиск' }))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'кофе' } })
    expect(screen.getByLabelText(/Сумма показанных расходов/).textContent).toMatch(/20,00\s*RSD/)
  })

  it('closes a filter sheet from its × and keeps «Все категории» checked while nothing is chosen', () => {
    render(<HistoryView userId="user-a" workspaceId="workspace-a" bootstrap={expenseBootstrap({ expenses: [{ id: 'a', amountMinor: 1_000, currency: 'RSD', categoryId: 'products', note: null, occurredAt: '2026-08-31T09:37:00.000Z', createdAt: '2026-08-31T09:37:00.000Z', updatedAt: '2026-08-31T09:37:00.000Z', version: 1, deletedAt: null }] })} setBootstrap={vi.fn()} edit={vi.fn()} createNew={vi.fn()} refreshPending={vi.fn()}/>)
    fireEvent.click(screen.getByLabelText('Категория истории'))
    expect(screen.getByRole('option', { name: 'Все категории' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('analytics legend', () => {
  it('lists every category and unfolds the expenses behind a row', () => {
    const now = new Date().toISOString()
    const names = ['Продукты', 'Транспорт', 'Дом', 'Здоровье', 'Досуг', 'Прочее']
    const categories = names.map((name, index) => ({ id: `cat-${index}`, name, color: '#758d69', placement: 'main' as const, sortOrder: index, createdAt: now, updatedAt: now, archivedAt: null, version: 1 }))
    const expenses = categories.map((category, index) => ({ id: `exp-${index}`, amountMinor: (index + 1) * 1_000, currency: 'RSD', categoryId: category.id, note: index === 5 ? 'зонтик' : null, occurredAt: now, createdAt: now, updatedAt: now, version: 1, deletedAt: null }))
    render(<AnalyticsView userId="analytics-user" workspaceId="analytics-workspace" bootstrap={expenseBootstrap({ categories, expenses })} theme="light" online={false}/>)
    expect(screen.queryByText('Остальные')).toBeNull()
    const legendRows = () => screen.getAllByRole('button').filter((node) => node.classList.contains('legend-row'))
    expect(legendRows()).toHaveLength(6)
    // Тап по строке легенды — фокус: всё выше считается по этой категории, а её записи раскрываются.
    fireEvent.click(screen.getByRole('button', { name: /Прочее/ }))
    expect(screen.getByText(/зонтик/)).not.toBeNull()
    expect(screen.getByRole('button', { name: /Прочее/ }).getAttribute('aria-expanded')).toBe('true')
    expect(legendRows()).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Все категории' }))
    expect(legendRows()).toHaveLength(6)
  })
})

describe('analytics filters and fallback', () => {
  it('starts without a category filter and labels cached data with its timestamp', () => {
    const bootstrap = expenseBootstrap()
    render(<AnalyticsView userId="analytics-user" workspaceId="analytics-workspace" bootstrap={bootstrap} theme="light" online={false}/>)
    // Отдельного селекта категории нет: легенда и есть список категорий.
    expect(screen.queryByLabelText('Категория расходов')).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('Показаны сохранённые данные на')
  })
})

describe('offline analytics fallback', () => {
  it('reports an unavailable source rate and excludes that expense from converted totals', () => {
    const bootstrap: WorkspaceBootstrap = {
      workspaceId: 'workspace-a',
      workspace: { id: 'workspace-a', name: 'Дом', role: 'owner', version: 1, joinedAt: '2026-08-01T00:00:00.000Z' },
      categories: [{ id: 'products', name: 'Продукты', color: '#758d69', placement: 'main', sortOrder: 0, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', archivedAt: null, version: 1 }],
      currencies: [
        { code: 'RSD', name: 'Сербский динар', symbol: 'дин.', decimals: 2 },
        { code: 'EUR', name: 'Евро', symbol: '€', decimals: 2 },
      ],
      rates: { base: 'RSD', date: '2026-08-10', ratesToRsd: { RSD: 1 } },
      expenses: [
        { id: 'rsd', amountMinor: 1_000, currency: 'RSD', categoryId: 'products', note: null, occurredAt: '2026-08-10T12:00:00.000Z', createdAt: '2026-08-10T12:00:00.000Z', updatedAt: '2026-08-10T12:00:00.000Z', version: 1, deletedAt: null },
        { id: 'eur', amountMinor: 2_000, currency: 'EUR', categoryId: 'products', note: null, occurredAt: '2026-08-10T13:00:00.000Z', createdAt: '2026-08-10T13:00:00.000Z', updatedAt: '2026-08-10T13:00:00.000Z', version: 1, deletedAt: null },
      ],
      defaultAnalyticsCurrency: 'RSD',
      serverTime: '2026-08-10T14:00:00.000Z',
    }

    const analytics = fallbackAnalytics(bootstrap, 'RSD', '2026-08-10', '2026-08-10', null)

    expect(analytics.expenseCount).toBe(2)
    expect(analytics.convertedCount).toBe(1)
    expect(analytics.missingCurrencies).toEqual(['EUR'])
    expect(analytics.totalMinor).toBe(1_000)
    expect(analytics.daily).toEqual([{ date: '2026-08-10', amountMinor: 1_000, count: 1 }])
    expect(analytics.categories).toEqual([expect.objectContaining({ categoryId: 'products', amountMinor: 1_000, count: 1 })])

    const withoutTargetRate = fallbackAnalytics({
      ...bootstrap,
      currencies: [...bootstrap.currencies, { code: 'USD', name: 'Доллар США', symbol: '$', decimals: 2 }],
    }, 'USD', '2026-08-10', '2026-08-10', null)
    expect(withoutTargetRate.convertedCount).toBe(0)
    expect(withoutTargetRate.missingCurrencies).toEqual(['RSD', 'EUR'])
    expect(withoutTargetRate.totalMinor).toBe(0)
  })
})

describe('Bybit transaction review', () => {
  it('undoes from a toast and restores the chosen category and comment', async () => {
    const transaction = {
      id: 'card-transaction-a', txnId: 'bybit-a', orderNo: null, type: 'purchase' as const, settled: true,
      amountMinor: 1_250, currency: 'RSD', merchantName: 'Coffee Corner', merchantCountry: 'RS', merchantCity: 'Beograd',
      mccCode: '5812', merchantCategory: 'Cafe', occurredAt: '2026-08-10T12:00:00.000Z', reviewStatus: 'pending' as const, expenseId: null,
    }
    const expense = {
      id: 'expense-a', amountMinor: transaction.amountMinor, currency: transaction.currency, categoryId: 'products', note: 'Coffee Corner · Встреча с Димой',
      occurredAt: transaction.occurredAt, createdAt: '2026-08-10T14:00:00.000Z', updatedAt: '2026-08-10T14:00:00.000Z', version: 1, deletedAt: null,
    }
    vi.spyOn(workspaceApi, 'listBybitCardTransactions').mockResolvedValue({ transactions: [transaction], pendingCount: 1 })
    vi.spyOn(workspaceApi, 'classifyBybitCardTransaction').mockResolvedValue({ transaction: { ...transaction, reviewStatus: 'classified', expenseId: expense.id }, expense, pendingCount: 0 })
    vi.spyOn(workspaceApi, 'undoBybitCardTransaction').mockResolvedValue({ transaction, undoneExpenseId: expense.id, pendingCount: 1 })
    const onExpenseUndo = vi.fn()

    render(<BybitReviewView workspaceId="workspace-a" categories={expenseBootstrap().categories} currencies={expenseBootstrap().currencies} online onExpense={vi.fn()} onExpenseUndo={onExpenseUndo} onStatus={vi.fn()}/>)

    await screen.findByText('Coffee Corner')
    expect(screen.getByLabelText('Сумма').textContent).toBe('12,50')
    expect(screen.getByText('RSD', { exact: true })).not.toBeNull()
    expect(screen.queryByText(/Свайп/)).toBeNull()
    // Заметка — тот же ряд «Дополнительно», что на расходе, и тот же шит.
    fireEvent.click(screen.getByRole('button', { name: 'Добавить заметку' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Заметка' }), { target: { value: 'Встреча с Димой' } })
    fireEvent.click(screen.getByRole('button', { name: 'Готово' }))
    fireEvent.click(screen.getByRole('button', { name: 'Продукты' }))
    expect(workspaceApi.classifyBybitCardTransaction).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /^Сохранить/ }))
    await screen.findByText('Расход добавлен')
    expect(workspaceApi.classifyBybitCardTransaction).toHaveBeenCalledWith('workspace-a', transaction.id, 'products', 'Встреча с Димой', [])

    fireEvent.click(screen.getByRole('button', { name: 'Отменить' }))
    await screen.findByText('Coffee Corner')
    await waitFor(() => expect(onExpenseUndo).toHaveBeenCalledWith(expense.id))
    expect(screen.getByRole('button', { name: 'Заметка: Встреча с Димой' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Продукты' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('reloads the queue when a sync elsewhere raises the pending count and marks open authorizations', async () => {
    const base = {
      txnId: null, orderNo: null, type: 'purchase' as const, currency: 'RSD', merchantCountry: 'SRB', merchantCity: 'Belgrade',
      mccCode: '5411', merchantCategory: null, reviewStatus: 'pending' as const, expenseId: null,
    }
    const first = { ...base, id: 'txn-1', settled: true, amountMinor: 86_036, merchantName: 'VERO 3', occurredAt: '2026-09-02T17:22:09.000Z' }
    const second = { ...base, id: 'txn-2', settled: false, amountMinor: 383_500, merchantName: 'Silver Dreams', occurredAt: '2026-09-03T08:00:00.000Z' }
    const list = vi.spyOn(workspaceApi, 'listBybitCardTransactions')
      .mockResolvedValueOnce({ transactions: [first], pendingCount: 1 })
      .mockResolvedValueOnce({ transactions: [first, second], pendingCount: 2 })
    const onStatus = vi.fn()
    const props = { workspaceId: 'workspace-a', categories: expenseBootstrap().categories, currencies: expenseBootstrap().currencies, online: true, onExpense: vi.fn(), onExpenseUndo: vi.fn(), onStatus, active: true }

    const view = render(<BybitReviewView {...props} pendingCount={1}/>)
    await screen.findByText('VERO 3')
    fireEvent.click(screen.getByRole('button', { name: 'Добавить заметку' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Заметка' }), { target: { value: 'черновик' } })
    fireEvent.click(screen.getByRole('button', { name: 'Готово' }))
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1))

    // Settings → "Обновить" reports a higher pendingCount through the shared status.
    view.rerender(<BybitReviewView {...props} pendingCount={2}/>)
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    await screen.findByText(/В очереди · 2/)
    expect(screen.getByText('VERO 3')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Заметка: черновик' })).not.toBeNull()
    expect(onStatus).toHaveBeenLastCalledWith({ pendingCount: 2 })

    fireEvent.click(screen.getByRole('button', { name: 'Пропустить' }))
    await screen.findByText('Silver Dreams')
    expect(screen.getByText(/Ожидает списания/)).not.toBeNull()
  })

  // Разбор берёт ряд категорий у расхода: плитками только основные, остальные — за «Ещё N».
  it('shows only main categories with a "more" tile, and picking from the sheet selects without saving', async () => {
    const transaction = {
      id: 'card-transaction-b', txnId: 'bybit-b', orderNo: null, type: 'purchase' as const, settled: true,
      amountMinor: 4_200, currency: 'RSD', merchantName: 'Maxi', merchantCountry: 'RS', merchantCity: 'Beograd',
      mccCode: '5411', merchantCategory: 'Grocery', occurredAt: '2026-08-10T12:00:00.000Z', reviewStatus: 'pending' as const, expenseId: null,
    }
    const categories = [
      { id: 'products', name: 'Продукты', color: '#758d69', placement: 'main' as const, sortOrder: 0, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', archivedAt: null, version: 1 },
      { id: 'home', name: 'Для дома', color: '#7d9db4', placement: 'additional' as const, sortOrder: 0, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', archivedAt: null, version: 1 },
      { id: 'fun', name: 'Развлечения', color: '#aa8aaf', placement: 'additional' as const, sortOrder: 1, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', archivedAt: null, version: 1 },
    ]
    vi.spyOn(workspaceApi, 'listBybitCardTransactions').mockResolvedValue({ transactions: [transaction], pendingCount: 1 })
    const classify = vi.spyOn(workspaceApi, 'classifyBybitCardTransaction')

    const { container } = render(<BybitReviewView workspaceId="workspace-a" categories={categories} currencies={expenseBootstrap().currencies} online onExpense={vi.fn()} onExpenseUndo={vi.fn()} onStatus={vi.fn()}/>)
    await screen.findByText('Maxi')

    const tiles = [...container.querySelectorAll('.main-categories button')].map((node) => node.textContent)
    expect(tiles).toEqual(['Продукты', 'Ещё 2'])
    expect(screen.queryByRole('button', { name: 'Развлечения' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Ещё 2' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Другие категории' })).getByRole('button', { name: 'Развлечения' }))

    // Выбор в шите, как и плитка, только выделяет категорию; сохраняет кнопка.
    expect(classify).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
    const other = container.querySelector('.main-categories button:last-child')
    expect(other?.textContent).toBe('Развлечения')
    expect(other?.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: /^Сохранить/ }))
    await waitFor(() => expect(classify).toHaveBeenCalledWith('workspace-a', transaction.id, 'fun', '', []))
  })

  // Крупные суммы иначе упирались в многоточие: порог общий для карточки расхода и строки разбора.
  it('sizes the amount by its digit count on both the entry and the review screen', async () => {
    const transaction = {
      id: 'card-transaction-c', txnId: 'bybit-c', orderNo: null, type: 'purchase' as const, settled: true,
      amountMinor: 20_000_000, currency: 'RSD', merchantName: 'Stan i komunalije', merchantCountry: 'RS', merchantCity: 'Beograd',
      mccCode: '6513', merchantCategory: 'Rent', occurredAt: '2026-08-10T12:00:00.000Z', reviewStatus: 'pending' as const, expenseId: null,
    }
    vi.spyOn(workspaceApi, 'listBybitCardTransactions').mockResolvedValue({ transactions: [transaction], pendingCount: 1 })
    render(<BybitReviewView workspaceId="workspace-a" categories={expenseBootstrap().categories} currencies={expenseBootstrap().currencies} online onExpense={vi.fn()} onExpenseUndo={vi.fn()} onStatus={vi.fn()}/>)

    await screen.findByText('Stan i komunalije')
    const reviewAmount = screen.getByLabelText('Сумма')
    expect(reviewAmount.textContent?.replace(/\s/g, ' ')).toBe('200 000,00')
    expect(reviewAmount.getAttribute('data-size')).toBe('medium')
    cleanup()

    render(<EntryView userId="user-a" workspaceId="workspace-a" bootstrap={expenseBootstrap()} setBootstrap={vi.fn()} currentId={null} setCurrentId={vi.fn()} refreshPending={vi.fn()} onDraftDirtyChange={vi.fn()} active/>)
    const entryAmount = () => screen.getByRole('region', { name: 'Ввод суммы' }).querySelector('.entry-card:not(.aside) .amount-value')
    expect(entryAmount()?.getAttribute('data-size')).toBe('normal')
    for (const key of '12345678') fireEvent.click(screen.getByRole('button', { name: key }))
    expect(entryAmount()?.getAttribute('data-size')).toBe('medium')
    for (const key of '9012') fireEvent.click(screen.getByRole('button', { name: key }))
    expect(entryAmount()?.getAttribute('data-size')).toBe('long')
  })

  // Предупреждение об открытой авторизации — главный текст экрана, а внутри карточки мерчанта
  // оно наследовало nowrap + ellipsis и обрезалось на полуслове.
  it('renders the open-authorization warning in full outside the merchant card', async () => {
    const transaction = {
      id: 'card-transaction-d', txnId: 'bybit-d', orderNo: null, type: 'purchase' as const, settled: false,
      amountMinor: 120_000, currency: 'RSD', merchantName: 'Pending Authorization', merchantCountry: 'RS', merchantCity: 'Beograd',
      mccCode: '5999', merchantCategory: 'Retail', occurredAt: '2026-08-10T12:00:00.000Z', reviewStatus: 'pending' as const, expenseId: null,
    }
    vi.spyOn(workspaceApi, 'listBybitCardTransactions').mockResolvedValue({ transactions: [transaction], pendingCount: 1 })
    const { container } = render(<BybitReviewView workspaceId="workspace-a" categories={expenseBootstrap().categories} currencies={expenseBootstrap().currencies} online onExpense={vi.fn()} onExpenseUndo={vi.fn()} onStatus={vi.fn()}/>)

    await screen.findByText('Pending Authorization')
    const warning = screen.getByText('Ожидает списания · сумма может уточниться после расчёта')
    expect(warning.closest('.review-merchant')).toBeNull()
    expect(container.querySelector('.review-merchant .review-pending-note')).toBeNull()
    expect(warning.className).toBe('review-pending-note')
  })

  it('keeps the warning out of settled operations', async () => {
    const settled = {
      id: 'card-transaction-e', txnId: 'bybit-e', orderNo: null, type: 'purchase' as const, settled: true,
      amountMinor: 1_000, currency: 'RSD', merchantName: 'Coffee Corner', merchantCountry: 'RS', merchantCity: 'Beograd',
      mccCode: '5812', merchantCategory: 'Cafe', occurredAt: '2026-08-10T12:00:00.000Z', reviewStatus: 'pending' as const, expenseId: null,
    }
    vi.spyOn(workspaceApi, 'listBybitCardTransactions').mockResolvedValue({ transactions: [settled], pendingCount: 1 })
    render(<BybitReviewView workspaceId="workspace-a" categories={expenseBootstrap().categories} currencies={expenseBootstrap().currencies} online onExpense={vi.fn()} onExpenseUndo={vi.fn()} onStatus={vi.fn()}/>)

    await screen.findByText('Coffee Corner')
    expect(screen.queryByText(/Ожидает списания/)).toBeNull()
  })
})

describe('settings identity transitions', () => {
  it('lists settings as plain rows and opens categories in a sheet', async () => {
    vi.spyOn(workspaceApi, 'listMembers').mockResolvedValue({ members: [] })
    vi.spyOn(workspaceApi, 'listSessions').mockResolvedValue({ sessions: [] })
    vi.spyOn(workspaceApi, 'listInvitations').mockResolvedValue({ invitations: [] })
    const workspace = expenseBootstrap().workspace
    const user: AuthenticatedSession = { authenticated: true, user: { id: 'user-a', displayName: 'Аня', recoveryConfigured: true, recoveryGeneration: 1 }, currentSessionId: 'session-a', currentSessionExpiresAt: '2030-01-01T00:00:00.000Z', serverTime: '2026-08-10T14:00:00.000Z', restrictedToRecovery: false, workspaces: [workspace], legacyWorkspaceId: null }
    render(<SettingsView user={user} workspace={workspace} workspaceId={workspace.id} bootstrap={expenseBootstrap()} setBootstrap={vi.fn()} pendingCount={0} refreshPending={vi.fn()} onLogout={vi.fn()} theme="system" onThemeChange={vi.fn()} onSession={vi.fn()} online bybitStatus={{connected:true,canManage:true,pendingCount:3,enabledAt:'2026-08-10T12:00:00.000Z',status:'active'}}/>)

    // Ни сегментов, ни заголовков-эйбрау: сразу строки с понятиями и значениями.
    expect(screen.queryByText('Люди и доступ')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Настройки' })).toBeNull()
    expect(screen.getByRole('button', { name: /Название пространства/ }).textContent).toContain('Дом')
    expect(screen.getByRole('button', { name: /Карта Bybit/ }).textContent).toContain('подключена')
    expect(screen.getByRole('button', { name: /^Тема/ }).textContent).toContain('Как в системе')
    expect(screen.queryByRole('button', { name: 'Новая категория' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Категории/ }))
    expect(screen.getByRole('dialog', { name: 'Категории' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Новая категория' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: /Поднять категорию/ })).toBeNull()
  })

  it('tells the person why «Обновить» fetched nothing from Bybit', async () => {
    vi.spyOn(workspaceApi, 'listMembers').mockResolvedValue({ members: [] })
    vi.spyOn(workspaceApi, 'listSessions').mockResolvedValue({ sessions: [] })
    vi.spyOn(workspaceApi, 'listInvitations').mockResolvedValue({ invitations: [] })
    const status = { connected: true, canManage: true, pendingCount: 1, enabledAt: '2026-08-10T12:00:00.000Z', lastSyncedAt: '2026-09-05T08:00:00.000Z', status: 'active' as const }
    const sync = vi.spyOn(workspaceApi, 'syncBybitCard').mockResolvedValue({ ...status, imported: 0, throttled: true })
    const workspace = expenseBootstrap().workspace
    const user: AuthenticatedSession = { authenticated: true, user: { id: 'user-a', displayName: 'Аня', recoveryConfigured: true, recoveryGeneration: 1 }, currentSessionId: 'session-a', currentSessionExpiresAt: '2030-01-01T00:00:00.000Z', serverTime: '2026-08-10T14:00:00.000Z', restrictedToRecovery: false, workspaces: [workspace], legacyWorkspaceId: null }
    render(<SettingsView user={user} workspace={workspace} workspaceId={workspace.id} bootstrap={expenseBootstrap()} setBootstrap={vi.fn()} pendingCount={0} refreshPending={vi.fn()} onLogout={vi.fn()} theme="system" onThemeChange={vi.fn()} onSession={vi.fn()} online bybitStatus={status}/>)

    fireEvent.click(screen.getByRole('button', { name: /Карта Bybit/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Обновить' }))
    // Сервер не ходит в Bybit чаще раза в минуту; молчание выглядело бы как сломанная кнопка.
    await screen.findByText('Уже актуально: обновлялось меньше минуты назад')
    expect(sync).toHaveBeenCalledWith(workspace.id)
  })

  it('prevents logout while a settings mutation can still return a session', async () => {
    vi.spyOn(workspaceApi, 'listMembers').mockResolvedValue({ members: [] })
    vi.spyOn(workspaceApi, 'listSessions').mockResolvedValue({ sessions: [] })
    vi.spyOn(workspaceApi, 'listInvitations').mockResolvedValue({ invitations: [] })
    vi.spyOn(workspaceApi, 'createInvitation').mockImplementation(() => new Promise(() => {}))
    const workspace = { id: 'workspace-a', name: 'Дом', role: 'owner' as const, version: 1, joinedAt: '2026-08-01T00:00:00.000Z' }
    const user: AuthenticatedSession = {
      authenticated: true,
      user: { id: 'user-a', displayName: 'Аня', recoveryConfigured: true, recoveryGeneration: 1 },
      currentSessionId: 'session-a', currentSessionExpiresAt: '2030-01-01T00:00:00.000Z', serverTime: '2026-08-10T14:00:00.000Z',
      restrictedToRecovery: false, workspaces: [workspace], legacyWorkspaceId: null,
    }
    const bootstrap: WorkspaceBootstrap = {
      workspaceId: workspace.id, workspace, categories: [],
      currencies: [{ code: 'RSD', name: 'Сербский динар', symbol: 'дин.', decimals: 2 }],
      rates: { base: 'RSD', date: '2026-08-10', ratesToRsd: { RSD: 1 } }, expenses: [],
      defaultAnalyticsCurrency: 'RSD', serverTime: '2026-08-10T14:00:00.000Z',
    }
    const logout = vi.fn()
    render(<SettingsView
      user={user} workspace={workspace} workspaceId={workspace.id} bootstrap={bootstrap} setBootstrap={vi.fn()}
      pendingCount={0} refreshPending={vi.fn()} onLogout={logout} theme="light" onThemeChange={vi.fn()}
      onSession={vi.fn().mockResolvedValue(undefined)} online
    />)

    fireEvent.click(screen.getByRole('button', { name: /^Участники/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Пригласить человека' }))

    // Пока шит занят запросом, фон под ним скрыт от читалок, но строка «Выйти» уже должна быть выключена.
    const logoutButton = screen.getByRole('button', { name: 'Выйти', hidden: true }) as HTMLButtonElement
    await waitFor(() => expect(logoutButton.disabled).toBe(true))
    fireEvent.click(logoutButton)
    expect(logout).not.toHaveBeenCalled()
  })

  it('confirms invitation and device revocation before changing access', async () => {
    const invitation = { id: 'invite-a', workspaceId: 'workspace-a', expiresAt: '2030-01-01T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z' }
    vi.spyOn(workspaceApi, 'listMembers').mockResolvedValue({ members: [] })
    vi.spyOn(workspaceApi, 'listSessions').mockResolvedValue({ sessions: [{ id: 'device-a', label: 'iPad', current: false, createdAt: '2026-08-01T00:00:00.000Z', lastSeenAt: '2026-08-10T00:00:00.000Z', expiresAt: '2030-01-01T00:00:00.000Z' }] })
    vi.spyOn(workspaceApi, 'listInvitations').mockResolvedValue({ invitations: [invitation] })
    const revokeInvite = vi.spyOn(workspaceApi, 'revokeInvitation').mockResolvedValue(undefined)
    const revokeDevice = vi.spyOn(workspaceApi, 'revokeSession').mockResolvedValue(undefined)
    const workspace = expenseBootstrap().workspace
    const user: AuthenticatedSession = { authenticated: true, user: { id: 'user-a', displayName: 'Аня', recoveryConfigured: true, recoveryGeneration: 1 }, currentSessionId: 'session-a', currentSessionExpiresAt: '2030-01-01T00:00:00.000Z', serverTime: '2026-08-10T14:00:00.000Z', restrictedToRecovery: false, workspaces: [workspace], legacyWorkspaceId: null }
    render(<SettingsView user={user} workspace={workspace} workspaceId={workspace.id} bootstrap={expenseBootstrap()} setBootstrap={vi.fn()} pendingCount={0} refreshPending={vi.fn()} onLogout={vi.fn()} theme="light" onThemeChange={vi.fn()} onSession={vi.fn()} online/>)

    fireEvent.click(screen.getByRole('button', { name: /^Участники/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Отозвать' }))
    expect(await screen.findByRole('alertdialog', { name: 'Отозвать приглашение?' })).not.toBeNull()
    expect(revokeInvite).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }))

    fireEvent.click(screen.getByRole('button', { name: /Другие устройства/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Отключить' }))
    expect(await screen.findByRole('alertdialog', { name: 'Отключить устройство?' })).not.toBeNull()
    expect(revokeDevice).not.toHaveBeenCalled()
  })

  it('exports every expense to a UTF-8 CSV file from settings', () => {
    const bootstrap = expenseBootstrap({
      currencies: [
        { code: 'RSD', name: 'Сербский динар', symbol: 'дин.', decimals: 2 },
        { code: 'EUR', name: 'Евро', symbol: '€', decimals: 2 },
      ],
      expenses: [
        { id: 'rsd-row', amountMinor: 1_000, currency: 'RSD', categoryId: 'products', note: null, occurredAt: '2026-08-31T09:37:00.000Z', createdAt: '2026-08-31T09:37:00.000Z', updatedAt: '2026-08-31T09:37:00.000Z', version: 1, deletedAt: null },
        { id: 'eur-row', amountMinor: 2_000, currency: 'EUR', categoryId: 'products', note: 'кофе', occurredAt: '2026-08-30T09:37:00.000Z', createdAt: '2026-08-30T09:37:00.000Z', updatedAt: '2026-08-30T09:37:00.000Z', version: 1, deletedAt: null },
        { id: 'gone', amountMinor: 500, currency: 'RSD', categoryId: 'products', note: null, occurredAt: '2026-08-29T09:37:00.000Z', createdAt: '2026-08-29T09:37:00.000Z', updatedAt: '2026-08-29T09:37:00.000Z', version: 2, deletedAt: '2026-08-30T00:00:00.000Z' },
      ],
    })
    const originalBlob = Blob
    const createdParts: BlobPart[][] = []
    vi.stubGlobal('Blob', class extends originalBlob {
      constructor(parts: BlobPart[] = [], options?: BlobPropertyBag) {
        super(parts, options)
        createdParts.push(parts)
      }
    })
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:history') })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    let download = ''
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { download = this.download })
    vi.spyOn(workspaceApi, 'listMembers').mockResolvedValue({ members: [] })
    vi.spyOn(workspaceApi, 'listSessions').mockResolvedValue({ sessions: [] })
    vi.spyOn(workspaceApi, 'listInvitations').mockResolvedValue({ invitations: [] })
    const workspace = bootstrap.workspace
    const user: AuthenticatedSession = { authenticated: true, user: { id: 'user-a', displayName: 'Аня', recoveryConfigured: true, recoveryGeneration: 1 }, currentSessionId: 'session-a', currentSessionExpiresAt: '2030-01-01T00:00:00.000Z', serverTime: '2026-08-10T14:00:00.000Z', restrictedToRecovery: false, workspaces: [workspace], legacyWorkspaceId: null }
    render(<SettingsView user={user} workspace={workspace} workspaceId={workspace.id} bootstrap={bootstrap} setBootstrap={vi.fn()} pendingCount={0} refreshPending={vi.fn()} onLogout={vi.fn()} theme="light" onThemeChange={vi.fn()} onSession={vi.fn()} online/>)

    fireEvent.click(screen.getByRole('button', { name: 'Экспорт в CSV' }))

    expect(createdParts[0]?.[0]).toBe('﻿')
    expect(String(createdParts[0]?.[1])).toContain('eur-row')
    expect(String(createdParts[0]?.[1])).toContain('rsd-row')
    expect(String(createdParts[0]?.[1])).not.toContain('gone')
    expect(download).toMatch(/^moapp-history-\d{4}-\d{2}-\d{2}\.csv$/)
    expect(screen.getByText('Экспортировано расходов: 2')).not.toBeNull()
  })

  it('keeps the old name and explains why when saving a new one fails', async () => {
    vi.spyOn(workspaceApi, 'listMembers').mockResolvedValue({ members: [] })
    vi.spyOn(workspaceApi, 'listSessions').mockResolvedValue({ sessions: [] })
    vi.spyOn(workspaceApi, 'listInvitations').mockResolvedValue({ invitations: [] })
    vi.spyOn(workspaceApi, 'updateProfile').mockRejectedValue(new Error('Нет связи'))
    const workspace = expenseBootstrap().workspace
    const user: AuthenticatedSession = { authenticated: true, user: { id: 'user-a', displayName: 'Аня', recoveryConfigured: true, recoveryGeneration: 1 }, currentSessionId: 'session-a', currentSessionExpiresAt: '2030-01-01T00:00:00.000Z', serverTime: '2026-08-10T14:00:00.000Z', restrictedToRecovery: false, workspaces: [workspace], legacyWorkspaceId: null }
    render(<SettingsView user={user} workspace={workspace} workspaceId={workspace.id} bootstrap={expenseBootstrap()} setBootstrap={vi.fn()} pendingCount={0} refreshPending={vi.fn()} onLogout={vi.fn()} theme="light" onThemeChange={vi.fn()} onSession={vi.fn()} online/>)
    fireEvent.click(screen.getByRole('button', { name: /Ваше имя/ }))
    const input = screen.getByRole('textbox', { name: 'Ваше имя' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Новое имя' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    expect((await screen.findByRole('alert')).textContent).toBe('Нет связи')
    expect(screen.getByRole('dialog', { name: 'Ваше имя' })).not.toBeNull()
    expect(screen.getByRole('button', { name: /Ваше имя/, hidden: true }).textContent).toContain('Аня')
  })
})

describe('workspace onboarding controls', () => {
  it('shows Russian inline validation without invoking native browser messages', () => {
    const create = vi.fn().mockResolvedValue(undefined)
    render(<CreateWorkspaceSheet existing={false} onClose={vi.fn()} onCreate={create}/>)

    fireEvent.click(screen.getByRole('button', { name: 'Создать пространство' }))
    expect(screen.getByRole('alert').textContent).toBe('Введите ваше имя.')
    expect(screen.getByLabelText('Как вас называть').getAttribute('aria-invalid')).toBe('true')

    fireEvent.change(screen.getByLabelText('Как вас называть'), { target: { value: 'Аня' } })
    fireEvent.click(screen.getByRole('button', { name: 'Создать пространство' }))
    expect(screen.getByRole('alert').textContent).toBe('Введите название пространства.')
    expect(screen.getByLabelText('Название пространства').getAttribute('aria-invalid')).toBe('true')
    expect(create).not.toHaveBeenCalled()
  })

  it('requires a guest display name before creation', async () => {
    const create = vi.fn().mockResolvedValue(undefined)
    render(<CreateWorkspaceSheet existing={false} onClose={vi.fn()} onCreate={create}/>)
    fireEvent.change(screen.getByLabelText('Как вас называть'), { target: { value: 'Аня' } })
    fireEvent.change(screen.getByLabelText('Название пространства'), { target: { value: 'Дом' } })
    fireEvent.submit(screen.getByRole('button', { name: 'Создать пространство' }).closest('form')!)
    expect(create).toHaveBeenCalledWith(expect.any(String), 'Дом', 'Аня')
  })

  it('keeps the workspace UUID when the create sheet is submitted again', async () => {
    const create = vi.fn().mockResolvedValue(undefined)
    render(<CreateWorkspaceSheet existing onClose={vi.fn()} onCreate={create}/>)
    fireEvent.change(screen.getByLabelText('Название пространства'), { target: { value: 'Дом' } })

    fireEvent.click(screen.getByRole('button', { name: 'Создать пространство' }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Создать пространство' }) as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(screen.getByRole('button', { name: 'Создать пространство' }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
    expect(create.mock.calls[1][0]).toBe(create.mock.calls[0][0])
  })

  it('does not offer uncached workspaces while offline', () => {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false })
    const select = vi.fn()
    render(<WorkspaceSwitcher active="a" onCreate={vi.fn()} onSelect={select} runtimes={{ a: { workspaceId: 'a', bootstrap: {} as never, source: 'cache', status: 'ready', offline: true, outbox: { total: 0, conflicts: 0, failed: 0 }, requestEpoch: 0 } }} items={[{ id: 'a', name: 'A', role: 'owner', version: 1, joinedAt: '' }, { id: 'b', name: 'B', role: 'member', version: 1, joinedAt: '' }]}/>)
    expect((screen.getByRole('button', { name: /B/ }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Создать пространство' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('button', { name: /A/ }).getAttribute('aria-pressed')).toBe('true')
  })

  it('shows pending changes and allows switching to a cached workspace offline', () => {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false })
    const select = vi.fn()
    render(<WorkspaceSwitcher
      active="a"
      onCreate={vi.fn()}
      onSelect={select}
      items={[
        { id: 'a', name: 'A', role: 'owner', version: 1, joinedAt: '' },
        { id: 'b', name: 'Кэш', role: 'member', version: 1, joinedAt: '' },
      ]}
      runtimes={{
        a: { workspaceId: 'a', bootstrap: {} as never, source: 'cache', status: 'ready', offline: true, outbox: { total: 0, conflicts: 0, failed: 0 }, requestEpoch: 0 },
        b: { workspaceId: 'b', bootstrap: {} as never, source: 'cache', status: 'ready', offline: true, outbox: { total: 3, conflicts: 1, failed: 0 }, requestEpoch: 0 },
      }}
    />)

    const cached = screen.getByRole('button', { name: /Кэш/ })
    expect((cached as HTMLButtonElement).disabled).toBe(false)
    expect(cached.textContent).toContain('Участник · 3')
    fireEvent.click(cached)
    expect(select).toHaveBeenCalledWith('b')
  })

  it('exposes the create sheet as a modal, traps Tab and closes it with Escape', async () => {
    const opener = document.createElement('button')
    opener.dataset.testOpener = ''
    opener.textContent = 'Открыть'
    document.body.append(opener)
    opener.focus()
    const close = vi.fn()
    const view = render(<CreateWorkspaceSheet existing onClose={close} onCreate={vi.fn().mockResolvedValue(undefined)}/>)

    const dialog = screen.getByRole('dialog', { name: 'Создать пространство' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    const closeButton = screen.getByRole('button', { name: 'Закрыть' })
    await waitFor(() => expect(document.activeElement).toBe(closeButton))

    const cancel = screen.getByRole('button', { name: 'Отмена' })
    cancel.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(closeButton)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(close).toHaveBeenCalledTimes(1)
    view.unmount()
    await waitFor(() => expect(document.activeElement).toBe(opener))
    opener.remove()
  })

  it('keeps focus inside while busy changes dismissibility and restores the original opener', async () => {
    const opener = document.createElement('button')
    opener.dataset.testOpener = ''
    opener.textContent = 'Открыть создание'
    document.body.append(opener)
    opener.focus()
    let finishCreate!: () => void
    const create = vi.fn(() => new Promise<void>((resolve) => { finishCreate = resolve }))
    const view = render(<CreateWorkspaceSheet existing onClose={vi.fn()} onCreate={create}/>)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Закрыть' })))

    fireEvent.change(screen.getByLabelText('Название пространства'), { target: { value: 'Дом' } })
    const submit = screen.getByRole('button', { name: 'Создать пространство' })
    submit.focus()
    fireEvent.click(submit)
    await screen.findByRole('button', { name: 'Создаём…' })
    await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())) })

    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
    expect(document.activeElement).not.toBe(opener)

    view.unmount()
    await waitFor(() => expect(document.activeElement).toBe(opener))
    finishCreate()
    opener.remove()
  })

  it('skips a disabled preferred initial-focus target', async () => {
    const opener = document.createElement('button')
    opener.dataset.testOpener = ''
    opener.textContent = 'Открыть пространства'
    document.body.append(opener)
    opener.focus()
    const view = render(<WorkspaceSwitcher
      active="a"
      online={false}
      onCreate={vi.fn()}
      onSelect={vi.fn()}
      runtimes={{}}
      items={[{ id: 'a', name: 'A', role: 'owner', version: 1, joinedAt: '' }]}
    />)

    expect((screen.getByRole('button', { name: /A/ }) as HTMLButtonElement).disabled).toBe(true)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Закрыть' })))

    view.unmount()
    await waitFor(() => expect(document.activeElement).toBe(opener))
    opener.remove()
  })

  it('restores shared background state when stacked dialogs unmount together', async () => {
    const outside = document.createElement('button')
    outside.textContent = 'Фоновое действие'
    const originalInert = outside.inert
    document.body.append(outside)
    const view = render(<>
      <CreateWorkspaceSheet existing onClose={vi.fn()} onCreate={vi.fn().mockResolvedValue(undefined)}/>
      <WorkspaceSwitcher active="a" onCreate={vi.fn()} onSelect={vi.fn()} runtimes={{}} items={[{ id: 'a', name: 'A', role: 'owner', version: 1, joinedAt: '' }]}/>
    </>)
    expect(await screen.findAllByRole('dialog', { hidden: true })).toHaveLength(2)
    expect(outside.inert).toBe(true)

    view.unmount()

    expect(outside.inert).toBe(originalInert)
    expect(outside.getAttribute('aria-hidden')).toBeNull()
    outside.remove()
  })

  it('confirms the link by itself once it is copied and hides «Позже» in blocking mode', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText } })
    const complete = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn()
    render(<RecoverySave prepared={prepared} complete={complete} close={close} allowLater={false}/>)
    expect(screen.queryByRole('button', { name: 'Позже' })).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    // Один шаг: скопировал — ссылка подтверждена и шит закрыт, без чекбокса и «Завершить».
    fireEvent.click(screen.getByRole('button', { name: 'Скопировать' }))
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1))
    expect(writeText).toHaveBeenCalledWith(prepared.recoveryUrl)
  })

  it('explains the difference between initial, rotating and public recovery links', () => {
    const complete = vi.fn().mockResolvedValue(undefined)
    const initial = render(<RecoverySave prepared={prepared} complete={complete} close={vi.fn()} mode="initial"/>)
    expect(screen.getByText(/показать эту ссылку снова будет нельзя/i)).not.toBeNull()
    initial.unmount()

    const rotation = render(<RecoverySave prepared={prepared} complete={complete} close={vi.fn()} mode="rotation"/>)
    expect(screen.getByText(/старая ссылка сразу перестанет работать/i)).not.toBeNull()
    rotation.unmount()

    render(<RecoverySave prepared={prepared} complete={complete} close={vi.fn()} mode="public"/>)
    expect(screen.getByText(/все прежние устройства будут отключены/i)).not.toBeNull()
  })

  it('keeps the link visible after an error and closes after a successful retry', async () => {
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } })
    const complete = vi.fn()
      .mockRejectedValueOnce(new Error('Связь прервалась'))
      .mockResolvedValueOnce(undefined)
    const close = vi.fn()
    render(<RecoverySave prepared={prepared} complete={complete} close={close} mode="rotation" allowLater={false}/>)

    fireEvent.click(screen.getByRole('button', { name: 'Скопировать' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Связь прервалась')
    expect(screen.getByText(prepared.recoveryUrl)).not.toBeNull()
    expect(close).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1))
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('starts on the copy action and restores focus to the opener on close', async () => {
    const opener = document.createElement('button')
    opener.textContent = 'Открыть восстановление'
    document.body.append(opener)
    opener.focus()
    const close = vi.fn()
    const view = render(<RecoverySave prepared={prepared} complete={vi.fn().mockResolvedValue(undefined)} close={close} mode="rotation"/>)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Скопировать' })))

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(close).toHaveBeenCalledTimes(1)

    view.unmount()
    await waitFor(() => expect(document.activeElement).toBe(opener))
    opener.remove()
  })

  it('confirms that the recovery link was copied', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<RecoverySave prepared={prepared} complete={vi.fn().mockResolvedValue(undefined)} close={vi.fn()}/>)

    fireEvent.click(screen.getByRole('button', { name: 'Скопировать' }))

    expect((await screen.findByRole('status')).textContent).toBe('Ссылка скопирована')
    expect(writeText).toHaveBeenCalledWith(prepared.recoveryUrl)
  })

  it('keeps a visible fallback when clipboard access is unavailable', async () => {
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: undefined })
    const complete = vi.fn().mockResolvedValue(undefined)
    render(<RecoverySave prepared={prepared} complete={complete} close={vi.fn()}/>)

    fireEvent.click(screen.getByRole('button', { name: 'Скопировать' }))

    expect((await screen.findByRole('alert')).textContent).toContain('Копирование недоступно')
    expect(screen.getByText(prepared.recoveryUrl)).not.toBeNull()
    expect(complete).not.toHaveBeenCalled()
  })

  it('retries a transient capability action with the same in-memory token and attempt', async () => {
    const token = 'A'.repeat(43)
    const accepted: AuthenticatedSession = {
      authenticated: true,
      user: { id: 'user-a', displayName: 'Аня', recoveryConfigured: true, recoveryGeneration: 1 },
      currentSessionId: 'session-a',
      currentSessionExpiresAt: '2030-01-01T00:00:00.000Z',
      serverTime: '2026-01-01T00:00:00.000Z',
      restrictedToRecovery: false,
      workspaces: [],
      legacyWorkspaceId: null,
    }
    vi.spyOn(workspaceApi, 'previewDeviceLink').mockResolvedValue({
      kind: 'device', targetUserId: 'user-a', displayName: 'Аня', expiresAt: '2030-01-01T00:00:00.000Z',
    })
    const accept = vi.spyOn(accessFlow, 'acceptDeviceWithProbe')
      .mockRejectedValueOnce(new Error('Временная ошибка сети'))
      .mockResolvedValueOnce(accepted)
    const finish = vi.fn().mockResolvedValue(undefined)

    render(<CapabilityScreen
      intent={{ kind: 'device', token }}
      session={null}
      knownUserId={null}
      finish={finish}
      close={vi.fn()}
      resolveIdentityConflict={vi.fn()}
    />)

    const connect = await screen.findByRole('button', { name: 'Подключить' })
    await waitFor(() => expect((connect as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(connect)
    expect(await screen.findByText('Временная ошибка сети')).not.toBeNull()
    expect((connect as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(connect)
    await waitFor(() => expect(finish).toHaveBeenCalledWith(accepted))
    expect(accept).toHaveBeenCalledTimes(2)
    expect(accept.mock.calls[1]?.[0]).toBe(token)
    expect(accept.mock.calls[1]?.[1]).toBe(accept.mock.calls[0]?.[1])
  })

  it('turns an action-time identity mismatch into the explicit logout flow', async () => {
    vi.spyOn(workspaceApi, 'previewDeviceLink').mockResolvedValue({
      kind: 'device', targetUserId: 'user-a', displayName: 'Аня', expiresAt: '2030-01-01T00:00:00.000Z',
    })
    vi.spyOn(accessFlow, 'acceptDeviceWithProbe').mockRejectedValue(
      new accessFlow.AccessFlowError('IDENTITY_CONFLICT', 'Эта ссылка предназначена для другого профиля'),
    )

    render(<CapabilityScreen
      intent={{ kind: 'device', token: 'A'.repeat(43) }}
      session={null}
      knownUserId={null}
      finish={vi.fn()}
      close={vi.fn()}
      resolveIdentityConflict={vi.fn()}
    />)

    const connect = await screen.findByRole('button', { name: 'Подключить' })
    await waitFor(() => expect((connect as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(connect)

    expect(await screen.findByRole('button', { name: 'Выйти и продолжить' })).not.toBeNull()
    expect(screen.getByText(/ссылка от другого профиля/i)).not.toBeNull()
  })
})
