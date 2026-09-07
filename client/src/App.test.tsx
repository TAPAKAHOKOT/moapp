// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as accessFlow from './access-flow'
import App, { AnalyticsView, BybitReviewView, CapabilityScreen, CreateWorkspaceSheet, EntryView, fallbackAnalytics, formatEntryDate, formatHistoryDate, HistoryView, pagerTabsAt, RecoverySave, SettingsView, useToast, WorkspaceSwitcher } from './App'
import { splitDraft, SplitSheet } from './screens/Split'
import * as workspaceApi from './workspace-api'
import * as workspaceOffline from './workspace-offline'
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
    vi.spyOn(workspaceApi, 'classifyBybitCardTransaction').mockResolvedValue({ transaction: { ...transaction, reviewStatus: 'classified', expenseId: expense.id }, expense, expenses: [expense], pendingCount: 0 })
    vi.spyOn(workspaceApi, 'undoBybitCardTransaction').mockResolvedValue({ transaction, undoneExpenseId: expense.id, undoneExpenseIds: [expense.id], pendingCount: 1 })
    const onExpensesUndo = vi.fn()

    render(<BybitReviewView workspaceId="workspace-a" categories={expenseBootstrap().categories} currencies={expenseBootstrap().currencies} online onExpenses={vi.fn()} onExpensesUndo={onExpensesUndo} onStatus={vi.fn()}/>)

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
    await waitFor(() => expect(onExpensesUndo).toHaveBeenCalledWith([expense.id]))
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
    const props = { workspaceId: 'workspace-a', categories: expenseBootstrap().categories, currencies: expenseBootstrap().currencies, online: true, onExpenses: vi.fn(), onExpensesUndo: vi.fn(), onStatus, active: true }

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

    const { container } = render(<BybitReviewView workspaceId="workspace-a" categories={categories} currencies={expenseBootstrap().currencies} online onExpenses={vi.fn()} onExpensesUndo={vi.fn()} onStatus={vi.fn()}/>)
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
    render(<BybitReviewView workspaceId="workspace-a" categories={expenseBootstrap().categories} currencies={expenseBootstrap().currencies} online onExpenses={vi.fn()} onExpensesUndo={vi.fn()} onStatus={vi.fn()}/>)

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
      id: 'card-transaction-d', txnId: 'bybit-d', orderNo: null, type: 'purchase' as const, settled: false,
      amountMinor: 120_000, currency: 'RSD', merchantName: 'Pending Authorization', merchantCountry: 'RS', merchantCity: 'Beograd',
      mccCode: '5999', merchantCategory: 'Retail', occurredAt: '2026-08-10T12:00:00.000Z', reviewStatus: 'pending' as const, expenseId: null,
    }
    vi.spyOn(workspaceApi, 'listBybitCardTransactions').mockResolvedValue({ transactions: [transaction], pendingCount: 1 })
    const { container } = render(<BybitReviewView workspaceId="workspace-a" categories={expenseBootstrap().categories} currencies={expenseBootstrap().currencies} online onExpenses={vi.fn()} onExpensesUndo={vi.fn()} onStatus={vi.fn()}/>)

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
    render(<BybitReviewView workspaceId="workspace-a" categories={expenseBootstrap().categories} currencies={expenseBootstrap().currencies} online onExpenses={vi.fn()} onExpensesUndo={vi.fn()} onStatus={vi.fn()}/>)

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
    id: 'card-transaction-split', txnId: 'bybit-split', orderNo: null, type: 'purchase' as const, settled: true,
    amountMinor: 120_000, currency: 'RSD', merchantName: 'Maxi', merchantCountry: 'RS', merchantCity: 'Beograd',
    mccCode: '5411', merchantCategory: 'Grocery', occurredAt: '2026-08-10T12:00:00.000Z', reviewStatus: 'pending' as const,
    expenseId: null, splitIndex: null, splitCount: null,
  }
  const part = (id: string, amountMinor: number, splitIndex: number) => ({ ...transaction, id, amountMinor, splitIndex, splitCount: 2 })

  it('replaces a card payment with its parts and classifies each one on the usual card', async () => {
    const parts = [part('part-1', 80_000, 1), part('part-2', 40_000, 2)]
    vi.spyOn(workspaceApi, 'listBybitCardTransactions').mockResolvedValue({ transactions: [transaction], pendingCount: 1 })
    const split = vi.spyOn(workspaceApi, 'splitBybitCardTransaction').mockResolvedValue({ transactions: parts, pendingCount: 2 })
    const classify = vi.spyOn(workspaceApi, 'classifyBybitCardTransaction')
    const onStatus = vi.fn()

    render(<BybitReviewView workspaceId="workspace-a" categories={categories} currencies={currencies} online onExpenses={vi.fn()} onExpensesUndo={vi.fn()} onStatus={onStatus}/>)
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
    vi.spyOn(workspaceApi, 'listBybitCardTransactions').mockResolvedValue({ transactions: parts, pendingCount: 2 })
    const unsplit = vi.spyOn(workspaceApi, 'unsplitBybitCardTransaction')
      .mockResolvedValue({ transaction, removedTransactionIds: ['part-1', 'part-2'], undoneExpenseIds: [], pendingCount: 1 })

    render(<BybitReviewView workspaceId="workspace-a" categories={categories} currencies={currencies} online onExpenses={vi.fn()} onExpensesUndo={vi.fn()} onStatus={vi.fn()}/>)
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
    vi.spyOn(workspaceApi, 'listBybitCardTransactions').mockResolvedValue({ transactions: [parts[1]!], pendingCount: 1 })
    const unsplit = vi.spyOn(workspaceApi, 'unsplitBybitCardTransaction')
      .mockRejectedValueOnce(new workspaceApi.WorkspaceApiError(409, 'SPLIT_IN_USE', 'Одна из частей уже записана в историю.', { recorded: [recorded] }))
      .mockResolvedValue({ transaction, removedTransactionIds: ['part-1', 'part-2'], undoneExpenseIds: ['expense-part-1'], pendingCount: 1 })
    const onExpensesUndo = vi.fn()

    render(<BybitReviewView workspaceId="workspace-a" categories={categories} currencies={currencies} online onExpenses={vi.fn()} onExpensesUndo={onExpensesUndo} onStatus={vi.fn()}/>)
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
    vi.spyOn(workspaceApi, 'listBybitCardTransactions').mockResolvedValue({ transactions: [parts[1]!], pendingCount: 1 })
    const unsplit = vi.spyOn(workspaceApi, 'unsplitBybitCardTransaction')
      .mockRejectedValue(new workspaceApi.WorkspaceApiError(409, 'SPLIT_IN_USE', 'Одна из частей уже записана в историю.', {
        recorded: [{ id: 'part-1', splitIndex: 1, splitCount: 2, amountMinor: 80_000, currency: 'RSD', expenses: [] }],
      }))

    render(<BybitReviewView workspaceId="workspace-a" categories={categories} currencies={currencies} online onExpenses={vi.fn()} onExpensesUndo={vi.fn()} onStatus={vi.fn()}/>)
    await screen.findByText('Часть 2 из 2')
    fireEvent.click(screen.getByRole('button', { name: 'Собрать части' }))
    const sheet = await screen.findByRole('alertdialog')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Отмена' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(unsplit).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Часть 2 из 2')).not.toBeNull()
  })

  it('splits a saved expense, opens the new part and can put it back', async () => {
    const expense = {
      id: 'expense-a', amountMinor: 300_000, currency: 'RSD', categoryId: 'products', note: 'Maxi',
      occurredAt: '2026-08-10T12:00:00.000Z', createdAt: '2026-08-10T12:00:00.000Z', updatedAt: '2026-08-10T12:00:00.000Z',
      version: 3, deletedAt: null, tagIds: [],
    }
    const parts = [{ ...expense, amountMinor: 200_000, version: 4 }, { ...expense, id: 'expense-b', amountMinor: 100_000, version: 1 }]
    const split = vi.spyOn(workspaceApi, 'splitExpense').mockResolvedValue({ expenses: parts })
    const remove = vi.spyOn(workspaceApi, 'deleteExpense').mockResolvedValue(undefined)
    const update = vi.spyOn(workspaceApi, 'updateExpense').mockResolvedValue({ ...expense, version: 5 })
    const bootstrap = expenseBootstrap({ categories, currencies, expenses: [expense] })
    const setBootstrap = vi.fn()
    const setCurrentId = vi.fn()

    render(<EntryView userId="user-a" workspaceId="workspace-a" workspace={bootstrap.workspace} bootstrap={bootstrap} setBootstrap={setBootstrap} currentId={expense.id} setCurrentId={setCurrentId} refreshPending={vi.fn()} onDraftDirtyChange={vi.fn()} active/>)

    expect(screen.getByRole('button', { name: 'Разделить' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Отменить' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Разделить' }))
    const sheet = screen.getByRole('dialog', { name: /^Разделить .+ RSD$/ })
    fireEvent.change(within(sheet).getByLabelText('Сумма части 1'), { target: { value: '2000' } })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Разделить на 2 части' }))

    await waitFor(() => expect(split).toHaveBeenCalledWith('workspace-a', expense.id, 3, [200_000, 100_000]))
    await screen.findByText('Разделено на 2 части')
    // Открывается вторая часть: ради неё и делили, категорию ей меняют обычными плитками.
    expect(setCurrentId).toHaveBeenLastCalledWith('expense-b')
    const updated = setBootstrap.mock.calls.at(-1)![0](bootstrap)
    expect(updated.expenses.map((item: { id: string; amountMinor: number }) => [item.id, item.amountMinor]))
      .toEqual([['expense-a', 200_000], ['expense-b', 100_000]])

    fireEvent.click(screen.getByRole('button', { name: 'Отменить' }))
    await waitFor(() => expect(remove).toHaveBeenCalledWith('workspace-a', 'expense-b', 1))
    await waitFor(() => expect(update).toHaveBeenCalledWith('workspace-a', 'expense-a', expect.objectContaining({ version: 4, amountMinor: 300_000 })))
    await screen.findByText('Запись снова целиком')
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

  // Быстрый двойной тап по крестику уносил соседнюю часть: шит съезжал вниз, а строки — вверх.
  it('takes out one part per tap however fast the cross is tapped', () => {
    vi.useFakeTimers()
    try {
      const onSubmit = vi.fn()
      const onClose = vi.fn()
      render(<SplitSheet totalMinor={120_000} currency="RSD" currencies={currencies} onClose={onClose} onSubmit={onSubmit}/>)
      const sheet = screen.getByRole('dialog', { name: /^Разделить .+ RSD$/ })
      const amounts = () => within(sheet).getAllByRole('textbox').map((input) => (input as HTMLInputElement).value)
      for (const _ of [1, 2]) fireEvent.click(within(sheet).getByRole('button', { name: 'Ещё часть' }))
      for (const [index, value] of ['100', '200', '300'].entries()) {
        fireEvent.change(within(sheet).getByLabelText(`Сумма части ${index + 1}`), { target: { value } })
      }
      expect(amounts()).toEqual(['100', '200', '300'])

      // Второе нажатие двойного тапа приходит на то же место экрана, куда уже подъехал сосед.
      const [first, neighbour] = within(sheet).getAllByRole('button', { name: /^Убрать часть/ })
      fireEvent.click(first!)
      fireEvent.click(neighbour!)
      expect(amounts()).toEqual(['200', '300'])
      expect(onClose).not.toHaveBeenCalled()

      // «Закрыть» в эти же мгновения не слушается: на его месте только что был крестик.
      fireEvent.click(within(sheet).getByRole('button', { name: 'Закрыть' }))
      expect(onClose).not.toHaveBeenCalled()

      // Когда список осел, и крестик, и «Закрыть» снова слушаются.
      act(() => { vi.advanceTimersByTime(500) })
      fireEvent.click(within(sheet).getByRole('button', { name: 'Убрать часть 1' }))
      expect(amounts()).toEqual(['300'])
      act(() => { vi.advanceTimersByTime(500) })
      fireEvent.click(within(sheet).getByRole('button', { name: 'Закрыть' }))
      expect(onClose).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
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

  it('shows the Bybit card row to a member only once the card is connected', () => {
    vi.spyOn(workspaceApi, 'listMembers').mockResolvedValue({ members: [] })
    vi.spyOn(workspaceApi, 'listSessions').mockResolvedValue({ sessions: [] })
    const member = { ...expenseBootstrap().workspace, role: 'member' as const }
    const user: AuthenticatedSession = { authenticated: true, user: { id: 'user-a', displayName: 'Аня', recoveryConfigured: true, recoveryGeneration: 1 }, currentSessionId: 'session-a', currentSessionExpiresAt: '2030-01-01T00:00:00.000Z', serverTime: '2026-08-10T14:00:00.000Z', restrictedToRecovery: false, workspaces: [member], legacyWorkspaceId: null }
    const settings = (connected: boolean) => <SettingsView user={user} workspace={member} workspaceId={member.id} bootstrap={expenseBootstrap({ workspace: member })} setBootstrap={vi.fn()} pendingCount={0} refreshPending={vi.fn()} onLogout={vi.fn()} theme="system" onThemeChange={vi.fn()} onSession={vi.fn()} online bybitStatus={{ connected, canManage: false, pendingCount: 0 }}/>
    const disconnected = render(settings(false))
    expect(screen.queryByRole('button', { name: /Карта Bybit/ })).toBeNull()
    disconnected.unmount()

    render(settings(true))
    expect(screen.getByRole('button', { name: /Карта Bybit/ }).textContent).toContain('подключена')
  })

  it('lets the owner change the workspace currency and forgets the currency picked by hand on this phone', async () => {
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
    localStorage.setItem('moapp:v2:user:user-a:workspace:workspace-a:last-currency', 'USD')
    const bootstrap = expenseBootstrap({ currencies: [{ code: 'RSD', name: 'Сербский динар', symbol: 'дин.', decimals: 2 }, { code: 'EUR', name: 'Евро', symbol: '€', decimals: 2 }] })
    render(<SettingsView user={user} workspace={workspace} workspaceId={workspace.id} bootstrap={bootstrap} setBootstrap={setBootstrap} pendingCount={0} refreshPending={vi.fn()} onLogout={vi.fn()} theme="light" onThemeChange={vi.fn()} onSession={onSession} online/>)

    expect(screen.getByRole('button', { name: /^Валюта/ }).textContent).toContain('RSD')
    fireEvent.click(screen.getByRole('button', { name: /^Валюта/ }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Валюта' })).getByRole('button', { name: /^EUR/ }))

    await waitFor(() => expect(change).toHaveBeenCalledWith('workspace-a', 'EUR', 1))
    await waitFor(() => expect(onSession).toHaveBeenCalledWith(expect.objectContaining({ workspaces: [saved] })))
    expect(localStorage.getItem('moapp:v2:user:user-a:workspace:workspace-a:last-currency')).toBeNull()
    const patched = (setBootstrap.mock.calls[0][0] as (data: WorkspaceBootstrap) => WorkspaceBootstrap)(bootstrap)
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
    render(<SettingsView user={user} workspace={member} workspaceId={member.id} bootstrap={expenseBootstrap({ workspace: member })} setBootstrap={vi.fn()} pendingCount={0} refreshPending={vi.fn()} onLogout={vi.fn()} theme="light" onThemeChange={vi.fn()} onSession={vi.fn()} online/>)
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

describe('logout confirmation', () => {
  const workspace = { id: 'workspace-a', name: 'Дом', role: 'owner' as const, version: 1, joinedAt: '2026-08-01T00:00:00.000Z' }
  const guest = { authenticated: false as const, user: null, workspaces: [] as [], legacyClaimAvailable: false, serverTime: '2026-08-10T14:00:00.000Z' }
  const authSession = (recoveryConfigured: boolean): AuthenticatedSession => ({ authenticated: true, user: { id: 'user-a', displayName: 'Аня', recoveryConfigured, recoveryGeneration: recoveryConfigured ? 1 : 0 }, currentSessionId: 'session-a', currentSessionExpiresAt: '2030-01-01T00:00:00.000Z', serverTime: '2026-08-10T14:00:00.000Z', restrictedToRecovery: false, workspaces: [workspace], legacyWorkspaceId: null })
  afterEach(() => { workspaceApi.allowWorkspaceMutations(); workspaceApi.setSessionContext(null) })

  // Целое приложение в jsdom: сеть и офлайн-хранилище подменены, до строки «Выйти» доходим через вкладку настроек.
  async function openLogout(recoveryConfigured: boolean) {
    let loggedOut = false
    vi.spyOn(workspaceApi, 'getSession').mockImplementation(async () => loggedOut ? guest : authSession(recoveryConfigured))
    vi.spyOn(workspaceApi, 'getBootstrap').mockResolvedValue({ data: expenseBootstrap(), offline: false })
    vi.spyOn(workspaceApi, 'syncAllWorkspaces').mockResolvedValue(undefined)
    vi.spyOn(workspaceApi, 'getBybitCardStatus').mockResolvedValue({ connected: false, canManage: true, pendingCount: 0 })
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
