// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as accessFlow from './access-flow'
import App, { AnalyticsView, CardReviewView, CapabilityScreen, CreateWorkspaceSheet, EntryView, fallbackAnalytics, formatEntryDate, formatHistoryDate, HistoryView, pagerTabsAt, RecoverySave, SettingsView, useToast, WorkspaceSwitcher } from './App'
import { splitDraft, SplitSheet } from './screens/Split'
import { entryUnits, usualExpenses } from './screens/Entry'
import { ModsView, readStatementFile, statementFeedback } from './screens/Mods'
import * as workspaceApi from './workspace-api'
import * as workspaceOffline from './workspace-offline'
import { queuedMemberSettings } from './settings'
import type { AccountSettings, AuthenticatedSession, Category, WorkspaceBootstrap, WorkspaceMod } from './types'

// Графики проверяет AnalyticsCharts.test.tsx. Здесь они только мешают: chart.js в jsdom падает, когда график
// перестраивается при смене недели на месяц, — а экраны проверяются по карточкам и числам.
vi.mock('./AnalyticsCharts', () => ({ default: () => null }))

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
      workspace={bootstrap.workspace}
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

    expect(track.style.transform).toBe('translateX(0px)')
    expect(setCurrentId).not.toHaveBeenCalled()
  })

  // Пустая карточка лежит справа от самой свежей записи; с более глубоких записей к ней везёт «Новый» (ниже).
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
    render(<EntryView userId="user-a" workspaceId="workspace-a" workspace={expenseBootstrap().workspace} bootstrap={bootstrap} setBootstrap={vi.fn()} currentId="old" setCurrentId={setCurrentId} refreshPending={vi.fn()} onDraftDirtyChange={vi.fn()} active/>)

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
    render(<EntryView userId="user-a" workspaceId="workspace-a" workspace={expenseBootstrap().workspace} bootstrap={bootstrap} setBootstrap={vi.fn()} currentId="newer" setCurrentId={setCurrentId} refreshPending={vi.fn()} onDraftDirtyChange={vi.fn()} active/>)
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

  const savedExpense = (id: string, day: number) => {
    const at = `2026-08-${String(day).padStart(2, '0')}T13:00:00.000Z`
    return { id, amountMinor: 1_000, currency: 'RSD', categoryId: 'products', note: null, occurredAt: at, createdAt: at, updatedAt: at, version: 1, deletedAt: null }
  }

  // «Новый» в углу записи везёт к пустой карточке той же лентой, что и свайп, но сразу — даже если новее есть ещё записи.
  it('jumps from a deep record straight to the blank card with «Новый»', () => {
    vi.useFakeTimers()
    const setCurrentId = vi.fn()
    const bootstrap = expenseBootstrap({ expenses: [savedExpense('newest', 10), savedExpense('middle', 9), savedExpense('oldest', 8)] })
    render(<EntryView userId="user-a" workspaceId="workspace-a" workspace={bootstrap.workspace} bootstrap={bootstrap} setBootstrap={vi.fn()} currentId="oldest" setCurrentId={setCurrentId} refreshPending={vi.fn()} onDraftDirtyChange={vi.fn()} active/>)
    const entry = screen.getByRole('region', { name: 'Ввод суммы' })
    expect(entry.querySelector('.entry-card.aside.newer .eyebrow')?.textContent).toBe('Сохранённый расход')

    fireEvent.click(screen.getByRole('button', { name: 'Новый расход' }))
    expect(entry.querySelector('.entry-card.aside.newer .eyebrow')?.textContent).toBe('Новый расход')
    expect(setCurrentId).not.toHaveBeenCalled()
    act(() => vi.runAllTimers())
    expect(setCurrentId).toHaveBeenCalledWith(null)
  })

  it('hides «Новый» on the blank card and asks before it discards edits', () => {
    vi.useFakeTimers()
    const setCurrentId = vi.fn()
    const bootstrap = expenseBootstrap({ expenses: [savedExpense('old', 9)] })
    const view = (currentId: string | null) => <EntryView userId="user-a" workspaceId="workspace-a" workspace={bootstrap.workspace} bootstrap={bootstrap} setBootstrap={vi.fn()} currentId={currentId} setCurrentId={setCurrentId} refreshPending={vi.fn()} onDraftDirtyChange={vi.fn()} active/>
    const { rerender } = render(view(null))
    expect(screen.queryByRole('button', { name: 'Новый расход' })).toBeNull()

    rerender(view('old'))
    fireEvent.click(screen.getByRole('button', { name: '1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Новый расход' }))
    expect(screen.getByRole('alertdialog', { name: 'Перейти к новому расходу?' })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))
    act(() => vi.runAllTimers())
    expect(setCurrentId).not.toHaveBeenCalled()
  })

  // Повторный тап по активной вкладке «Расход» просит карточку о том же переезде; при монтировании счётчик ничего не запускает.
  it('returns to the blank card when the active «Расход» tab is tapped again', () => {
    vi.useFakeTimers()
    const setCurrentId = vi.fn()
    const bootstrap = expenseBootstrap({ expenses: [savedExpense('old', 9)] })
    const view = (request: number) => <EntryView userId="user-a" workspaceId="workspace-a" workspace={bootstrap.workspace} bootstrap={bootstrap} setBootstrap={vi.fn()} currentId="old" setCurrentId={setCurrentId} refreshPending={vi.fn()} onDraftDirtyChange={vi.fn()} active newExpenseRequest={request}/>
    const { rerender } = render(view(2))
    act(() => vi.runAllTimers())
    expect(setCurrentId).not.toHaveBeenCalled()

    rerender(view(3))
    act(() => vi.runAllTimers())
    expect(setCurrentId).toHaveBeenCalledWith(null)
  })
})

describe('expense editing and saving', () => {
  it('uses an explicit save action for an existing expense and retains its archived category', async () => {
    const submit = vi.spyOn(workspaceApi, 'submitExpenseOperation').mockResolvedValue(null)
    const archived = { id: 'old-category', name: 'Старое кафе', color: '#758d69', placement: 'main' as const, sortOrder: 0, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z', archivedAt: '2026-08-03T00:00:00.000Z', version: 2 }
    const expense = { id: 'old', amountMinor: 1_000, currency: 'RSD', categoryId: archived.id, note: null, occurredAt: '2026-08-09T13:00:00.000Z', createdAt: '2026-08-09T13:00:00.000Z', updatedAt: '2026-08-09T13:00:00.000Z', version: 1, deletedAt: null }
    render(<EntryView userId="user-a" workspaceId="workspace-a" workspace={expenseBootstrap().workspace} bootstrap={expenseBootstrap({ categories: [archived], expenses: [expense] })} setBootstrap={vi.fn()} currentId="old" setCurrentId={vi.fn()} refreshPending={vi.fn()} onDraftDirtyChange={vi.fn()} active/>)

    expect(screen.getByRole('region', { name: 'Ввод суммы' }).querySelector('.entry-save')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '1' }))
    expect(submit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /^Сохранить/ }))

    await waitFor(() => expect(submit).toHaveBeenCalled())
    expect(submit.mock.calls[0]?.[3]).toEqual(expect.objectContaining({ categoryId: archived.id }))
  })

  it('starts a new expense in the workspace currency when none was chosen by hand', () => {
    const dinar = (id: string, occurredAt: string) => ({ id, amountMinor: 1_000, currency: 'RSD', categoryId: 'products', note: null, occurredAt, createdAt: occurredAt, updatedAt: occurredAt, version: 1, deletedAt: null })
    const workspace = { ...expenseBootstrap().workspace, currency: 'EUR' }
    const bootstrap = expenseBootstrap({
      workspace,
      currencies: [{ code: 'RSD', name: 'Сербский динар', symbol: 'дин.', decimals: 2 }, { code: 'EUR', name: 'Евро', symbol: '€', decimals: 2 }],
      // Записи в динарах не перебивают настройку: валюта пространства задаётся явно, а не угадывается по частоте.
      expenses: [dinar('a', '2026-08-08T12:00:00.000Z'), dinar('b', '2026-08-09T12:00:00.000Z')],
    })
    render(<EntryView userId="user-a" workspaceId="workspace-a" workspace={workspace} bootstrap={bootstrap} setBootstrap={vi.fn()} currentId={null} setCurrentId={vi.fn()} refreshPending={vi.fn()} onDraftDirtyChange={vi.fn()} active/>)
    expect(screen.getByRole('button', { name: 'EUR' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'RSD' })).toBeNull()
  })

  it('moves an untouched new expense to the workspace currency changed in settings, but keeps a typed amount', () => {
    const currencies = [{ code: 'RSD', name: 'Сербский динар', symbol: 'дин.', decimals: 2 }, { code: 'EUR', name: 'Евро', symbol: '€', decimals: 2 }]
    const view = (currency: string) => <EntryView userId="user-a" workspaceId="workspace-a" workspace={{ ...expenseBootstrap().workspace, currency }} bootstrap={expenseBootstrap({ workspace: { ...expenseBootstrap().workspace, currency }, currencies })} setBootstrap={vi.fn()} currentId={null} setCurrentId={vi.fn()} refreshPending={vi.fn()} onDraftDirtyChange={vi.fn()} active/>
    const { rerender } = render(view('RSD'))
    expect(screen.getByRole('button', { name: 'RSD' })).not.toBeNull()
    rerender(view('EUR'))
    expect(screen.getByRole('button', { name: 'EUR' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'RSD' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '5' }))
    rerender(view('RSD'))
    expect(screen.getByRole('button', { name: 'EUR' })).not.toBeNull()
  })

  // Первый сохранённый расход объясняется один раз: владельцу — где позвать домашних, участнику — что запись видна всем.
  it('explains the very first saved expense once and then goes back to the short toast', async () => {
    vi.spyOn(workspaceApi, 'submitExpenseOperation').mockResolvedValue(null)
    const addOne = () => {
      fireEvent.click(screen.getByRole('button', { name: '1' }))
      fireEvent.click(screen.getByRole('button', { name: 'Продукты' }))
      fireEvent.click(screen.getByRole('button', { name: 'Сохранить 1 RSD' }))
    }
    const owner = render(<EntryView userId="user-a" workspaceId="workspace-a" workspace={expenseBootstrap().workspace} bootstrap={expenseBootstrap()} setBootstrap={vi.fn()} currentId={null} setCurrentId={vi.fn()} refreshPending={vi.fn()} onDraftDirtyChange={vi.fn()} active/>)
    addOne()
    expect(await screen.findByText('Записано. Домашних можно пригласить в настройках, строка «Участники»')).not.toBeNull()
    addOne()
    expect(await screen.findByText('Расход добавлен')).not.toBeNull()
    owner.unmount()

    const member = { ...expenseBootstrap().workspace, id: 'workspace-b', name: 'Семья', role: 'member' as const }
    render(<EntryView userId="user-a" workspaceId="workspace-b" workspace={member} bootstrap={expenseBootstrap({ workspaceId: 'workspace-b', workspace: member })} setBootstrap={vi.fn()} currentId={null} setCurrentId={vi.fn()} refreshPending={vi.fn()} onDraftDirtyChange={vi.fn()} active/>)
    addOne()
    expect(await screen.findByText('Записано. Видно всем в «Семья»')).not.toBeNull()
  })

  it('locks conflicting controls while a new expense is being saved', async () => {
    vi.spyOn(workspaceApi, 'submitExpenseOperation').mockImplementation(() => new Promise(() => {}))
    render(<EntryView userId="user-a" workspaceId="workspace-a" workspace={expenseBootstrap().workspace} bootstrap={expenseBootstrap()} setBootstrap={vi.fn()} currentId={null} setCurrentId={vi.fn()} refreshPending={vi.fn()} onDraftDirtyChange={vi.fn()} active/>)

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
    expect(document.activeElement).toBe(search)
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

  it('filters by currency and restores history filters after reopening, but not the search text', () => {
    let bootstrap = expenseBootstrap({
      currencies: [
        { code: 'RSD', name: 'Сербский динар', symbol: 'дин.', decimals: 2 },
        { code: 'EUR', name: 'Евро', symbol: '€', decimals: 2 },
      ],
      expenses: [
        { id: 'rsd', amountMinor: 1_000, currency: 'RSD', categoryId: 'products', note: 'рынок', occurredAt: '2026-08-31T09:37:00.000Z', createdAt: '2026-08-31T09:37:00.000Z', updatedAt: '2026-08-31T09:37:00.000Z', version: 1, deletedAt: null },
        { id: 'eur', amountMinor: 2_000, currency: 'EUR', categoryId: 'products', note: 'кофе', occurredAt: '2026-08-30T09:37:00.000Z', createdAt: '2026-08-30T09:37:00.000Z', updatedAt: '2026-08-30T09:37:00.000Z', version: 1, deletedAt: null },
      ],
    })
    // Фильтры живут в настройках пространства: экран кладёт их в данные, откуда их возьмёт следующее открытие.
    const setBootstrap = vi.fn((action: React.SetStateAction<WorkspaceBootstrap>) => { bootstrap = typeof action === 'function' ? action(bootstrap) : action })
    const props = () => ({ userId: 'user-a', workspaceId: 'workspace-a', bootstrap, setBootstrap, edit: vi.fn(), createNew: vi.fn(), refreshPending: vi.fn() })
    render(<HistoryView {...props()}/>)

    chooseOption('Валюта истории', 'EUR')
    choosePeriod('Выбрать даты')
    pickDay('Период истории', '2026-08-30')
    pickDay('Период истории', '2026-08-30')
    fireEvent.click(screen.getByRole('button', { name: 'Поиск' }))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'кофе' } })
    expect(screen.getAllByRole('button', { name: /Продукты/ })).toHaveLength(1)

    cleanup()
    render(<HistoryView {...props()}/>)

    // Чипы показывают само значение, а не «Все …»: так видно, что включено.
    expect(screen.getByLabelText('Валюта истории').textContent).toBe('EUR')
    expect(screen.getByLabelText('Период истории').textContent).toBe('30 авг. 2026')
    // Поиск разовый: в аккаунт он не уходит и при следующем открытии не возвращается.
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(bootstrap.settings?.historyFilters).toEqual({ categoryIds: [], tagIds: [], currencies: ['EUR'], period: 'range', from: '2026-08-30', to: '2026-08-30' })
    expect(queuedMemberSettings('user-a', 'workspace-a').historyFilters).toEqual(bootstrap.settings?.historyFilters)
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

  it('signs an unfolded expense with its tag, and falls back to the card statement name only without one', () => {
    const now = new Date().toISOString()
    const tags = [{ id: 'tag-youtube', name: 'ютуб', color: null, sortOrder: 0, createdAt: now, updatedAt: now, version: 1 }]
    const expense = (id: string, note: string | null, tagIds?: string[]) =>
      ({ id, amountMinor: 1_000, currency: 'RSD', categoryId: 'products', note, tagIds, occurredAt: now, createdAt: now, updatedAt: now, version: 1, deletedAt: null })
    const expenses = [expense('tagged', 'GOOGLE *YouTubePremium', ['tag-youtube']), expense('untagged', 'CONTABO* HOLD ONLY')]
    render(<AnalyticsView userId="analytics-user" workspaceId="analytics-workspace" bootstrap={expenseBootstrap({ tags, expenses })} theme="light" online={false}/>)

    fireEvent.click(screen.getByRole('button', { name: /Продукты/ }))
    const details = document.querySelectorAll('.legend-detail')
    expect(details[0].textContent).toMatch(/#ютуб/)
    expect(details[0].textContent).not.toMatch(/YouTubePremium/)
    expect(details[1].textContent).toMatch(/CONTABO\* HOLD ONLY/)
  })

  it('shows what an unfolded category is made of, and narrows its records to the tapped part', () => {
    const now = new Date().toISOString()
    const tags = ['впн', 'йеттел'].map((name, index) => ({ id: `tag-${name}`, name, color: null, sortOrder: index, createdAt: now, updatedAt: now, version: 1 }))
    const expense = (id: string, amountMinor: number, tagIds: string[]) =>
      ({ id, amountMinor, currency: 'RSD', categoryId: 'products', note: null, tagIds, occurredAt: now, createdAt: now, updatedAt: now, version: 1, deletedAt: null })
    const expenses = [expense('vpn-1', 30_000, ['tag-впн']), expense('vpn-2', 45_000, ['tag-впн']), expense('phone', 25_000, ['tag-йеттел'])]
    render(<AnalyticsView userId="analytics-user" workspaceId="analytics-workspace" bootstrap={expenseBootstrap({ tags, expenses })} theme="light" online={false}/>)

    fireEvent.click(screen.getByRole('button', { name: /Продукты/ }))
    const parts = [...document.querySelectorAll('.legend-group')].map((node) => node.textContent)
    expect(parts).toEqual([expect.stringMatching(/#впн · 2.*75%/), expect.stringMatching(/#йеттел.*25%/)])
    expect(document.querySelectorAll('.legend-detail')).toHaveLength(3)
    const part = () => [...document.querySelectorAll<HTMLButtonElement>('.legend-group')].find((node) => node.textContent?.includes('#йеттел'))!
    fireEvent.click(part())
    expect(document.querySelectorAll('.legend-detail')).toHaveLength(1)
    fireEvent.click(part())
    expect(document.querySelectorAll('.legend-detail')).toHaveLength(3)
  })
})

describe('analytics tags', () => {
  it('lists tags with their share, and a tapped tag narrows the page to its records', () => {
    const now = new Date().toISOString()
    const tags = ['впн', 'дайс', 'кофе'].map((name, index) => ({ id: `tag-${name}`, name, color: null, sortOrder: index, createdAt: now, updatedAt: now, version: 1 }))
    const expense = (id: string, amountMinor: number, categoryId: string, tagIds: string[], note: string | null = null) =>
      ({ id, amountMinor, currency: 'RSD', categoryId, note, tagIds, occurredAt: now, createdAt: now, updatedAt: now, version: 1, deletedAt: null })
    const expenses = [expense('vpn', 10_000, 'subscriptions', ['tag-впн']), expense('vpn-dice', 20_000, 'subscriptions', ['tag-впн', 'tag-дайс']), expense('coffee', 5_000, 'eating-out', ['tag-кофе']), expense('bread', 5_000, 'products', [], 'PEKARA')]
    const bootstrap = expenseBootstrap({ tags, expenses })
    const withCategories = { ...bootstrap, categories: ['subscriptions', 'eating-out', 'products'].map((id, index) => ({ id, name: ['Подписки', 'Кафе', 'Продукты'][index], color: '#758d69', placement: 'main' as const, sortOrder: index, createdAt: now, updatedAt: now, archivedAt: null, version: 1 })) }
    render(<AnalyticsView userId="analytics-user" workspaceId="analytics-workspace" bootstrap={withCategories} theme="light" online={false}/>)

    const tagRows = () => [...document.querySelectorAll('.tag-legend .legend-row')].map((node) => node.textContent)
    expect(tagRows()).toEqual([expect.stringMatching(/#впн.*50%/), expect.stringMatching(/#дайс.*25%/), expect.stringMatching(/#кофе.*13%/), expect.stringMatching(/Без тега.*13%/)])
    fireEvent.click(document.querySelector<HTMLButtonElement>('.tag-legend .legend-row')!)
    expect(document.querySelector('.analytics-title .eyebrow')?.textContent).toBe('#впн')
    expect(tagRows()).toEqual([expect.stringMatching(/#впн.*200/)])
    const details = [...document.querySelectorAll('.tag-legend .legend-detail')].map((node) => node.textContent)
    expect(details).toEqual([expect.stringMatching(/Подписки/), expect.stringMatching(/Подписки · #дайс/)])
    fireEvent.click(screen.getByRole('button', { name: 'Все теги' }))
    expect(tagRows()).toHaveLength(4)
  })
})

describe('analytics filters and fallback', () => {
  it('tells an empty workspace what analytics will show, and an empty period that records exist elsewhere', () => {
    const empty = render(<AnalyticsView userId="analytics-user" workspaceId="analytics-workspace" bootstrap={expenseBootstrap()} theme="light" online={false}/>)
    expect(screen.getAllByText('Появится после первых трат: сколько за месяц и на что')).toHaveLength(2)
    expect(screen.queryByText('В этом периоде ещё нет расходов')).toBeNull()
    empty.unmount()

    const old = { id: 'old', amountMinor: 1_000, currency: 'RSD', categoryId: 'products', note: null, occurredAt: '2020-01-10T12:00:00.000Z', createdAt: '2020-01-10T12:00:00.000Z', updatedAt: '2020-01-10T12:00:00.000Z', version: 1, deletedAt: null }
    render(<AnalyticsView userId="analytics-user" workspaceId="analytics-workspace" bootstrap={expenseBootstrap({ expenses: [old] })} theme="light" online={false}/>)
    expect(screen.getAllByText('В этом периоде ещё нет расходов')).toHaveLength(2)
    expect(screen.queryByText('Появится после первых трат: сколько за месяц и на что')).toBeNull()
  })

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

describe('card transaction review', () => {
  it('undoes from a toast and restores the chosen category and comment', async () => {
    const transaction = {
      id: 'card-transaction-a', source: 'bybit-card' as const, txnId: 'bybit-a', orderNo: null, type: 'purchase' as const, settled: true,
      amountMinor: 1_250, currency: 'RSD', merchantName: 'Coffee Corner', merchantCountry: 'RS', merchantCity: 'Beograd',
      mccCode: '5812', merchantCategory: 'Cafe', occurredAt: '2026-08-10T12:00:00.000Z', reviewStatus: 'pending' as const, expenseId: null,
    }
    const expense = {
      id: 'expense-a', amountMinor: transaction.amountMinor, currency: transaction.currency, categoryId: 'products', note: 'Coffee Corner · Встреча с Димой',
      occurredAt: transaction.occurredAt, createdAt: '2026-08-10T14:00:00.000Z', updatedAt: '2026-08-10T14:00:00.000Z', version: 1, deletedAt: null,
    }
    vi.spyOn(workspaceApi, 'listCardTransactions').mockResolvedValue({ transactions: [transaction], pendingCount: 1 })
    vi.spyOn(workspaceApi, 'classifyCardTransaction').mockResolvedValue({ transaction: { ...transaction, reviewStatus: 'classified', expenseId: expense.id }, expense, expenses: [expense], pendingCount: 0 })
    vi.spyOn(workspaceApi, 'undoCardTransaction').mockResolvedValue({ transaction, undoneExpenseId: expense.id, undoneExpenseIds: [expense.id], pendingCount: 1 })
    const onExpensesUndo = vi.fn()

    render(<CardReviewView workspaceId="workspace-a" categories={expenseBootstrap().categories} currencies={expenseBootstrap().currencies} online onExpenses={vi.fn()} onExpensesUndo={onExpensesUndo} onStatus={vi.fn()}/>)

    await screen.findByText('Coffee Corner')
    expect(screen.getByLabelText('Сумма').textContent).toBe('12,50')
    expect(screen.getByText('RSD', { exact: true })).not.toBeNull()
    expect(screen.queryByText(/Свайп/)).toBeNull()
    // Заметка — тот же ряд «Дополнительно», что на расходе, и тот же шит.
    fireEvent.click(screen.getByRole('button', { name: 'Добавить заметку' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Заметка' }), { target: { value: 'Встреча с Димой' } })
    fireEvent.click(screen.getByRole('button', { name: 'Готово' }))
    fireEvent.click(screen.getByRole('button', { name: 'Продукты' }))
    expect(workspaceApi.classifyCardTransaction).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /^Сохранить/ }))
    await screen.findByText('Расход добавлен')
    expect(workspaceApi.classifyCardTransaction).toHaveBeenCalledWith('workspace-a', transaction.id, 'products', 'Встреча с Димой', [])

    fireEvent.click(screen.getByRole('button', { name: 'Отменить' }))
    await screen.findByText('Coffee Corner')
    await waitFor(() => expect(onExpensesUndo).toHaveBeenCalledWith([expense.id]))
    expect(screen.getByRole('button', { name: 'Заметка: Встреча с Димой' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Продукты' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('marks a statement operation with the T-Bank letter', async () => {
    const transaction = {
      id: 'statement-row', source: 'tbank' as const, txnId: null, orderNo: null, type: 'purchase' as const, settled: true, amountMinor: 250_000, currency: 'RUB',
      merchantName: 'selectel', merchantCountry: null, merchantCity: null, mccCode: '5734', merchantCategory: 'Различные товары',
      occurredAt: '2026-09-01T07:05:00.000Z', reviewStatus: 'pending' as const, expenseId: null,
    }
    vi.spyOn(workspaceApi, 'listCardTransactions').mockResolvedValue({ transactions: [transaction], pendingCount: 1 })
    const { container } = render(<CardReviewView workspaceId="workspace-a" categories={expenseBootstrap().categories} currencies={expenseBootstrap().currencies} online onExpenses={vi.fn()} onExpensesUndo={vi.fn()} onStatus={vi.fn()}/>)
    await screen.findByText('selectel')
    expect(container.querySelector('.card-mark.tbank')?.textContent).toBe('Т')
    expect(screen.getByText('Различные товары')).not.toBeNull()
  })

  it('reloads the queue when a sync elsewhere raises the pending count and marks open authorizations', async () => {
    const base = {
      source: 'bybit-card' as const, txnId: null, orderNo: null, type: 'purchase' as const, currency: 'RSD', merchantCountry: 'SRB', merchantCity: 'Belgrade',
      mccCode: '5411', merchantCategory: null, reviewStatus: 'pending' as const, expenseId: null,
    }
    const first = { ...base, id: 'txn-1', settled: true, amountMinor: 86_036, merchantName: 'VERO 3', occurredAt: '2026-09-02T17:22:09.000Z' }
    const second = { ...base, id: 'txn-2', settled: false, amountMinor: 383_500, merchantName: 'Silver Dreams', occurredAt: '2026-09-03T08:00:00.000Z' }
    const list = vi.spyOn(workspaceApi, 'listCardTransactions')
      .mockResolvedValueOnce({ transactions: [first], pendingCount: 1 })
      .mockResolvedValueOnce({ transactions: [first, second], pendingCount: 2 })
    const onStatus = vi.fn()
    const props = { workspaceId: 'workspace-a', categories: expenseBootstrap().categories, currencies: expenseBootstrap().currencies, online: true, onExpenses: vi.fn(), onExpensesUndo: vi.fn(), onStatus, active: true }

    const view = render(<CardReviewView {...props} pendingCount={1}/>)
    await screen.findByText('VERO 3')
    fireEvent.click(screen.getByRole('button', { name: 'Добавить заметку' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Заметка' }), { target: { value: 'черновик' } })
    fireEvent.click(screen.getByRole('button', { name: 'Готово' }))
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1))

    // Settings → "Обновить" reports a higher pendingCount through the shared status.
    view.rerender(<CardReviewView {...props} pendingCount={2}/>)
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
      id: 'card-transaction-b', source: 'bybit-card' as const, txnId: 'bybit-b', orderNo: null, type: 'purchase' as const, settled: true,
      amountMinor: 4_200, currency: 'RSD', merchantName: 'Maxi', merchantCountry: 'RS', merchantCity: 'Beograd',
      mccCode: '5411', merchantCategory: 'Grocery', occurredAt: '2026-08-10T12:00:00.000Z', reviewStatus: 'pending' as const, expenseId: null,
    }
    const categories = [
      { id: 'products', name: 'Продукты', color: '#758d69', placement: 'main' as const, sortOrder: 0, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', archivedAt: null, version: 1 },
      { id: 'home', name: 'Для дома', color: '#7d9db4', placement: 'additional' as const, sortOrder: 0, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', archivedAt: null, version: 1 },
      { id: 'fun', name: 'Развлечения', color: '#aa8aaf', placement: 'additional' as const, sortOrder: 1, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', archivedAt: null, version: 1 },
    ]
    vi.spyOn(workspaceApi, 'listCardTransactions').mockResolvedValue({ transactions: [transaction], pendingCount: 1 })
    const classify = vi.spyOn(workspaceApi, 'classifyCardTransaction')

    const { container } = render(<CardReviewView workspaceId="workspace-a" categories={categories} currencies={expenseBootstrap().currencies} online onExpenses={vi.fn()} onExpensesUndo={vi.fn()} onStatus={vi.fn()}/>)
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
      id: 'card-transaction-c', source: 'bybit-card' as const, txnId: 'bybit-c', orderNo: null, type: 'purchase' as const, settled: true,
      amountMinor: 20_000_000, currency: 'RSD', merchantName: 'Stan i komunalije', merchantCountry: 'RS', merchantCity: 'Beograd',
      mccCode: '6513', merchantCategory: 'Rent', occurredAt: '2026-08-10T12:00:00.000Z', reviewStatus: 'pending' as const, expenseId: null,
    }
    vi.spyOn(workspaceApi, 'listCardTransactions').mockResolvedValue({ transactions: [transaction], pendingCount: 1 })
    render(<CardReviewView workspaceId="workspace-a" categories={expenseBootstrap().categories} currencies={expenseBootstrap().currencies} online onExpenses={vi.fn()} onExpensesUndo={vi.fn()} onStatus={vi.fn()}/>)

    await screen.findByText('Stan i komunalije')
    const reviewAmount = screen.getByLabelText('Сумма')
    expect(reviewAmount.textContent?.replace(/\s/g, ' ')).toBe('200 000,00')
    expect(reviewAmount.getAttribute('data-size')).toBe('medium')
    cleanup()

    render(<EntryView userId="user-a" workspaceId="workspace-a" workspace={expenseBootstrap().workspace} bootstrap={expenseBootstrap()} setBootstrap={vi.fn()} currentId={null} setCurrentId={vi.fn()} refreshPending={vi.fn()} onDraftDirtyChange={vi.fn()} active/>)
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
      id: 'card-transaction-d', source: 'bybit-card' as const, txnId: 'bybit-d', orderNo: null, type: 'purchase' as const, settled: false,
      amountMinor: 120_000, currency: 'RSD', merchantName: 'Pending Authorization', merchantCountry: 'RS', merchantCity: 'Beograd',
      mccCode: '5999', merchantCategory: 'Retail', occurredAt: '2026-08-10T12:00:00.000Z', reviewStatus: 'pending' as const, expenseId: null,
    }
    vi.spyOn(workspaceApi, 'listCardTransactions').mockResolvedValue({ transactions: [transaction], pendingCount: 1 })
    const { container } = render(<CardReviewView workspaceId="workspace-a" categories={expenseBootstrap().categories} currencies={expenseBootstrap().currencies} online onExpenses={vi.fn()} onExpensesUndo={vi.fn()} onStatus={vi.fn()}/>)

    await screen.findByText('Pending Authorization')
    const warning = screen.getByText('Ожидает списания · сумма может уточниться после расчёта')
    expect(warning.closest('.review-merchant')).toBeNull()
    expect(container.querySelector('.review-merchant .review-pending-note')).toBeNull()
    expect(warning.className).toBe('review-pending-note')
  })

  it('keeps the warning out of settled operations', async () => {
    const settled = {
      id: 'card-transaction-e', source: 'bybit-card' as const, txnId: 'bybit-e', orderNo: null, type: 'purchase' as const, settled: true,
      amountMinor: 1_000, currency: 'RSD', merchantName: 'Coffee Corner', merchantCountry: 'RS', merchantCity: 'Beograd',
      mccCode: '5812', merchantCategory: 'Cafe', occurredAt: '2026-08-10T12:00:00.000Z', reviewStatus: 'pending' as const, expenseId: null,
    }
    vi.spyOn(workspaceApi, 'listCardTransactions').mockResolvedValue({ transactions: [settled], pendingCount: 1 })
    render(<CardReviewView workspaceId="workspace-a" categories={expenseBootstrap().categories} currencies={expenseBootstrap().currencies} online onExpenses={vi.fn()} onExpensesUndo={vi.fn()} onStatus={vi.fn()}/>)

    await screen.findByText('Coffee Corner')
    expect(screen.queryByText(/Ожидает списания/)).toBeNull()
  })
})

/*
 * Одним платежом закрывают сразу две категории. Деление отвечает только на вопрос «на какие суммы»:
 * части операции карты встают в очередь обычными строками, части записи наследуют её категорию.
 */
describe('splitting one payment into parts', () => {
  const categories = [
    { id: 'products', name: 'Продукты', color: '#758d69', placement: 'main' as const, sortOrder: 0, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', archivedAt: null, version: 1 },
    { id: 'home', name: 'Для дома', color: '#7d9db4', placement: 'additional' as const, sortOrder: 0, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', archivedAt: null, version: 1 },
  ]
  const currencies = [{ code: 'RSD', name: 'Сербский динар', symbol: 'дин.', decimals: 2 }]

  // Последняя часть считается сама, поэтому сумма частей никогда не расходится с платежом.
  it('keeps the last part equal to what is left', () => {
    const draft = splitDraft(['800', ''], 120_000, 'RSD', currencies)
    expect(draft.remainder).toBe(40_000)
    expect(draft.parts).toEqual([80_000, 40_000])
    expect(draft.canSave).toBe(true)

    expect(splitDraft(['1200', ''], 120_000, 'RSD', currencies).canSave).toBe(false)
    expect(splitDraft(['1500', ''], 120_000, 'RSD', currencies).remainder).toBe(-30_000)
    expect(splitDraft(['', ''], 120_000, 'RSD', currencies).canSave).toBe(false)
    expect(splitDraft(['500', '200', ''], 120_000, 'RSD', currencies).parts).toEqual([50_000, 20_000, 50_000])
  })

  const transaction = {
    id: 'card-transaction-split', source: 'bybit-card' as const, txnId: 'bybit-split', orderNo: null, type: 'purchase' as const, settled: true,
    amountMinor: 120_000, currency: 'RSD', merchantName: 'Maxi', merchantCountry: 'RS', merchantCity: 'Beograd',
    mccCode: '5411', merchantCategory: 'Grocery', occurredAt: '2026-08-10T12:00:00.000Z', reviewStatus: 'pending' as const,
    expenseId: null, splitIndex: null, splitCount: null,
  }
  const part = (id: string, amountMinor: number, splitIndex: number) => ({ ...transaction, id, amountMinor, splitIndex, splitCount: 2 })

  it('replaces a card payment with its parts and classifies each one on the usual card', async () => {
    const parts = [part('part-1', 80_000, 1), part('part-2', 40_000, 2)]
    vi.spyOn(workspaceApi, 'listCardTransactions').mockResolvedValue({ transactions: [transaction], pendingCount: 1 })
    const split = vi.spyOn(workspaceApi, 'splitCardTransaction').mockResolvedValue({ transactions: parts, pendingCount: 2 })
    const classify = vi.spyOn(workspaceApi, 'classifyCardTransaction')
    const onStatus = vi.fn()

    render(<CardReviewView workspaceId="workspace-a" categories={categories} currencies={currencies} online onExpenses={vi.fn()} onExpensesUndo={vi.fn()} onStatus={onStatus}/>)
    await screen.findByText('Maxi')
    expect(screen.queryByText(/Часть/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Разделить' }))
    const sheet = screen.getByRole('dialog', { name: /^Разделить .+ RSD$/ })
    expect(within(sheet).getByRole('button', { name: /^Разделить на 2 части/ }).hasAttribute('disabled')).toBe(true)
    fireEvent.change(within(sheet).getByLabelText('Сумма части 1'), { target: { value: '800' } })
    // Остаток считается на месте, набирать его не нужно.
    expect(sheet.textContent).toContain('400,00')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Разделить на 2 части' }))

    await waitFor(() => expect(split).toHaveBeenCalledWith('workspace-a', transaction.id, [80_000, 40_000]))
    await screen.findByText('Платёж разделён на 2 части')
    expect(screen.queryByRole('dialog', { name: /^Разделить/ })).toBeNull()
    // Первая часть открыта как обычная операция очереди — со своей суммой и пометкой, что это половина платежа.
    expect(screen.getByLabelText('Сумма').textContent).toBe('800,00')
    expect(screen.getByText('Часть 1 из 2')).not.toBeNull()
    expect(screen.getByText(/В очереди · 2/)).not.toBeNull()
    expect(onStatus).toHaveBeenLastCalledWith({ pendingCount: 2 })

    fireEvent.click(screen.getByRole('button', { name: 'Продукты' }))
    fireEvent.click(screen.getByRole('button', { name: /^Сохранить 800/ }))
    await waitFor(() => expect(classify).toHaveBeenCalledWith('workspace-a', 'part-1', 'products', '', []))
  })

  it('puts a split payment back together while no part is recorded', async () => {
    const parts = [part('part-1', 80_000, 1), part('part-2', 40_000, 2)]
    vi.spyOn(workspaceApi, 'listCardTransactions').mockResolvedValue({ transactions: parts, pendingCount: 2 })
    const unsplit = vi.spyOn(workspaceApi, 'unsplitCardTransaction')
      .mockResolvedValue({ transaction, removedTransactionIds: ['part-1', 'part-2'], undoneExpenseIds: [], pendingCount: 1 })

    render(<CardReviewView workspaceId="workspace-a" categories={categories} currencies={currencies} online onExpenses={vi.fn()} onExpensesUndo={vi.fn()} onStatus={vi.fn()}/>)
    await screen.findByText('Часть 1 из 2')
    // У части предлагается обратное действие: делить её ещё раз нельзя.
    expect(screen.queryByRole('button', { name: 'Разделить' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Собрать части' }))
    await waitFor(() => expect(unsplit).toHaveBeenCalledWith('workspace-a', 'part-1', []))
    await waitFor(() => expect(screen.queryByText(/Часть/)).toBeNull())
    expect(screen.getByLabelText('Сумма').textContent?.replace(/\s/g, ' ')).toBe('1 200,00')
    expect(screen.getByText(/В очереди · 1/)).not.toBeNull()
  })

  // Записанная часть не просто мешает собрать платёж: шит снизу называет её и удаляет запись по кнопке.
  it('offers to drop the already recorded part before collecting the payment', async () => {
    const parts = [part('part-1', 80_000, 1), part('part-2', 40_000, 2)]
    const recorded = {
      id: 'part-1', splitIndex: 1, splitCount: 2, amountMinor: 80_000, currency: 'RSD',
      expenses: [{
        id: 'expense-part-1', amountMinor: 80_000, currency: 'RSD', categoryId: 'products', note: null,
        occurredAt: '2026-08-10T12:00:00.000Z', createdAt: '2026-08-10T12:00:00.000Z', updatedAt: '2026-08-10T12:00:00.000Z',
        version: 2, deletedAt: null, tagIds: [],
      }],
    }
    vi.spyOn(workspaceApi, 'listCardTransactions').mockResolvedValue({ transactions: [parts[1]!], pendingCount: 1 })
    const unsplit = vi.spyOn(workspaceApi, 'unsplitCardTransaction')
      .mockRejectedValueOnce(new workspaceApi.WorkspaceApiError(409, 'SPLIT_IN_USE', 'Одна из частей уже записана в историю.', { recorded: [recorded] }))
      .mockResolvedValue({ transaction, removedTransactionIds: ['part-1', 'part-2'], undoneExpenseIds: ['expense-part-1'], pendingCount: 1 })
    const onExpensesUndo = vi.fn()

    render(<CardReviewView workspaceId="workspace-a" categories={categories} currencies={currencies} online onExpenses={vi.fn()} onExpensesUndo={onExpensesUndo} onStatus={vi.fn()}/>)
    await screen.findByText('Часть 2 из 2')

    fireEvent.click(screen.getByRole('button', { name: 'Собрать части' }))
    const sheet = await screen.findByRole('alertdialog', { name: 'Часть уже записана' })
    // Шит говорит, что именно уйдёт из истории: сумму, категорию и номер части.
    expect(sheet.textContent).toContain('часть 1')
    expect(sheet.textContent).toContain('800,00 RSD')
    expect(sheet.textContent).toContain('Продукты')
    // Пока не подтвердили — запись на месте.
    expect(unsplit).toHaveBeenCalledTimes(1)

    fireEvent.click(within(sheet).getByRole('button', { name: 'Удалить запись и собрать' }))
    await waitFor(() => expect(unsplit).toHaveBeenLastCalledWith('workspace-a', 'part-2', [{ id: 'expense-part-1', version: 2 }]))
    await waitFor(() => expect(onExpensesUndo).toHaveBeenCalledWith(['expense-part-1']))
    await waitFor(() => expect(screen.queryByText(/Часть/)).toBeNull())
    expect(screen.getByText('Платёж собран, запись части удалена')).not.toBeNull()
  })

  it('keeps the recorded part when the sheet is dismissed', async () => {
    const parts = [part('part-1', 80_000, 1), part('part-2', 40_000, 2)]
    vi.spyOn(workspaceApi, 'listCardTransactions').mockResolvedValue({ transactions: [parts[1]!], pendingCount: 1 })
    const unsplit = vi.spyOn(workspaceApi, 'unsplitCardTransaction')
      .mockRejectedValue(new workspaceApi.WorkspaceApiError(409, 'SPLIT_IN_USE', 'Одна из частей уже записана в историю.', {
        recorded: [{ id: 'part-1', splitIndex: 1, splitCount: 2, amountMinor: 80_000, currency: 'RSD', expenses: [] }],
      }))

    render(<CardReviewView workspaceId="workspace-a" categories={categories} currencies={currencies} online onExpenses={vi.fn()} onExpensesUndo={vi.fn()} onStatus={vi.fn()}/>)
    await screen.findByText('Часть 2 из 2')
    fireEvent.click(screen.getByRole('button', { name: 'Собрать части' }))
    const sheet = await screen.findByRole('alertdialog')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Отмена' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(unsplit).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Часть 2 из 2')).not.toBeNull()
  })

  it('refuses to save until the parts add up', () => {
    const onSubmit = vi.fn()
    render(<SplitSheet totalMinor={120_000} currency="RSD" currencies={currencies} onClose={vi.fn()} onSubmit={onSubmit}/>)

    const sheet = screen.getByRole('dialog', { name: /^Разделить .+ RSD$/ })
    fireEvent.change(within(sheet).getByLabelText('Сумма части 1'), { target: { value: '1500' } })
    expect(sheet.textContent).toContain('Части больше платежа на 300,00 RSD')

    fireEvent.change(within(sheet).getByLabelText('Сумма части 1'), { target: { value: '1200' } })
    expect(sheet.textContent).toContain('На последнюю часть ничего не осталось')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Разделить на 2 части' }))
    expect(onSubmit).not.toHaveBeenCalled()

    // Третья часть отрезается от остатка, а не от уже названных сумм.
    fireEvent.change(within(sheet).getByLabelText('Сумма части 1'), { target: { value: '900' } })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Ещё часть' }))
    fireEvent.change(within(sheet).getByLabelText('Сумма части 2'), { target: { value: '200' } })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Разделить на 3 части' }))
    expect(onSubmit).toHaveBeenCalledWith([90_000, 20_000, 10_000])
  })

  // Пять частей — предел: кнопка остаётся на месте выключенной, а не исчезает вместе с рядом.
  it('adds one part per tap and stops at five without losing the button', () => {
    render(<SplitSheet totalMinor={120_000} currency="RSD" currencies={currencies} onClose={vi.fn()} onSubmit={vi.fn()}/>)
    const sheet = screen.getByRole('dialog', { name: /^Разделить .+ RSD$/ })
    const more = () => within(sheet).getByRole('button', { name: 'Ещё часть' })
    const parts = () => within(sheet).getAllByRole('listitem').length
    expect(parts()).toBe(2)

    // Два нажатия в одном такте React добавляют ровно две части, а не одну и не три.
    act(() => { more().click(); more().click() })
    expect(parts()).toBe(4)

    fireEvent.click(more())
    expect(parts()).toBe(5)
    expect(more().hasAttribute('disabled')).toBe(true)
    // На пределе даже пачка нажатий не добавляет шестую: предел считается внутри обновления.
    act(() => { more().click(); more().click() })
    expect(parts()).toBe(5)

    // Нулевой остаток тоже выключает кнопку, а не убирает её.
    fireEvent.click(within(sheet).getByRole('button', { name: 'Убрать часть 1' }))
    expect(parts()).toBe(4)
    fireEvent.change(within(sheet).getByLabelText('Сумма части 1'), { target: { value: '1200' } })
    expect(sheet.textContent).toContain('На последнюю часть ничего не осталось')
    expect(more().hasAttribute('disabled')).toBe(true)
  })

  // Быстрые нажатия обрабатываются как есть: сколько крестиков нажато, столько частей и ушло.
  it('takes out exactly the tapped part however fast the crosses are tapped', () => {
    const onClose = vi.fn()
    render(<SplitSheet totalMinor={120_000} currency="RSD" currencies={currencies} onClose={onClose} onSubmit={vi.fn()}/>)
    const sheet = screen.getByRole('dialog', { name: /^Разделить .+ RSD$/ })
    const amounts = () => within(sheet).getAllByRole('textbox').map((input) => (input as HTMLInputElement).value)
    for (const _ of [1, 2]) fireEvent.click(within(sheet).getByRole('button', { name: 'Ещё часть' }))
    for (const [index, value] of ['100', '200', '300'].entries()) {
      fireEvent.change(within(sheet).getByLabelText(`Сумма части ${index + 1}`), { target: { value } })
    }
    expect(amounts()).toEqual(['100', '200', '300'])

    // Два нажатия по разным крестикам в одном такте React убирают именно свои части, а не соседние.
    const [first, second] = within(sheet).getAllByRole('button', { name: /^Убрать часть/ })
    act(() => { first!.click(); second!.click() })
    expect(amounts()).toEqual(['300'])
    expect(onClose).not.toHaveBeenCalled()

    // Ниже двух строк список не опускается: у последней суммы и остатка крестиков уже нет.
    expect(within(sheet).getAllByRole('listitem').length).toBe(2)
    expect(within(sheet).queryAllByRole('button', { name: /^Убрать часть/ })).toEqual([])
  })
})

// «Расход» в настройке с настоящим состоянием: раскладка и данные меняются так же, как в приложении.
function EntryHarness({ bootstrap: initial, blocks: initialBlocks }: { bootstrap: WorkspaceBootstrap; blocks?: { shown: string[]; hidden: string[] } }) {
  const [bootstrap, setBootstrap] = useState(initial)
  const [blocks, setBlocks] = useState(initialBlocks)
  return <EntryView userId="user-a" workspaceId="workspace-a" workspace={bootstrap.workspace} bootstrap={bootstrap} setBootstrap={setBootstrap} currentId={null} setCurrentId={vi.fn()} refreshPending={vi.fn()} onDraftDirtyChange={vi.fn()} active blocks={blocks} editing onScreensChange={(patch) => setBlocks(patch.entryBlocks ?? undefined)}/>
}

function SettingsHarness({ bootstrap: initial }: { bootstrap: WorkspaceBootstrap }) {
  const [bootstrap, setBootstrap] = useState(initial)
  const user: AuthenticatedSession = { authenticated: true, user: { id: 'user-a', displayName: 'Аня', recoveryConfigured: true, recoveryGeneration: 1 }, currentSessionId: 'session-a', currentSessionExpiresAt: '2030-01-01T00:00:00.000Z', serverTime: '2026-08-10T14:00:00.000Z', restrictedToRecovery: false, workspaces: [bootstrap.workspace], legacyWorkspaceId: null }
  return <SettingsView user={user} workspace={bootstrap.workspace} workspaceId={bootstrap.workspaceId} bootstrap={bootstrap} setBootstrap={setBootstrap} pendingCount={0} refreshPending={vi.fn()} onLogout={vi.fn()} onSession={vi.fn()} online/>
}

const hiddenHome: Category = { id: 'home', name: 'Для дома', color: '#79a9d1', placement: 'additional', sortOrder: 0, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', archivedAt: '2026-09-01T00:00:00.000Z', version: 2 }

const connectedBybit: WorkspaceMod = { id: 'bybit-card', added: true, addedAt: '2026-08-10T12:00:00.000Z', state: { connected: true, enabledAt: '2026-08-10T12:00:00.000Z', lastSyncedAt: '2026-09-05T08:00:00.000Z', status: 'active' } }
const addedTbank: WorkspaceMod = { id: 'tbank', added: true, addedAt: '2026-09-25T10:00:00.000Z' }
const catalog: WorkspaceMod[] = [{ id: 'bybit-card', added: false, addedAt: null }, { id: 'tbank', added: false, addedAt: null }]

// Страница модов держит список у себя, как App: добавление и удаление возвращают новый каталог.
function ModsHarness({ mods: initial, ...props }: { mods: WorkspaceMod[] } & Partial<React.ComponentProps<typeof ModsView>>) {
  const [mods, setMods] = useState(initial)
  return <ModsView workspaceId="workspace-a" mods={mods} online onMods={setMods} onBybitStatus={vi.fn()} {...props}/>
}

describe('mods page', () => {
  it('tells the person why «Обновить» fetched nothing from Bybit', async () => {
    const status = { ...connectedBybit.state!, canManage: true, pendingCount: 1 }
    const sync = vi.spyOn(workspaceApi, 'syncBybitCard').mockResolvedValue({ ...status, imported: 0, throttled: true })
    render(<ModsHarness mods={[connectedBybit]}/>)

    fireEvent.click(screen.getByRole('button', { name: /Карта Bybit/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Обновить' }))
    // Сервер не ходит в Bybit чаще раза в минуту; молчание выглядело бы как сломанная кнопка.
    await screen.findByText('Уже актуально: обновлялось меньше минуты назад')
    expect(sync).toHaveBeenCalledWith('workspace-a')
  })

  it('uploads a T-Bank statement file and leads straight to the review', async () => {
    const upload = vi.spyOn(workspaceApi, 'uploadTbankStatement').mockResolvedValue({ imported: 3, known: 2, skipped: 0, pendingCount: 5 })
    const onStatementImported = vi.fn()
    const onOpenReview = vi.fn()
    const { container } = render(<ModsHarness mods={[addedTbank]} onStatementImported={onStatementImported} onOpenReview={onOpenReview}/>)

    fireEvent.click(screen.getByRole('button', { name: /Выписка Т‑Банка/ }))
    const csv = '"Дата операции";"Сумма операции";"Валюта операции";"Статус";"Описание"\r\n"01.09.2026 09:05:00";"-2500,00";"RUB";"Ок";"selectel"\r\n'
    const input = container.ownerDocument.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File([csv], 'Operations.csv', { type: 'text/csv' })] } })
    await screen.findByText('Новых трат: 3 · уже были: 2.')
    expect(upload).toHaveBeenCalledWith('workspace-a', csv)
    expect(onStatementImported).toHaveBeenCalledWith(5)
    fireEvent.click(screen.getByRole('button', { name: 'Разобрать' }))
    expect(onOpenReview).toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: 'Выписка Т‑Банка' })).toBeNull()
  })

  it('says plainly what a statement upload changed', async () => {
    expect(statementFeedback({ imported: 0, known: 12, skipped: 0, pendingCount: 0 })).toBe('Новых трат нет — всё уже загружено.')
    expect(statementFeedback({ imported: 0, known: 0, skipped: 0, pendingCount: 0 })).toBe('В файле нет трат.')
    expect(statementFeedback({ imported: 1, known: 0, skipped: 2, pendingCount: 1 })).toBe('Новых трат: 1. Не удалось прочитать строк: 2.')
    // Старые выгрузки Тинькофф были в Windows‑1251: «Статус» в этой кодировке — D1 F2 E0 F2 F3 F1.
    const legacy = new File([new Uint8Array([0xd1, 0xf2, 0xe0, 0xf2, 0xf3, 0xf1])], 'old.csv')
    expect(await readStatementFile(legacy)).toBe('Статус')
    expect(await readStatementFile(new File(['Статус'], 'new.csv'))).toBe('Статус')
  })

  // Пространство общее: любой участник добавляет мод из каталога и сразу вставляет ключ — без «спросите владельца».
  it('adds a mod from the catalog and opens it right away to connect the card', async () => {
    const add = vi.spyOn(workspaceApi, 'addMod').mockResolvedValue([{ id: 'bybit-card', added: true, addedAt: '2026-09-25T10:00:00.000Z', state: { connected: false } }, catalog[1]!])
    const connect = vi.spyOn(workspaceApi, 'connectBybitCard').mockResolvedValue({ ...connectedBybit.state!, canManage: true, pendingCount: 2 })
    const onBybitStatus = vi.fn()
    render(<ModsHarness mods={catalog} onBybitStatus={onBybitStatus}/>)

    expect(screen.getByText('Модов пока нет.')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Добавить мод' }))
    const offers = screen.getByRole('dialog', { name: 'Каталог модов' })
    expect(offers.textContent).toContain('Выписка Т‑Банка')
    fireEvent.click(within(offers.querySelector('.mod-offer') as HTMLElement).getByRole('button', { name: 'Добавить' }))
    await waitFor(() => expect(add).toHaveBeenCalledWith('workspace-a', 'bybit-card'))

    const sheet = await screen.findByRole('dialog', { name: 'Карта Bybit' })
    expect(screen.queryByRole('dialog', { name: 'Каталог модов' })).toBeNull()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Подключить' }))
    fireEvent.change(within(sheet).getByLabelText('API key'), { target: { value: 'key' } })
    fireEvent.change(within(sheet).getByLabelText('API secret'), { target: { value: 'secret' } })
    fireEvent.click(within(sheet).getAllByRole('button', { name: 'Подключить' }).at(-1)!)
    await waitFor(() => expect(connect).toHaveBeenCalledWith('workspace-a', 'key', 'secret', 'global'))
    expect(onBybitStatus).toHaveBeenCalledWith(expect.objectContaining({ connected: true, pendingCount: 2 }))
    // Добавленный мод уходит из каталога; остался Т‑Банк — кнопка «Добавить мод» ещё нужна.
    fireEvent.click(within(sheet).getByRole('button', { name: 'Закрыть' }))
    expect(screen.getByRole('button', { name: /Карта Bybit/ })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Добавить мод' }))
    expect(within(screen.getByRole('dialog', { name: 'Каталог модов' })).queryByText('Карта Bybit')).toBeNull()
  })

  it('asks before removing a mod and keeps its unreviewed operations', async () => {
    const remove = vi.spyOn(workspaceApi, 'removeMod').mockResolvedValue([{ id: 'bybit-card', added: false, addedAt: null }, addedTbank])
    render(<ModsHarness mods={[connectedBybit, addedTbank]}/>)

    fireEvent.click(screen.getByRole('button', { name: /Карта Bybit/ }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Карта Bybit' })).getByRole('button', { name: 'Убрать мод' }))
    const question = await screen.findByRole('alertdialog')
    expect(within(question).getByRole('heading').textContent).toBe('Убрать карту Bybit?')
    expect(question.textContent).toContain('Неразобранные операции останутся в разборе')
    fireEvent.click(within(question).getByRole('button', { name: 'Убрать' }))
    await waitFor(() => expect(remove).toHaveBeenCalledWith('workspace-a', 'bybit-card'))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Карта Bybit' })).toBeNull())
    expect(screen.queryByRole('button', { name: /Карта Bybit/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Выписка Т‑Банка/ })).not.toBeNull()
  })

  it('says a broken Bybit key needs attention right on the settings row', () => {
    vi.spyOn(workspaceApi, 'listMembers').mockResolvedValue({ members: [] })
    vi.spyOn(workspaceApi, 'listSessions').mockResolvedValue({ sessions: [] })
    const member = { ...expenseBootstrap().workspace, role: 'member' as const }
    const user: AuthenticatedSession = { authenticated: true, user: { id: 'user-a', displayName: 'Аня', recoveryConfigured: true, recoveryGeneration: 1 }, currentSessionId: 'session-a', currentSessionExpiresAt: '2030-01-01T00:00:00.000Z', serverTime: '2026-08-10T14:00:00.000Z', restrictedToRecovery: false, workspaces: [member], legacyWorkspaceId: null }
    const settings = (mods: WorkspaceMod[] | null, online = true) => <SettingsView user={user} workspace={member} workspaceId={member.id} bootstrap={expenseBootstrap({ workspace: member })} setBootstrap={vi.fn()} pendingCount={0} refreshPending={vi.fn()} onLogout={vi.fn()} onSession={vi.fn()} online={online} mods={mods}/>
    const empty = render(settings(catalog))
    expect(screen.getByRole('button', { name: /^Моды/ }).textContent).toContain('нет')
    empty.unmount()
    const offline = render(settings(null, false))
    expect(screen.getByRole('button', { name: /^Моды/ }).textContent).toContain('нужна сеть')
    offline.unmount()

    render(settings([{ ...connectedBybit, state: { ...connectedBybit.state!, status: 'error' } }, addedTbank]))
    const row = screen.getByRole('button', { name: /^Моды/ })
    expect(row.textContent).toContain('нужно обновить')
    expect(row.className).toContain('warn')
  })
})

describe('settings identity transitions', () => {
  it('lists settings as plain rows and opens categories in a sheet', async () => {
    vi.spyOn(workspaceApi, 'listMembers').mockResolvedValue({ members: [] })
    vi.spyOn(workspaceApi, 'listSessions').mockResolvedValue({ sessions: [] })
    vi.spyOn(workspaceApi, 'listInvitations').mockResolvedValue({ invitations: [] })
    const workspace = expenseBootstrap().workspace
    const user: AuthenticatedSession = { authenticated: true, user: { id: 'user-a', displayName: 'Аня', recoveryConfigured: true, recoveryGeneration: 1 }, currentSessionId: 'session-a', currentSessionExpiresAt: '2030-01-01T00:00:00.000Z', serverTime: '2026-08-10T14:00:00.000Z', restrictedToRecovery: false, workspaces: [workspace], legacyWorkspaceId: null }
    const onOpenMods = vi.fn()
    render(<SettingsView user={user} workspace={workspace} workspaceId={workspace.id} bootstrap={expenseBootstrap()} setBootstrap={vi.fn()} pendingCount={0} refreshPending={vi.fn()} onLogout={vi.fn()} onSession={vi.fn()} online mods={[connectedBybit, addedTbank]} onOpenMods={onOpenMods}/>)

    // Ни сегментов, ни заголовков-эйбрау: сразу строки с понятиями и значениями.
    expect(screen.queryByText('Люди и доступ')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Настройки' })).toBeNull()
    expect(screen.getByRole('button', { name: /Название пространства/ }).textContent).toContain('Дом')
    // Карты и банки собраны в одну строку «Моды»: отдельных строк Bybit и Т‑Банка больше нет.
    expect(screen.queryByRole('button', { name: /Карта Bybit|Выписка Т‑Банка/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Моды/ }))
    expect(screen.getByRole('button', { name: /^Моды/ }).textContent).toContain('2')
    expect(onOpenMods).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /^Внешний вид/ }).textContent).toBe('Внешний видшалфейный цвет, Как в системе')
    expect(screen.queryByRole('button', { name: 'Новая категория' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Категории/ }))
    expect(screen.getByRole('dialog', { name: 'Категории' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Новая категория' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: /Поднять категорию/ })).toBeNull()
  })

  // Скрытая категория держит своё имя, поэтому вернуть её нужно уметь: список скрытых и есть эта возможность.
  it('lists hidden categories and brings one back', async () => {
    vi.spyOn(workspaceApi, 'listMembers').mockResolvedValue({ members: [] })
    vi.spyOn(workspaceApi, 'listSessions').mockResolvedValue({ sessions: [] })
    vi.spyOn(workspaceApi, 'listInvitations').mockResolvedValue({ invitations: [] })
    const update = vi.spyOn(workspaceApi, 'updateCategory').mockImplementation(async (_workspaceId, _id, category) => ({ ...hiddenHome, ...category, archivedAt: null, version: 3 }))
    const bootstrap = expenseBootstrap()
    render(<SettingsHarness bootstrap={{ ...bootstrap, categories: [...bootstrap.categories, hiddenHome] }}/>)

    // Скрытая не попадает в счётчик строки и в порядок, но видна отдельным списком.
    expect(screen.getByRole('button', { name: /^Категории/ }).textContent).toContain('1')
    fireEvent.click(screen.getByRole('button', { name: /^Категории/ }))
    const sheet = screen.getByRole('dialog', { name: 'Категории' })
    expect(within(sheet).getByRole('heading', { name: 'Скрытые' })).not.toBeNull()
    expect(sheet.textContent).toContain('Для дома')

    fireEvent.click(within(sheet).getByRole('button', { name: 'Вернуть' }))
    await waitFor(() => expect(update).toHaveBeenCalled())
    expect(update.mock.calls[0]![1]).toBe('home')
    expect(update.mock.calls[0]![2].archivedAt).toBe(null)
    expect(await screen.findByText('Категория «Для дома» вернулась')).not.toBeNull()
    const restored = screen.getByRole('dialog', { name: 'Категории' })
    expect(within(restored).queryByRole('heading', { name: 'Скрытые' })).toBeNull()
    expect(within(restored).getByRole('button', { name: 'Для дома' })).not.toBeNull()
  })

  // Имя скрытой категории занято: сервер отдаёт её же, а не создаёт вторую — в списке остаётся одна строка.
  it('replaces the new category with the hidden one the server returned', async () => {
    vi.spyOn(workspaceApi, 'listMembers').mockResolvedValue({ members: [] })
    vi.spyOn(workspaceApi, 'listSessions').mockResolvedValue({ sessions: [] })
    vi.spyOn(workspaceApi, 'listInvitations').mockResolvedValue({ invitations: [] })
    const create = vi.spyOn(workspaceApi, 'createCategory').mockImplementation(async (_workspaceId, category) => ({ ...hiddenHome, placement: category.placement, color: category.color, name: category.name, archivedAt: null, version: 3 }))
    const bootstrap = expenseBootstrap()
    render(<SettingsHarness bootstrap={{ ...bootstrap, categories: [...bootstrap.categories, hiddenHome] }}/>)

    fireEvent.click(screen.getByRole('button', { name: /^Категории/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Новая категория' }))
    const editor = screen.getByRole('dialog', { name: 'Новая категория' })
    fireEvent.change(within(editor).getByLabelText('Название'), { target: { value: 'Для дома' } })
    fireEvent.click(within(editor).getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(create).toHaveBeenCalled())

    expect(await screen.findByText('Категория «Для дома» вернулась вместе со старыми расходами')).not.toBeNull()
    const sheet = screen.getByRole('dialog', { name: 'Категории' })
    expect(within(sheet).getAllByRole('button', { name: 'Для дома' }).length).toBe(1)
    expect(within(sheet).queryByRole('heading', { name: 'Скрытые' })).toBeNull()
  })

  // Занятое имя живой категории объясняется прямо, а не общим «Такая запись уже существует».
  it('names the category that already holds the name', async () => {
    vi.spyOn(workspaceApi, 'listMembers').mockResolvedValue({ members: [] })
    vi.spyOn(workspaceApi, 'listSessions').mockResolvedValue({ sessions: [] })
    vi.spyOn(workspaceApi, 'listInvitations').mockResolvedValue({ invitations: [] })
    const bootstrap = expenseBootstrap()
    vi.spyOn(workspaceApi, 'createCategory').mockRejectedValue(new workspaceApi.WorkspaceApiError(409, 'DUPLICATE', 'Такая запись уже существует.', { current: bootstrap.categories[0] }))
    render(<SettingsHarness bootstrap={bootstrap}/>)

    fireEvent.click(screen.getByRole('button', { name: /^Категории/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Новая категория' }))
    const editor = screen.getByRole('dialog', { name: 'Новая категория' })
    fireEvent.change(within(editor).getByLabelText('Название'), { target: { value: 'продукты' } })
    fireEvent.click(within(editor).getByRole('button', { name: 'Сохранить' }))

    // Набранное имя остаётся в открытом редакторе: человеку есть что исправить.
    expect(await screen.findByText('Категория «Продукты» уже есть')).not.toBeNull()
    expect((within(screen.getByRole('dialog', { name: 'Новая категория' })).getByLabelText('Название') as HTMLInputElement).value).toBe('продукты')
  })

  it('lets the owner change the workspace currency and forgets the currency they picked by hand', async () => {
    vi.spyOn(workspaceApi, 'listMembers').mockResolvedValue({ members: [] })
    vi.spyOn(workspaceApi, 'listSessions').mockResolvedValue({ sessions: [] })
    vi.spyOn(workspaceApi, 'listInvitations').mockResolvedValue({ invitations: [] })
    const workspace = expenseBootstrap().workspace
    const user: AuthenticatedSession = { authenticated: true, user: { id: 'user-a', displayName: 'Аня', recoveryConfigured: true, recoveryGeneration: 1 }, currentSessionId: 'session-a', currentSessionExpiresAt: '2030-01-01T00:00:00.000Z', serverTime: '2026-08-10T14:00:00.000Z', restrictedToRecovery: false, workspaces: [workspace], legacyWorkspaceId: null }
    const saved = { ...workspace, currency: 'EUR', version: 2 }
    const change = vi.spyOn(workspaceApi, 'changeWorkspaceCurrency').mockResolvedValue({ workspace: saved })
    vi.spyOn(workspaceApi, 'getSession').mockResolvedValue({ ...user, workspaces: [saved] })
    const setBootstrap = vi.fn()
    const onSession = vi.fn().mockResolvedValue(undefined)
    const bootstrap = expenseBootstrap({ currencies: [{ code: 'RSD', name: 'Сербский динар', symbol: 'дин.', decimals: 2 }, { code: 'EUR', name: 'Евро', symbol: '€', decimals: 2 }], settings: { lastCurrency: 'USD', analyticsCurrency: 'USD' } })
    render(<SettingsView user={user} workspace={workspace} workspaceId={workspace.id} bootstrap={bootstrap} setBootstrap={setBootstrap} pendingCount={0} refreshPending={vi.fn()} onLogout={vi.fn()} onSession={onSession} online/>)

    expect(screen.getByRole('button', { name: /^Валюта/ }).textContent).toContain('RSD')
    fireEvent.click(screen.getByRole('button', { name: /^Валюта/ }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Валюта' })).getByRole('button', { name: /^EUR/ }))

    await waitFor(() => expect(change).toHaveBeenCalledWith('workspace-a', 'EUR', 1))
    await waitFor(() => expect(onSession).toHaveBeenCalledWith(expect.objectContaining({ workspaces: [saved] })))
    const patched = (setBootstrap.mock.calls[0][0] as (data: WorkspaceBootstrap) => WorkspaceBootstrap)(bootstrap)
    // Валюта, выбранная вручную, забывается и в аккаунте; выбор валюты аналитики остаётся.
    expect(patched.settings).toEqual({ analyticsCurrency: 'USD' })
    expect(queuedMemberSettings('user-a', 'workspace-a')).toEqual({ lastCurrency: null })
    expect(patched.workspace.currency).toBe('EUR')
    expect(patched.workspace.version).toBe(2)
    expect(patched.defaultAnalyticsCurrency).toBe('EUR')
    expect(await screen.findByText('Новые расходы — в EUR')).not.toBeNull()
  })

  it('shows a member the workspace currency without a way to change it', async () => {
    vi.spyOn(workspaceApi, 'listMembers').mockResolvedValue({ members: [] })
    vi.spyOn(workspaceApi, 'listSessions').mockResolvedValue({ sessions: [] })
    vi.spyOn(workspaceApi, 'listInvitations').mockResolvedValue({ invitations: [] })
    const member = { ...expenseBootstrap().workspace, role: 'member' as const, currency: 'EUR' }
    const user: AuthenticatedSession = { authenticated: true, user: { id: 'user-b', displayName: 'Боря', recoveryConfigured: true, recoveryGeneration: 1 }, currentSessionId: 'session-b', currentSessionExpiresAt: '2030-01-01T00:00:00.000Z', serverTime: '2026-08-10T14:00:00.000Z', restrictedToRecovery: false, workspaces: [member], legacyWorkspaceId: null }
    render(<SettingsView user={user} workspace={member} workspaceId={member.id} bootstrap={expenseBootstrap({ workspace: member })} setBootstrap={vi.fn()} pendingCount={0} refreshPending={vi.fn()} onLogout={vi.fn()} onSession={vi.fn()} online/>)
    expect(screen.queryByRole('button', { name: /^Валюта/ })).toBeNull()
    expect(screen.getByText('Валюта').parentElement?.textContent).toContain('EUR')
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
      pendingCount={0} refreshPending={vi.fn()} onLogout={logout}
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
    render(<SettingsView user={user} workspace={workspace} workspaceId={workspace.id} bootstrap={expenseBootstrap()} setBootstrap={vi.fn()} pendingCount={0} refreshPending={vi.fn()} onLogout={vi.fn()} onSession={vi.fn()} online/>)

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
    render(<SettingsView user={user} workspace={workspace} workspaceId={workspace.id} bootstrap={bootstrap} setBootstrap={vi.fn()} pendingCount={0} refreshPending={vi.fn()} onLogout={vi.fn()} onSession={vi.fn()} online/>)

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
    render(<SettingsView user={user} workspace={workspace} workspaceId={workspace.id} bootstrap={expenseBootstrap()} setBootstrap={vi.fn()} pendingCount={0} refreshPending={vi.fn()} onLogout={vi.fn()} onSession={vi.fn()} online/>)
    fireEvent.click(screen.getByRole('button', { name: /Ваше имя/ }))
    const input = screen.getByRole('textbox', { name: 'Ваше имя' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Новое имя' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    expect((await screen.findByRole('alert')).textContent).toBe('Нет связи')
    expect(screen.getByRole('dialog', { name: 'Ваше имя' })).not.toBeNull()
    expect(screen.getByRole('button', { name: /Ваше имя/, hidden: true }).textContent).toContain('Аня')
  })
})

const at = '2026-08-01T00:00:00.000Z'
const personalCategories: Category[] = [
  { id: 'products', name: 'Продукты', color: '#758d69', placement: 'main', sortOrder: 0, createdAt: at, updatedAt: at, archivedAt: null, version: 1 },
  { id: 'home', name: 'Для дома', color: '#7d9db4', emoji: '🏠', placement: 'additional', sortOrder: 0, createdAt: at, updatedAt: at, archivedAt: null, version: 1 },
  { id: 'fun', name: 'Развлечения', color: '#aa8aaf', placement: 'additional', sortOrder: 1, createdAt: at, updatedAt: at, archivedAt: null, version: 1 },
]
const personalTags = ['вдвоём', 'отпуск', 'кофе'].map((name, sortOrder) => ({ id: `tag-${sortOrder}`, name, color: null, sortOrder, version: 1, createdAt: at, updatedAt: at }))

describe('personal «Расход»', () => {
  const quietAccess = () => {
    vi.spyOn(workspaceApi, 'listMembers').mockResolvedValue({ members: [] })
    vi.spyOn(workspaceApi, 'listSessions').mockResolvedValue({ sessions: [] })
    vi.spyOn(workspaceApi, 'listInvitations').mockResolvedValue({ invitations: [] })
  }
  const groups = (dialog: HTMLElement) => [...dialog.querySelectorAll('h3, .drag-row')].map((node) => node.tagName === 'H3' ? `# ${node.textContent}` : node.querySelector('.category-name')?.textContent)

  it('shows the tiles and tags this person keeps, each category with its emoji', () => {
    const bootstrap = expenseBootstrap({ categories: personalCategories, tags: personalTags, settings: { categoryOrder: { shown: ['home', 'products'], more: [] }, tagOrder: { shown: ['tag-2'], more: ['tag-0'] } } })
    const { container } = render(<EntryView userId="user-a" workspaceId="workspace-a" workspace={bootstrap.workspace} bootstrap={bootstrap} setBootstrap={vi.fn()} currentId={null} setCurrentId={vi.fn()} refreshPending={vi.fn()} onDraftDirtyChange={vi.fn()} active/>)

    const live = container.querySelector('.entry-lower-live')!
    expect([...live.querySelectorAll('.main-categories button')].map((node) => node.textContent)).toEqual(['🏠Для дома', 'Продукты', 'Ещё 1'])
    expect(live.querySelector('.main-categories .category-emoji')?.getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByRole('button', { name: 'Для дома' })).not.toBeNull()
    expect([...live.querySelectorAll('.tag-strip button')].map((node) => node.textContent)).toEqual(['кофе', 'Ещё 2'])
  })

  it('arranges tiles and tags right on «Расход» only for this person, without touching the shared categories', () => {
    const save = vi.spyOn(workspaceApi, 'saveMemberSettings').mockImplementation(() => {})
    const update = vi.spyOn(workspaceApi, 'updateCategory')
    const { container } = render(<EntryHarness bootstrap={expenseBootstrap({ categories: personalCategories, tags: personalTags })}/>)
    const tiles = () => [...container.querySelectorAll('.tile-grab')].map((node) => node.textContent)

    expect(tiles()).toEqual(['Продукты'])
    fireEvent.click(screen.getByRole('button', { name: 'Ещё 2' }))
    const more = screen.getByRole('dialog', { name: 'За плиткой «Ещё»' })
    fireEvent.click(within(more).getByRole('button', { name: 'Поставить «Развлечения» на «Расход»' }))
    expect(save).toHaveBeenLastCalledWith('user-a', 'workspace-a', { categoryOrder: { shown: ['products', 'fun'], more: ['home'] } })
    fireEvent.click(within(more).getByRole('button', { name: 'Готово' }))
    fireEvent.click(screen.getByRole('button', { name: 'Убрать «Продукты» за «Ещё»' }))
    expect(save).toHaveBeenLastCalledWith('user-a', 'workspace-a', { categoryOrder: { shown: ['fun'], more: ['products', 'home'] } })
    expect(tiles()).toEqual(['Развлечения'])
    fireEvent.click(screen.getByRole('button', { name: 'Ещё 2' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'За плиткой «Ещё»' })).getByRole('button', { name: 'Поставить «Продукты» на «Расход»' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'За плиткой «Ещё»' })).getByRole('button', { name: 'Готово' }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Переставить плитку «Продукты»' }), { key: 'ArrowLeft' })
    expect(tiles()).toEqual(['Продукты', 'Развлечения'])
    expect(update).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Убрать «отпуск» за «Ещё»' }))
    expect(save).toHaveBeenLastCalledWith('user-a', 'workspace-a', { tagOrder: { shown: ['tag-0', 'tag-2'], more: ['tag-1'] } })
    expect([...container.querySelectorAll('.tag-grab')].map((node) => node.textContent)).toEqual(['вдвоём', 'кофе'])
  })

  it('keeps only what is shared in the category and tag lists of the settings', () => {
    quietAccess()
    render(<SettingsHarness bootstrap={expenseBootstrap({ categories: personalCategories, tags: personalTags })}/>)
    fireEvent.click(screen.getByRole('button', { name: /^Категории/ }))
    const sheet = screen.getByRole('dialog', { name: 'Категории' })
    expect(groups(sheet)).toEqual(['Продукты', 'Для дома', 'Развлечения'])
    expect(within(sheet).queryByRole('button', { name: /Расход/ })).toBeNull()
    expect(sheet.textContent).toContain('раскладывает сам, прямо на нём')
  })

  it('gives a category a shared emoji in the editor, which no longer decides where it stands', async () => {
    quietAccess()
    const update = vi.spyOn(workspaceApi, 'updateCategory').mockImplementation(async (_workspaceId, _id, category) => ({ ...personalCategories[0]!, ...category, version: 2 }))
    render(<SettingsHarness bootstrap={expenseBootstrap({ categories: personalCategories })}/>)

    fireEvent.click(screen.getByRole('button', { name: /^Категории/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Продукты' }))
    const editor = screen.getByRole('dialog', { name: 'Категория' })
    expect(within(editor).queryByRole('switch')).toBeNull()
    expect(editor.textContent).toContain('Плитки на «Расходе» каждый раскладывает себе сам')

    // Своё поле держит один эмодзи: буквы не проходят, новый эмодзи заменяет прежний, составной не распадается.
    const own = within(editor).getByLabelText('Свой значок: любой эмодзи') as HTMLInputElement
    fireEvent.change(own, { target: { value: 'ab' } })
    expect(own.value).toBe('')
    fireEvent.change(own, { target: { value: '🧑‍🍳' } })
    expect(own.value).toBe('🧑‍🍳')
    fireEvent.click(within(editor).getByRole('button', { name: 'Значок 🛒' }))
    expect(own.value).toBe('')
    expect(within(editor).getByRole('button', { name: 'Значок 🛒' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(within(editor).getByRole('button', { name: 'Сохранить' }))

    await waitFor(() => expect(update).toHaveBeenCalled())
    expect(update.mock.calls[0]![2]).toEqual(expect.objectContaining({ emoji: '🛒', placement: 'main' }))
    expect(await screen.findByText('Категория сохранена')).not.toBeNull()
    expect(screen.getByRole('dialog', { name: 'Категории' }).querySelector('.drag-row .category-emoji')?.textContent).toBe('🛒')
  })
})

describe('screens made of blocks', () => {
  const spent = (id: string, categoryId: string, occurredAt: string, tagIds: string[] = []) => ({ id, amountMinor: 1_000, currency: 'RSD', categoryId, note: null, tagIds, occurredAt, createdAt: occurredAt, updatedAt: occurredAt, version: 1, deletedAt: null })
  // Удержание пальцем или мышью: полсекунды на месте, потом отпустить.
  const hold = (element: Element) => {
    vi.useFakeTimers()
    fireEvent.pointerDown(element, { pointerType: 'mouse', button: 0, clientX: 5, clientY: 5 })
    act(() => vi.advanceTimersByTime(450))
    fireEvent.pointerUp(element, { pointerType: 'mouse', clientX: 5, clientY: 5 })
  }
  const release = () => { act(() => vi.advanceTimersByTime(500)); vi.useRealTimers() }
  const titles = (container: HTMLElement) => [...container.querySelectorAll('.chart-card h2')].map((node) => node.textContent)

  it('leaves out the history blocks a person removed, and saved filters wait while their block is away', () => {
    const at = '2026-09-20T10:00:00.000Z'
    const bootstrap = expenseBootstrap({
      categories: personalCategories, expenses: [spent('a', 'products', at), spent('b', 'home', at)],
      settings: { historyFilters: { period: 'all', from: '', to: '', categoryIds: ['products'], tagIds: [], currencies: [] } },
    })
    const view = (blocks: { shown: string[]; hidden: string[] }) => <HistoryView userId="user-a" workspaceId="workspace-a" bootstrap={bootstrap} setBootstrap={vi.fn()} edit={vi.fn()} createNew={vi.fn()} refreshPending={vi.fn()} blocks={blocks}/>
    const { container, rerender } = render(view({ shown: ['day-totals'], hidden: ['filters', 'total'] }))

    expect(container.querySelector('.history-chips')).toBeNull()
    expect(container.querySelector('.history-total-line')).toBeNull()
    expect(container.querySelectorAll('.history-row')).toHaveLength(2)
    expect(container.querySelector('.history-date b')).not.toBeNull()

    // Фильтры вернулись вместе с блоком. Без «Итога» строка говорит только, сколько показано, и как сбросить.
    rerender(view({ shown: ['filters'], hidden: ['total', 'day-totals'] }))
    expect(container.querySelectorAll('.history-row')).toHaveLength(1)
    expect(container.querySelector('.history-total-line')?.textContent).toBe('1 из 2 записейСбросить')
    expect(container.querySelector('.history-date b')).toBeNull()
  })

  it('puts analytics cards in the order the person chose and opens on the period left last time', () => {
    const now = new Date().toISOString()
    const change = vi.fn()
    const bootstrap = expenseBootstrap({ categories: personalCategories, tags: personalTags, expenses: [spent('a', 'products', now, ['tag-0'])] })
    const { container } = render(<AnalyticsView userId="user-a" workspaceId="workspace-a" bootstrap={bootstrap} theme="light" online={false} blocks={{ shown: ['weekdays', 'categories'], hidden: ['trend'] }} period="month" onScreensChange={change}/>)

    // «Теги» раскладка ещё не знала — блок стоит в конце. «По дням недели» бывает только за месяц.
    expect(titles(container)).toEqual(['По дням недели', 'Категории', 'Теги'])
    expect(screen.getByRole('button', { name: 'Месяц' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Неделя' }))
    expect(change).toHaveBeenCalledWith({ analyticsPeriod: 'week' })
    expect(titles(container)).toEqual(['Категории', 'Теги'])
  })

  it('drops the note, the tags or the whole row under the tiles on «Расход»', () => {
    const bootstrap = expenseBootstrap({ tags: personalTags })
    const view = (blocks: { shown: string[]; hidden: string[] }) => <EntryView userId="user-a" workspaceId="workspace-a" workspace={bootstrap.workspace} bootstrap={bootstrap} setBootstrap={vi.fn()} currentId={null} setCurrentId={vi.fn()} refreshPending={vi.fn()} onDraftDirtyChange={vi.fn()} active blocks={blocks}/>
    const { container, rerender } = render(view({ shown: ['tags'], hidden: ['note'] }))
    expect(screen.queryByRole('button', { name: 'Добавить заметку' })).toBeNull()
    expect(container.querySelector('.entry-lower-live .tag-strip')).not.toBeNull()
    rerender(view({ shown: [], hidden: ['note', 'tags'] }))
    expect(container.querySelector('.entry-lower-live .extras-row')).toBeNull()
  })

  it('arranges «История» right on it: blocks in a frame with «−», removed ones wait in their place', () => {
    const at = '2026-09-20T10:00:00.000Z'
    const bootstrap = expenseBootstrap({ categories: personalCategories, expenses: [spent('a', 'products', at), spent('b', 'home', '2026-09-19T10:00:00.000Z')] })
    const change = vi.fn()
    const edit = vi.fn()
    const view = (editing: boolean) => <HistoryView userId="user-a" workspaceId="workspace-a" bootstrap={bootstrap} setBootstrap={vi.fn()} edit={vi.fn()} createNew={vi.fn()} refreshPending={vi.fn()} blocks={{ shown: ['filters', 'day-totals'], hidden: ['total'] }} editing={editing} onEditScreen={edit} onScreensChange={change}/>
    const { container, rerender } = render(view(false))

    fireEvent.click(screen.getByRole('button', { name: 'Поиск' }))
    // Удержание записи — это выбор записей, а не настройка экрана.
    hold(container.querySelector('.history-row')!)
    release()
    expect(edit).not.toHaveBeenCalled()
    expect(screen.getByRole('toolbar', { name: 'Выбранные расходы' })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))
    // Удержание блока над списком открывает настройку, а клик, пришедший следом, не открывает выбор дат.
    // Удержание в поле поиска — выделение текста, а не настройка.
    hold(screen.getByRole('searchbox'))
    release()
    expect(edit).not.toHaveBeenCalled()
    hold(screen.getByRole('button', { name: 'Период истории' }))
    expect(edit).toHaveBeenCalledWith('history', 'hold')
    fireEvent.click(screen.getByRole('button', { name: 'Период истории' }))
    release()
    expect(screen.queryByRole('dialog', { name: 'Период' })).toBeNull()

    rerender(view(true))
    expect(screen.queryByRole('button', { name: 'Настроить экран' })).toBeNull()
    // Сумма дня настраивается один раз, у первого дня; строки видны, но не нажимаются.
    expect(screen.getAllByRole('button', { name: 'Убрать «Суммы по дням»' })).toHaveLength(1)
    expect(container.querySelectorAll('.history-expense[inert]')).toHaveLength(2)
    expect(container.querySelector('.history-page.arranging')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Вернуть «Итог»' }))
    expect(change).toHaveBeenLastCalledWith({ historyBlocks: { shown: ['filters', 'total', 'day-totals'], hidden: [] } })
    fireEvent.click(screen.getByRole('button', { name: 'Убрать «Фильтры и поиск»' }))
    expect(change).toHaveBeenLastCalledWith({ historyBlocks: { shown: ['day-totals'], hidden: ['filters', 'total'] } })
    fireEvent.click(screen.getByRole('button', { name: 'Убрать «Суммы по дням»' }))
    expect(change).toHaveBeenLastCalledWith({ historyBlocks: { shown: ['filters'], hidden: ['day-totals', 'total'] } })

    // Открытый поиск возвращается вместе с обычным видом, но клавиатуру сам не открывает.
    ;(document.activeElement as HTMLElement | null)?.blur()
    rerender(view(false))
    expect(screen.getByRole('searchbox')).not.toBe(document.activeElement)
  })

  it('folds the analytics cards into plates that are removed, returned and moved', () => {
    const change = vi.fn()
    const bootstrap = expenseBootstrap({ categories: personalCategories, tags: personalTags, expenses: [spent('a', 'products', new Date().toISOString(), ['tag-0'])] })
    const { container } = render(<AnalyticsView userId="user-a" workspaceId="workspace-a" bootstrap={bootstrap} theme="light" online={false} blocks={{ shown: ['trend', 'categories'], hidden: ['weekdays'] }} editing onScreensChange={change}/>)
    const plates = () => [...container.querySelectorAll('.edit-card-list .block-name b')].map((node) => node.textContent)

    // Графиков нет, пока экран настраивают: карточки — плашки, «Теги» раскладка ещё не знала, и они стоят в конце.
    expect(titles(container)).toEqual([])
    expect(plates()).toEqual(['Динамика', 'Категории', 'Теги'])
    expect(container.querySelector('.screen-setup')).toBeNull()
    expect(container.querySelector('.analytics-fixed')?.hasAttribute('inert')).toBe(true)
    expect(screen.queryByRole('button', { name: 'Настроить экран' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Убрать «Категории»' }))
    expect(change).toHaveBeenLastCalledWith({ analyticsBlocks: { shown: ['trend', 'tags'], hidden: ['categories', 'weekdays', 'pace', 'top', 'calendar'] } })
    fireEvent.click(screen.getByRole('button', { name: 'Вернуть «По дням недели»' }))
    expect(change).toHaveBeenLastCalledWith({ analyticsBlocks: { shown: ['trend', 'categories', 'tags', 'weekdays'], hidden: ['pace', 'top', 'calendar'] } })
    fireEvent.keyDown(screen.getAllByRole('button', { name: /Перетащить/ })[1]!, { key: 'ArrowUp' })
    expect(change).toHaveBeenLastCalledWith({ analyticsBlocks: { shown: ['categories', 'trend', 'tags'], hidden: ['weekdays', 'pace', 'top', 'calendar'] } })
    fireEvent.click(screen.getByRole('button', { name: 'Размер «Категории»: большая, сделать маленькой' }))
    expect(change).toHaveBeenLastCalledWith({ analyticsBlocks: { shown: ['trend', 'categories', 'tags'], hidden: ['weekdays', 'pace', 'top', 'calendar'], small: ['categories'] } })
    // Новые карточки ждут пунктиром, пока их не поставят.
    expect(screen.getByRole('button', { name: 'Вернуть «Темп»' })).not.toBeNull()
  })

  it('puts small cards two in a row with only the main thing, and a small category card does not narrow the total', () => {
    const now = new Date().toISOString()
    const bootstrap = expenseBootstrap({ categories: personalCategories, tags: personalTags, expenses: [spent('a', 'products', now, ['tag-0']), spent('b', 'home', now)] })
    const { container } = render(<AnalyticsView userId="user-a" workspaceId="workspace-a" bootstrap={bootstrap} theme="light" online={false} blocks={{ shown: ['trend', 'categories', 'tags'], hidden: [], small: ['trend', 'categories'] }}/>)
    const small = [...container.querySelectorAll('.analytics-cards > .chart-card.small')]
    expect(small.map((card) => card.querySelector('h2')?.textContent)).toEqual(['Динамика', 'Категории'])
    expect([...small[1]!.querySelectorAll('.mini-list span')].map((node) => node.textContent)).toEqual(['Продукты', 'Для дома'])
    expect(small[1]!.querySelector('button')).toBeNull()
    expect(container.querySelector('.analytics-cards > .chart-card:not(.small) h2')?.textContent).toBe('Теги')
  })

  it('arranges «Расход» in frames: the keypad and the tiles only move, the note and the tags go and come back', () => {
    const change = vi.fn()
    const bootstrap = expenseBootstrap({ tags: personalTags })
    const { container } = render(<EntryView userId="user-a" workspaceId="workspace-a" workspace={bootstrap.workspace} bootstrap={bootstrap} setBootstrap={vi.fn()} currentId={null} setCurrentId={vi.fn()} refreshPending={vi.fn()} onDraftDirtyChange={vi.fn()} active blocks={{ shown: ['tags'], hidden: ['note'] }} editing onScreensChange={change}/>)

    // Сумма и «Сохранить» приглушены, клавиатура свёрнута в плашку и цифр не принимает.
    for (const part of ['.swipe-area', '.entry-save']) expect(container.querySelector(part)?.hasAttribute('inert')).toBe(true)
    expect(container.querySelector('.keypad')).toBeNull()
    expect(container.querySelector('.keypad-plate')?.textContent).toBe('Клавиатура')
    fireEvent.keyDown(window, { key: '5' })
    expect(screen.getByLabelText('Сумма').textContent).toBe('0')
    expect(screen.getAllByRole('button', { name: /^Переставить «/ }).map((button) => button.getAttribute('aria-label'))).toEqual(['Переставить «Клавиатура»', 'Переставить «Плитки»', 'Переставить «Теги»'])
    expect(screen.queryByRole('button', { name: 'Убрать «Клавиатура»' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Убрать «Плитки»' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Вернуть «Заметка»' }))
    expect(change).toHaveBeenLastCalledWith({ entryBlocks: { shown: ['keypad', 'tiles', 'note', 'tags'], hidden: ['today', 'usual'] } })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Переставить «Плитки»' }), { key: 'ArrowUp' })
    expect(change).toHaveBeenLastCalledWith({ entryBlocks: { shown: ['tiles', 'keypad', 'tags'], hidden: ['note', 'today', 'usual'] } })
    fireEvent.click(screen.getByRole('button', { name: 'Убрать «Теги»' }))
    expect(change).toHaveBeenLastCalledWith({ entryBlocks: { shown: ['keypad', 'tiles'], hidden: ['tags', 'note', 'today', 'usual'] } })
    fireEvent.click(screen.getByRole('button', { name: 'Вернуть «Сегодня»' }))
    expect(change).toHaveBeenLastCalledWith({ entryBlocks: { shown: ['today', 'keypad', 'tiles', 'tags'], hidden: ['note', 'usual'] } })
  })

  it('stands «Расход» blocks in the person\'s order, with the note and tags sharing a row when they meet', () => {
    const bootstrap = expenseBootstrap({ tags: personalTags })
    const view = (shown: string[]) => <EntryView userId="user-a" workspaceId="workspace-a" workspace={bootstrap.workspace} bootstrap={bootstrap} setBootstrap={vi.fn()} currentId={null} setCurrentId={vi.fn()} refreshPending={vi.fn()} onDraftDirtyChange={vi.fn()} active blocks={{ shown, hidden: [] }}/>
    const layout = (container: HTMLElement) => [...container.querySelectorAll('.entry-view > .keypad, .entry-lower-live > *')].map((node) => node.classList[0])
    const { container, rerender } = render(view(['keypad', 'tiles', 'note', 'tags']))
    // Обычный порядок — прежняя раскладка: клавиатура отдельно, всё остальное под слоем превью.
    expect(layout(container)).toEqual(['keypad', 'categories', 'extras-row', 'entry-save'])
    expect(container.querySelector('.entry-lower.with-keypad')).toBeNull()

    rerender(view(['tiles', 'keypad', 'tags', 'note']))
    expect(layout(container)).toEqual(['categories', 'keypad', 'extras-row', 'entry-save'])
    expect(container.querySelector('.entry-lower.with-keypad')).not.toBeNull()
    expect([...container.querySelector('.extras-row')!.children].map((node) => node.className.split(' ')[0])).toEqual(['tag-strip', 'tag-add'])

    rerender(view(['note', 'keypad', 'tiles', 'tags']))
    expect(layout(container)).toEqual(['extras-row', 'keypad', 'categories', 'extras-row', 'entry-save'])
    expect(entryUnits(['keypad', 'tiles', 'note', 'tags'])).toEqual({ head: [{ key: 'keypad', ids: ['keypad'] }], tail: [{ key: 'tiles', ids: ['tiles'] }, { key: 'extras', ids: ['note', 'tags'] }] })
  })

  it('puts the filters and the total in the person\'s order and moves them with ≡', () => {
    const at = '2026-09-20T10:00:00.000Z'
    const change = vi.fn()
    const bootstrap = expenseBootstrap({ categories: personalCategories, expenses: [spent('a', 'products', at)] })
    const view = (editing: boolean) => <HistoryView userId="user-a" workspaceId="workspace-a" bootstrap={bootstrap} setBootstrap={vi.fn()} edit={vi.fn()} createNew={vi.fn()} refreshPending={vi.fn()} blocks={{ shown: ['total', 'filters', 'day-totals'], hidden: [] }} editing={editing} onScreensChange={change}/>
    const { container, rerender } = render(view(false))
    expect([...container.querySelector('.history-toolbar')!.children].map((node) => node.className)).toEqual(['history-total-line', 'history-chips'])

    rerender(view(true))
    expect(screen.getAllByRole('button', { name: /^Переставить «/ }).map((button) => button.getAttribute('aria-label'))).toEqual(['Переставить «Итог»', 'Переставить «Фильтры и поиск»'])
    fireEvent.keyDown(screen.getByRole('button', { name: 'Переставить «Итог»' }), { key: 'ArrowDown' })
    expect(change).toHaveBeenLastCalledWith({ historyBlocks: { shown: ['filters', 'total', 'day-totals'], hidden: [] } })
  })

  it('opens the setup when a card on «Аналитика» or the tiles on «Расход» are held', () => {
    const edit = vi.fn()
    const bootstrap = expenseBootstrap({ categories: personalCategories, expenses: [spent('a', 'products', new Date().toISOString())] })
    const { container, unmount } = render(<AnalyticsView userId="user-a" workspaceId="workspace-a" bootstrap={bootstrap} theme="light" online={false} onEditScreen={edit}/>)
    hold(container.querySelector('.analytics-period button')!)
    release()
    expect(edit).not.toHaveBeenCalled()
    hold(container.querySelector('.chart-card')!)
    release()
    expect(edit).toHaveBeenLastCalledWith('analytics', 'hold')
    unmount()

    const entry = render(<EntryView userId="user-a" workspaceId="workspace-a" workspace={bootstrap.workspace} bootstrap={bootstrap} setBootstrap={vi.fn()} currentId={null} setCurrentId={vi.fn()} refreshPending={vi.fn()} onDraftDirtyChange={vi.fn()} active onEditScreen={edit}/>)
    hold(entry.container.querySelector('.keypad button')!)
    release()
    expect(edit).toHaveBeenCalledTimes(1)
    // Плитка после удержания не выбирается: клик, пришедший следом, гасится.
    hold(within(entry.container.querySelector('.entry-lower-live')!).getByRole('button', { name: 'Продукты' }))
    fireEvent.click(within(entry.container.querySelector('.entry-lower-live')!).getByRole('button', { name: 'Продукты' }))
    release()
    expect(edit).toHaveBeenLastCalledWith('entry', 'hold')
    expect(within(entry.container.querySelector('.entry-lower-live')!).getByRole('button', { name: 'Продукты' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('shows today\'s spending and fills in a usual expense with one tap on «Расход»', () => {
    const now = new Date().toISOString()
    const coffee = (id: string, occurredAt = now) => ({ ...spent(id, 'products', occurredAt, ['tag-0']), amountMinor: 42_000 })
    const bootstrap = expenseBootstrap({ categories: personalCategories, tags: personalTags, expenses: [coffee('a'), coffee('b'), coffee('c'), spent('d', 'home', '2026-01-01T10:00:00.000Z')] })
    const { container } = render(<EntryView userId="user-a" workspaceId="workspace-a" workspace={bootstrap.workspace} bootstrap={bootstrap} setBootstrap={vi.fn()} currentId={null} setCurrentId={vi.fn()} refreshPending={vi.fn()} onDraftDirtyChange={vi.fn()} active blocks={{ shown: ['today', 'usual', 'keypad', 'tiles', 'note', 'tags'], hidden: [] }}/>)
    expect(container.querySelector('.entry-today')?.textContent).toMatch(/^Сегодня1[\s\u00a0]260.*3 траты$/)
    fireEvent.click(screen.getByRole('button', { name: 'Как обычно: 420, #вдвоём' }))
    expect(container.querySelector('.entry-card:not(.aside) .amount-value')?.textContent).toBe('420')
    expect(within(container.querySelector('.entry-lower-live')!).getByRole('button', { name: 'Продукты' }).getAttribute('aria-pressed')).toBe('true')
    expect(within(container.querySelector('.entry-lower-live')!).getByRole('button', { name: 'вдвоём' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('counts a spending as usual after three repeats in three months, the most frequent first', () => {
    const now = Date.parse('2026-09-26T12:00:00.000Z')
    const at = (days: number) => new Date(now - days * 86_400_000).toISOString()
    const expenses = [
      spent('a', 'products', at(1)), spent('b', 'products', at(5)), spent('c', 'products', at(40)),
      spent('d', 'home', at(2)), spent('e', 'home', at(3)), spent('f', 'home', at(120)),
      { ...spent('g', 'fun', at(1)), voidedAt: at(1) }, spent('h', 'fun', at(2)), spent('i', 'fun', at(3)),
      spent('j', 'products', at(1), ['tag-0']), spent('k', 'products', at(2), ['tag-0']), spent('l', 'products', at(3), ['tag-0']), spent('m', 'products', at(4), ['tag-0']),
    ]
    expect(usualExpenses(expenses, now).map((item) => [item.categoryId, item.tagIds, item.count])).toEqual([['products', ['tag-0'], 4], ['products', [], 3]])
  })

  it('adds «Темп», «Крупные траты» and «Календарь» cards to analytics', () => {
    const now = new Date().toISOString()
    const bootstrap = expenseBootstrap({ categories: personalCategories, expenses: [spent('a', 'products', now), { ...spent('b', 'home', now), amountMinor: 5_000 }] })
    const { container } = render(<AnalyticsView userId="user-a" workspaceId="workspace-a" bootstrap={bootstrap} theme="light" online={false} blocks={{ shown: ['pace', 'top', 'calendar'], hidden: ['trend', 'categories', 'tags', 'weekdays'], small: ['calendar'] }}/>)
    expect(titles(container)).toEqual(['Темп', 'Крупные траты', 'Календарь'])
    // Прогноз — сумма за прошедшие дни недели, растянутая на всю неделю; в воскресенье неделя уже целиком.
    const elapsed = (new Date().getDay() + 6) % 7 + 1
    const forecast = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(60 / elapsed * 7)
    expect(container.querySelector('.pace-value')?.textContent).toBe(`${elapsed < 7 ? '≈ ' : ''}${forecast} RSD`)
    expect([...container.querySelectorAll('.top-row')].map((row) => [row.querySelector('span b')?.textContent, row.querySelector('.legend-value b')?.textContent])).toEqual([['Для дома', expect.stringMatching(/^50/)], ['Продукты', expect.stringMatching(/^10/)]])
    const cells = container.querySelectorAll('.calendar-heat.small > span')
    expect(cells.length % 7).toBe(0)
    expect(container.querySelector('.calendar-heat.small > span.today')).not.toBeNull()
  })

  it('offers each screen in «Мои экраны» and opens the one picked right on it', () => {
    vi.spyOn(workspaceApi, 'listMembers').mockResolvedValue({ members: [] })
    vi.spyOn(workspaceApi, 'listSessions').mockResolvedValue({ sessions: [] })
    vi.spyOn(workspaceApi, 'listInvitations').mockResolvedValue({ invitations: [] })
    const edit = vi.fn()
    const bootstrap = expenseBootstrap({ expenses: [spent('a', 'products', '2026-09-20T10:00:00.000Z')] })
    const user: AuthenticatedSession = { ...authSession(true, { historyBlocks: { shown: ['filters', 'day-totals'], hidden: ['total'] } }), workspaces: [bootstrap.workspace] }
    const view = (data: WorkspaceBootstrap) => <SettingsView user={user} workspace={data.workspace} workspaceId={data.workspace.id} bootstrap={data} setBootstrap={vi.fn()} pendingCount={0} refreshPending={vi.fn()} onLogout={vi.fn()} onSession={vi.fn()} online onEditScreen={edit}/>
    const { rerender } = render(view(bootstrap))

    expect(screen.getByRole('button', { name: /^Мои экраны/ }).textContent).toBe('Мои экраныубрано 1')
    fireEvent.click(screen.getByRole('button', { name: /^Мои экраны/ }))
    const sheet = screen.getByRole('dialog', { name: 'Мои экраны' })
    expect(within(sheet).getAllByRole('button', { name: /^(Расход|История|Аналитика)/ }).map((row) => row.textContent)).toEqual(['Расходвсё на месте', 'Историяубрано 1', 'Аналитикавсё на месте'])
    expect(sheet.textContent).toContain('Видно только вам')
    fireEvent.click(within(sheet).getByRole('button', { name: /^История/ }))
    expect(edit).toHaveBeenCalledWith('history')
    expect(screen.queryByRole('dialog', { name: 'Мои экраны' })).toBeNull()

    // Пока трат нет, в истории и аналитике нечего настраивать.
    rerender(view(expenseBootstrap()))
    fireEvent.click(screen.getByRole('button', { name: /^Мои экраны/ }))
    const empty = screen.getByRole('dialog', { name: 'Мои экраны' })
    expect((within(empty).getByRole('button', { name: /^Аналитика/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(within(empty).getByRole('button', { name: /^Аналитика/ }).textContent).toBe('Аналитикапосле первых трат')
    expect((within(empty).getByRole('button', { name: /^Расход/ }) as HTMLButtonElement).disabled).toBe(false)
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
    expect(create).toHaveBeenCalledWith(expect.any(String), 'Дом', 'RSD', 'Аня')
  })

  it('creates the workspace in the chosen currency, dinars unless changed', async () => {
    const create = vi.fn().mockResolvedValue(undefined)
    render(<CreateWorkspaceSheet existing onClose={vi.fn()} onCreate={create}/>)
    expect(screen.getByRole('button', { name: 'Валюта' }).textContent).toContain('RSD')
    fireEvent.click(screen.getByRole('button', { name: 'Валюта' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Валюта' })).getByRole('button', { name: /^EUR/ }))
    expect(screen.queryByRole('dialog', { name: 'Валюта' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Валюта' }).textContent).toContain('EUR')
    fireEvent.change(screen.getByLabelText('Название пространства'), { target: { value: 'Поездка' } })
    fireEvent.click(screen.getByRole('button', { name: 'Создать пространство' }))
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.any(String), 'Поездка', 'EUR', undefined))
  })

  it('preselects the currency it was opened with', () => {
    render(<CreateWorkspaceSheet existing initialCurrency="USD" onClose={vi.fn()} onCreate={vi.fn()}/>)
    expect(screen.getByRole('button', { name: 'Валюта' }).textContent).toContain('USD')
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
    document.body.append(outside)
    const view = render(<>
      <CreateWorkspaceSheet existing onClose={vi.fn()} onCreate={vi.fn().mockResolvedValue(undefined)}/>
      <WorkspaceSwitcher active="a" onCreate={vi.fn()} onSelect={vi.fn()} runtimes={{}} items={[{ id: 'a', name: 'A', role: 'owner', version: 1, joinedAt: '' }]}/>
    </>)
    expect(await screen.findAllByRole('dialog', { hidden: true })).toHaveLength(2)
    expect(outside.hasAttribute('inert')).toBe(true)

    view.unmount()

    expect(outside.hasAttribute('inert')).toBe(false)
    expect(outside.getAttribute('aria-hidden')).toBeNull()
    outside.remove()
  })

  it('keeps what the app changed in the background while a sheet was open', async () => {
    // Страница, которая была закрыта, пока шторка открыта, стала текущей: шторка не должна вернуть ей прежний inert.
    const page = document.createElement('div')
    page.setAttribute('inert', '')
    page.setAttribute('aria-hidden', 'true')
    document.body.append(page)
    const view = render(<WorkspaceSwitcher active="a" onCreate={vi.fn()} onSelect={vi.fn()} runtimes={{}} items={[{ id: 'a', name: 'A', role: 'owner', version: 1, joinedAt: '' }]}/>)
    expect(await screen.findByRole('dialog', { hidden: true })).not.toBeNull()
    page.removeAttribute('inert')
    page.setAttribute('aria-hidden', 'false')

    view.unmount()

    expect(page.hasAttribute('inert')).toBe(false)
    expect(page.getAttribute('aria-hidden')).toBe('false')
    page.remove()
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
    expect(screen.getByText('Это ваш ключ от приложения. Пароля нет, и если телефон потеряется, вернуться можно только по этой ссылке. Сохраните её в Заметки и никому не пересылайте.')).not.toBeNull()
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

  it('introduces the app on an invitation link and hides «Закрыть» on a clean phone', async () => {
    vi.spyOn(workspaceApi, 'previewInvitation').mockResolvedValue({ kind: 'invitation', workspace: { id: 'workspace-b', name: 'Семья' }, expiresAt: '2030-01-01T00:00:00.000Z', invitedBy: 'Аня' })
    render(<CapabilityScreen intent={{ kind: 'invite', token: 'A'.repeat(43) }} session={null} knownUserId={null} finish={vi.fn()} close={vi.fn()} resolveIdentityConflict={vi.fn()}/>)

    expect(await screen.findByRole('heading', { name: 'Аня зовёт вас в «Семья»' })).not.toBeNull()
    expect(screen.getByText('Общий список трат: записываете свои, итог за месяц виден всем. Без пароля, вход по этой ссылке.')).not.toBeNull()
    expect(screen.queryByText('Безопасная ссылка')).toBeNull()
    expect(screen.getByLabelText('Как вас называть')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Присоединиться' })).not.toBeNull()
    // Без профиля «Закрыть» вело бы на гостевой экран, где человек создаёт себе отдельное пространство вместо семейного.
    expect(screen.queryByRole('button', { name: 'Закрыть' })).toBeNull()
  })

  it('keeps «Закрыть» for a signed-in profile and copes with an invitation without a sender', async () => {
    vi.spyOn(workspaceApi, 'previewInvitation').mockResolvedValue({ kind: 'invitation', workspace: { id: 'workspace-b', name: 'Семья' }, expiresAt: '2030-01-01T00:00:00.000Z' })
    const session: AuthenticatedSession = { authenticated: true, user: { id: 'user-a', displayName: 'Аня', recoveryConfigured: true, recoveryGeneration: 1 }, currentSessionId: 'session-a', currentSessionExpiresAt: '2030-01-01T00:00:00.000Z', serverTime: '2026-08-10T14:00:00.000Z', restrictedToRecovery: false, workspaces: [], legacyWorkspaceId: null }
    render(<CapabilityScreen intent={{ kind: 'invite', token: 'A'.repeat(43) }} session={session} knownUserId="user-a" finish={vi.fn()} close={vi.fn()} resolveIdentityConflict={vi.fn()}/>)

    expect(await screen.findByRole('heading', { name: 'Вас зовут в «Семья»' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Закрыть' })).not.toBeNull()
    expect(screen.queryByLabelText('Как вас называть')).toBeNull()
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

const appWorkspace = { id: 'workspace-a', name: 'Дом', role: 'owner' as const, version: 1, joinedAt: '2026-08-01T00:00:00.000Z' }
const guest = { authenticated: false as const, user: null, workspaces: [] as [], legacyClaimAvailable: false, serverTime: '2026-08-10T14:00:00.000Z' }
const authSession = (recoveryConfigured: boolean, settings: AccountSettings = {}): AuthenticatedSession => ({ authenticated: true, user: { id: 'user-a', displayName: 'Аня', recoveryConfigured, recoveryGeneration: recoveryConfigured ? 1 : 0 }, currentSessionId: 'session-a', currentSessionExpiresAt: '2030-01-01T00:00:00.000Z', serverTime: '2026-08-10T14:00:00.000Z', restrictedToRecovery: false, workspaces: [appWorkspace], legacyWorkspaceId: null, settings })

// Целое приложение в jsdom: сеть и офлайн-хранилище подменены. Сервер доступен: неудачный запрос из прошлого теста
// мог оставить в модуле пометку «сервер недоступен», поэтому сначала её снимает удачная проверка связи.
async function renderSignedInApp({ recoveryConfigured = true, mods = [] as WorkspaceMod[], settings = {} as AccountSettings, bootstrap = expenseBootstrap() } = {}) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetchMock)
  await workspaceApi.probeServer()
  let loggedOut = false
  vi.spyOn(workspaceApi, 'getSession').mockImplementation(async () => loggedOut ? guest : authSession(recoveryConfigured, settings))
  vi.spyOn(workspaceApi, 'getBootstrap').mockResolvedValue({ data: bootstrap, offline: false })
  vi.spyOn(workspaceApi, 'syncAllWorkspaces').mockResolvedValue(undefined)
  vi.spyOn(workspaceApi, 'listMods').mockResolvedValue(mods)
  vi.spyOn(workspaceApi, 'getCardQueueStatus').mockResolvedValue({ pendingCount: 0 })
  vi.spyOn(workspaceApi, 'listMembers').mockResolvedValue({ members: [] })
  vi.spyOn(workspaceApi, 'listSessions').mockResolvedValue({ sessions: [] })
  vi.spyOn(workspaceApi, 'listInvitations').mockResolvedValue({ invitations: [] })
  vi.spyOn(workspaceApi, 'prepareInitialOrManualRecovery').mockResolvedValue(prepared)
  const logout = vi.spyOn(workspaceApi, 'logoutExpected').mockImplementation(async () => { loggedOut = true })
  vi.spyOn(workspaceOffline, 'cacheProfile').mockResolvedValue(undefined)
  vi.spyOn(workspaceOffline, 'cacheBootstrap').mockResolvedValue(undefined)
  vi.spyOn(workspaceOffline, 'readCachedBootstrap').mockResolvedValue(undefined)
  vi.spyOn(workspaceOffline, 'readCachedProfile').mockResolvedValue(undefined)
  vi.spyOn(workspaceOffline, 'outboxStats').mockResolvedValue({ total: 0, conflicts: 0, failed: 0 })
  vi.spyOn(workspaceOffline, 'waitForWorkspaceOfflineWrites').mockResolvedValue(undefined)
  vi.spyOn(workspaceOffline, 'clearUserOfflineData').mockResolvedValue(undefined)
  render(<App/>)
  return { logout, fetchMock }
}

describe('appearance in the account', () => {
  afterEach(() => {
    workspaceApi.allowWorkspaceMutations(); workspaceApi.setSessionContext(null)
    for (const key of ['theme', 'accent', 'textSize']) delete document.documentElement.dataset[key]
  })

  it('takes the look from the account, changes it there in one sheet, and returns to the default after logout', async () => {
    const { fetchMock } = await renderSignedInApp({ settings: { theme: 'dark', accent: 'blue' } })
    const root = document.documentElement
    await waitFor(() => expect(root.dataset.theme).toBe('dark'))
    expect(root.dataset.accent).toBe('blue')
    expect(root.dataset.textSize).toBeUndefined()
    expect([localStorage.getItem('moapp:theme'), localStorage.getItem('moapp:accent')]).toEqual(['dark', 'blue'])

    fireEvent.click(await screen.findByRole('button', { name: 'Настройки' }))
    const row = within(screen.getByRole('group', { name: 'Профиль' })).getByRole('button', { name: /^Внешний вид/ })
    expect(row.textContent).toBe('Внешний видголубой цвет, Тёмная')
    fireEvent.click(row)
    const sheet = screen.getByRole('dialog', { name: 'Внешний вид' })
    fireEvent.click(within(within(sheet).getByRole('group', { name: 'Тема' })).getByRole('button', { name: 'Светлая' }))
    fireEvent.click(within(sheet).getByRole('button', { name: 'Цвет: терракотовый' }))
    fireEvent.click(within(within(sheet).getByRole('group', { name: 'Размер текста' })).getByRole('button', { name: 'Крупный' }))

    // Каждый выбор виден сразу, а в аккаунт уходит одним запросом.
    expect([root.dataset.theme, root.dataset.accent, root.dataset.textSize]).toEqual(['light', 'terracotta', 'large'])
    expect(within(sheet).getByRole('button', { name: 'Цвет: терракотовый' }).getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === '/api/me/settings' && init?.method === 'PATCH'
      && init.body === JSON.stringify({ settings: { theme: 'light', accent: 'terracotta', textSize: 'large' } }))).toBe(true))
    fireEvent.click(within(sheet).getByRole('button', { name: 'Готово' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Внешний вид' })).toBeNull())
    expect(row.textContent).toBe('Внешний видтерракотовый цвет, Светлая')
    expect(within(screen.getByRole('group', { name: 'Этот телефон' })).queryByRole('button', { name: /^Внешний вид|^Тема/ })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Выйти' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Выйти' }))
    expect(await screen.findByRole('button', { name: 'Создать пространство' })).not.toBeNull()
    expect([localStorage.getItem('moapp:theme'), localStorage.getItem('moapp:accent'), localStorage.getItem('moapp:text-size')]).toEqual([null, null, null])
    expect([root.dataset.accent, root.dataset.textSize]).toEqual([undefined, undefined])
  })

  it('arranges «Расход» right on it from «Мои экраны» and keeps the change in the account', async () => {
    const { fetchMock } = await renderSignedInApp()
    fireEvent.click(await screen.findByRole('button', { name: 'Настройки' }))
    const row = () => within(screen.getByRole('group', { name: 'Профиль' })).getByRole('button', { name: /^Мои экраны/ })
    expect(row().textContent).toBe('Мои экранывсё на месте')
    fireEvent.click(row())
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Мои экраны' })).getByRole('button', { name: /^Расход/ }))

    // Лента уехала на «Расход», шапка стала полосой настройки; сохранение и клавиатура приглушены.
    expect(screen.getByRole('button', { name: 'Расход' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByText('Настройка экрана')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Убрать «Заметка»' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === '/api/me/settings' && init?.method === 'PATCH'
      && init.body === JSON.stringify({ settings: { entryBlocks: { shown: ['keypad', 'tiles', 'tags'], hidden: ['note', 'today', 'usual'] } } }))).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'Готово' }))

    expect(screen.queryByText('Настройка экрана')).toBeNull()
    expect(screen.getByRole('button', { name: 'Дом' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Добавить заметку' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Настройки' }))
    expect(row().textContent).toBe('Мои экраныубрано 1')
  })

  it('opens the setup from the header icon and tells once that holding a block works too', async () => {
    await renderSignedInApp()
    fireEvent.click(await screen.findByRole('button', { name: 'Настроить экран' }))
    expect(screen.getByText('Настройка экрана')).not.toBeNull()
    expect(await screen.findByText('Экран можно настроить и удержанием любого блока')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Готово' }))
    // Историю без трат настраивать нечего — значка там нет.
    fireEvent.click(screen.getByRole('button', { name: 'История' }))
    expect(screen.queryByRole('button', { name: 'Настроить экран' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Расход' }))
    fireEvent.click(screen.getByRole('button', { name: 'Настроить экран' }))
    expect(screen.getAllByText('Экран можно настроить и удержанием любого блока')).toHaveLength(1)
  })

  it('leaves the screen setup when the person goes to another tab', async () => {
    await renderSignedInApp({ bootstrap: expenseBootstrap({ expenses: [{ id: 'a', amountMinor: 1_000, currency: 'RSD', categoryId: 'products', note: null, tagIds: [], occurredAt: '2026-08-09T10:00:00.000Z', createdAt: '2026-08-09T10:00:00.000Z', updatedAt: '2026-08-09T10:00:00.000Z', version: 1, deletedAt: null }] }) })
    fireEvent.click(await screen.findByRole('button', { name: 'История' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Настроить экран' }))
    expect(screen.getByText('Настройка экрана')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Убрать «Итог»' })).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Аналитика' }))
    expect(screen.queryByText('Настройка экрана')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Убрать «Итог»' })).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: 'Настроить экран' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByText('Настройка экрана')).toBeNull()
  })
})

describe('mods in the app', () => {
  afterEach(() => { workspaceApi.allowWorkspaceMutations(); workspaceApi.setSessionContext(null) })

  it('opens the mods page from settings over the tabs and closes back to settings', async () => {
    await renderSignedInApp({ mods: [{ id: 'bybit-card', added: false, addedAt: null }, addedTbank] })
    fireEvent.click(await screen.findByRole('button', { name: 'Настройки' }))
    const row = await screen.findByRole('button', { name: /^Моды/ })
    await waitFor(() => expect(row.textContent).toContain('1'))
    fireEvent.click(row)

    const page = await screen.findByRole('dialog', { name: 'Моды' })
    expect(within(page).getByRole('button', { name: /Выписка Т‑Банка/ })).not.toBeNull()
    expect(within(page).getByRole('button', { name: 'Добавить мод' })).not.toBeNull()
    fireEvent.click(within(page).getByRole('button', { name: 'Закрыть' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Моды' })).toBeNull())
    expect(screen.getByRole('button', { name: /^Моды/ })).not.toBeNull()
  })
})

describe('logout confirmation', () => {
  afterEach(() => { workspaceApi.allowWorkspaceMutations(); workspaceApi.setSessionContext(null) })

  // До строки «Выйти» доходим через вкладку настроек.
  async function openLogout(recoveryConfigured: boolean) {
    const { logout } = await renderSignedInApp({ recoveryConfigured })
    fireEvent.click(await screen.findByRole('button', { name: 'Настройки' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Выйти' }))
    return { logout, dialog: await screen.findByRole('alertdialog') }
  }

  it('offers to save the access link first when leaving would lose the profile', async () => {
    const { logout, dialog } = await openLogout(false)
    expect(within(dialog).getByRole('heading').textContent).toBe('Ссылка доступа не сохранена')
    expect(dialog.textContent).toContain('После выхода вернуться в «Дом» можно будет только по новому приглашению.')
    expect(within(dialog).queryByRole('button', { name: 'Выйти' })).toBeNull()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить ссылку' }))
    expect(await screen.findByRole('heading', { name: 'Сохраните ссылку доступа' })).not.toBeNull()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(logout).not.toHaveBeenCalled()

    // Со второй попытки красная строка всё же выводит из профиля.
    fireEvent.click(screen.getByRole('button', { name: 'Позже' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Выйти' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Всё равно выйти' }))
    await waitFor(() => expect(logout).toHaveBeenCalled())
    expect(logout.mock.calls[0]?.slice(0, 2)).toEqual(['user-a', 'session-a'])
    expect(await screen.findByRole('button', { name: 'Создать пространство' })).not.toBeNull()
  })

  it('keeps the plain warning when the access link is already saved', async () => {
    const { logout, dialog } = await openLogout(true)
    expect(within(dialog).getByRole('heading').textContent).toBe('Выйти?')
    expect(within(dialog).getByText('Данные приложения удалятся с этого телефона. Вернуться можно по сохранённой ссылке доступа.')).not.toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Сохранить ссылку' })).toBeNull()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Выйти' }))
    await waitFor(() => expect(logout).toHaveBeenCalled())
    expect(logout.mock.calls[0]?.slice(0, 2)).toEqual(['user-a', 'session-a'])
    expect(await screen.findByRole('button', { name: 'Создать пространство' })).not.toBeNull()
    // Гостевой экран говорит, что это за приложение, и отводит приглашённых к ссылке из сообщения.
    expect(screen.getByRole('heading', { name: 'Общий учёт трат для семьи' })).not.toBeNull()
    expect(screen.getByText('Каждый записывает траты со своего телефона, итог за месяц виден всем. Без регистрации и пароля.')).not.toBeNull()
    expect(screen.getByText('Вас пригласили? Откройте ссылку из сообщения.')).not.toBeNull()
  })
})
