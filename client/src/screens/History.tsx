import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { WorkspaceApiError as ApiError, includeExpense, submitExpenseOperation, submitExpenseOperations } from '../workspace-api'
import { getWorkspacePreference, setWorkspacePreference } from '../app-state'
import type { Category, Currency, Expense, Tag } from '../types'
import { cachedDateTimeFormat, localDateKey, monthDateRange, shiftDateKey, weekdayFromDateKey } from '../utils'
import { HISTORY_PERIOD_LABELS, defaultHistoryPreferences, expenseTagNames, filterHistoryExpenses, historyTotals, parseHistoryPreferences } from '../history'
import type { HistoryPeriod, HistoryPreferences } from '../history'
import { ChevronIcon, LockIcon, MultiSelect, SearchIcon, Toast, TrashIcon, tap, useDialog, useOverflowHint, useToast } from '../ui'
import { formatAnalyticsAmount, formatDateRange, formatHistoryDate, money, pluralRu } from '../format'
import type { Bootstrap } from '../format'
import { sortTags } from '../tags'

// Календарь для фильтра истории: первый тап — начало, второй — конец; один день — два тапа по одной дате.
// Нативный <input type="date"> в iOS Safari закрывался сразу после открытия, поэтому даты выбираются в шите.
export function CalendarSheet({ from, to, onClose, onPick }: { from: string; to: string; onClose: () => void; onPick: (from: string, to: string) => void }) {
  const today = localDateKey(new Date())
  const dialogRef = useDialog(onClose)
  const [start, setStart] = useState<string | null>(null)
  const [month, setMonth] = useState(() => monthDateRange(/^\d{4}-\d{2}-\d{2}$/.test(from) ? from : today).from)
  const monthLabel = new Date(`${month}T12:00:00Z`).toLocaleDateString('ru-RU', { timeZone: 'UTC', month: 'long', year: 'numeric' }).replace(' г.', '')
  const firstCell = shiftDateKey(month, -weekdayFromDateKey(month))
  const cells = Array.from({ length: 42 }, (_, index) => shiftDateKey(firstCell, index))
  const moveMonth = (offset: number) => { setMonth(monthDateRange(month, offset).from); tap(4) }
  const pick = (key: string) => {
    tap(4)
    if (!start) { setStart(key); return }
    onPick(key < start ? key : start, key < start ? start : key)
  }
  const rangeFrom = start ?? from
  const rangeTo = start ? null : to
  const yesterday = shiftDateKey(today, -1)
  const lastMonth = monthDateRange(today, -1)
  return <div className="sheet-backdrop" onMouseDown={onClose}>
    <section ref={dialogRef} className="bottom-sheet calendar-sheet" role="dialog" aria-modal="true" aria-labelledby="calendar-title" onMouseDown={(event) => event.stopPropagation()}>
      <div className="sheet-handle"/>
      <div className="sheet-title"><h2 id="calendar-title">{start ? 'По какой день' : 'С какого дня'}</h2><button type="button" className="icon-button" data-dialog-initial-focus onClick={onClose} aria-label="Закрыть">×</button></div>
      <div className="calendar-nav"><button type="button" onClick={() => moveMonth(-1)} aria-label="Предыдущий месяц">‹</button><b data-month={month}>{monthLabel}</b><button type="button" onClick={() => moveMonth(1)} aria-label="Следующий месяц">›</button></div>
      <div className="calendar-grid" role="grid" aria-label={monthLabel}>
        {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((day) => <small key={day} aria-hidden="true">{day}</small>)}
        {cells.map((key) => {
          const inRange = Boolean(rangeFrom && rangeTo && key >= rangeFrom && key <= rangeTo)
          const edge = key === rangeFrom || key === rangeTo
          const classes = [key.slice(0, 7) !== month.slice(0, 7) ? 'other' : '', key === today ? 'today' : '', key > today ? 'future' : '', inRange && !edge ? 'in-week' : ''].filter(Boolean).join(' ')
          return <button type="button" key={key} className={classes || undefined} aria-pressed={edge} aria-label={formatHistoryDate(key)} onClick={() => pick(key)}>{Number(key.slice(8))}</button>
        })}
      </div>
      {!start && <div className="date-presets"><button type="button" onClick={() => { tap(4); onPick(yesterday, yesterday) }}>Вчера</button><button type="button" onClick={() => { tap(4); onPick(lastMonth.from, lastMonth.to) }}>Прошлый месяц</button></div>}
    </section>
  </div>
}

export const HISTORY_PERIOD_ORDER: HistoryPeriod[] = ['all', 'today', 'this-week', 'this-month', 'range']

// Период истории: пять вариантов в одном списке; «Выбрать даты» открывает календарь с диапазоном.
export function PeriodSheet({ value, onClose, onSelect }: { value: HistoryPeriod; onClose: () => void; onSelect: (period: HistoryPeriod) => void }) {
  const dialogRef = useDialog(onClose)
  const pick = (period: HistoryPeriod) => { tap(4); onSelect(period) }
  return <div className="sheet-backdrop" onMouseDown={onClose} onClick={(event) => event.preventDefault()}>
    <section ref={dialogRef} className="bottom-sheet period-sheet" role="dialog" aria-modal="true" aria-labelledby="period-title" onMouseDown={(event) => event.stopPropagation()}>
      <div className="sheet-handle"/>
      <div className="sheet-title"><h2 id="period-title">Период</h2><button type="button" className="icon-button" data-dialog-initial-focus onClick={onClose} aria-label="Закрыть">×</button></div>
      <div className="period-all">{HISTORY_PERIOD_ORDER.map((period) => <button type="button" key={period} className={value === period ? 'selected' : undefined} aria-pressed={value === period} onClick={() => pick(period)}>{HISTORY_PERIOD_LABELS[period]}</button>)}</div>
    </section>
  </div>
}

export const ROW_ACTION_WIDTH = 84

export const LONG_PRESS_MS = 450

export const ROW_DRAG_START = 8

// Строка истории: тап открывает запись, долгое нажатие включает выбор нескольких, свайп влево открывает удаление.
// Заголовок — всегда категория; второй строкой — то, что человек написал сам, и теги текстом: «Maxi · #вдвоём».
// Строк в истории сотни, и все они живут в дереве постоянно. Мемоизация с колбэками, принимающими запись,
// даёт перерисовку только тех строк, чьё состояние (выбор, открытый свайп) действительно изменилось.
export const HistoryRow = memo(function HistoryRow({ expense, category, tags, currencies, checked, selecting, open, disabled, onOpen, onToggle, onEdit, onDelete, onVoided }: {
  expense: Expense; category?: Category; tags: Tag[]; currencies: Currency[]; checked: boolean; selecting: boolean; open: boolean; disabled: boolean
  onOpen: (id: string | null) => void; onToggle: (id: string) => void; onEdit: (id: string) => void; onDelete: (expense: Expense) => void; onVoided?: (expense: Expense) => void
}) {
  const gesture = useRef<{ x: number; y: number; dragging: boolean; moved: boolean; longPress: ReturnType<typeof setTimeout> | undefined } | null>(null)
  const [dragOffset, setDragOffset] = useState<number | null>(null)
  const swipeDisabled = disabled || selecting
  useEffect(() => () => clearTimeout(gesture.current?.longPress), [])
  const finish = (commit: boolean, clientX?: number) => {
    const state = gesture.current
    gesture.current = null
    if (!state) return
    clearTimeout(state.longPress)
    if (!state.dragging) return
    setDragOffset(null)
    if (!commit || clientX === undefined) return
    const dx = clientX - state.x + (open ? -ROW_ACTION_WIDTH : 0)
    onOpen(dx < -ROW_ACTION_WIDTH / 2 ? expense.id : null)
  }
  const pointerDown = (event: React.PointerEvent) => {
    if (disabled || event.button !== 0) return
    clearTimeout(gesture.current?.longPress)
    gesture.current = { x: event.clientX, y: event.clientY, dragging: false, moved: false, longPress: selecting || open ? undefined : setTimeout(() => {
      // Долгое нажатие без движения — вход в выбор нескольких записей.
      if (gesture.current && !gesture.current.dragging) { gesture.current.moved = true; tap(8); onToggle(expense.id) }
    }, LONG_PRESS_MS) }
  }
  const pointerMove = (event: React.PointerEvent) => {
    const state = gesture.current
    if (!state) return
    const dx = event.clientX - state.x
    const dy = event.clientY - state.y
    if (!state.dragging) {
      if (Math.abs(dy) > ROW_DRAG_START && Math.abs(dy) > Math.abs(dx)) { clearTimeout(state.longPress); gesture.current = null; return }
      if (Math.abs(dx) < ROW_DRAG_START || Math.abs(dx) < Math.abs(dy) * 1.5) return
      clearTimeout(state.longPress)
      if (swipeDisabled && !open) { gesture.current = null; return }
      state.dragging = true
      state.moved = true
      event.currentTarget.setPointerCapture?.(event.pointerId)
    }
    const base = open ? -ROW_ACTION_WIDTH : 0
    setDragOffset(Math.max(-ROW_ACTION_WIDTH * 1.15, Math.min(0, base + dx)))
  }
  const click = () => {
    const moved = gesture.current?.moved
    if (moved) return
    if (open) { onOpen(null); return }
    if (selecting) onToggle(expense.id)
    else if (expense.voidedAt && onVoided) onVoided(expense)
    else onEdit(expense.id)
  }
  const translate = dragOffset ?? (open ? -ROW_ACTION_WIDTH : 0)
  const tagList = expense.tagIds?.length ? sortTags(tags.filter((tag) => expense.tagIds?.includes(tag.id))) : []
  const categoryName = category?.name || 'Скрытая категория'
  const details = [expense.note, tagList.map((tag) => `#${tag.name}`).join(' ')].filter(Boolean).join(' · ')
  return <div className={`history-expense${checked ? ' selected' : ''}${open ? ' open' : ''}`} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={(event) => finish(true, event.clientX)} onPointerCancel={() => finish(false)}>
    <div className="history-swipe" style={{ transform: translate ? `translateX(${translate}px)` : undefined, transition: dragOffset === null ? undefined : 'none', willChange: dragOffset === null ? undefined : 'transform' }}>
      <label className="expense-check" aria-label={`Выбрать расход ${categoryName}`}><input type="checkbox" tabIndex={selecting ? 0 : -1} checked={checked} onChange={() => onToggle(expense.id)}/><span/></label>
      <button type="button" className={`history-row${expense.voidedAt ? ' voided' : ''}`} aria-pressed={selecting ? checked : undefined} onClick={click}><i style={{backgroundColor:category?.color ?? '#a9afa5'}}/><span><b>{categoryName}</b>{details && <small>{details}</small>}</span><strong>{money(expense.amountMinor,expense.currency,currencies)}</strong>{expense.voidedAt ? <em className="voided-badge" aria-label="Платёж не прошёл, не учитывается">{expense.voidReason?.kind === 'reversed' ? 'Возврат' : 'Не прошёл'}</em> : expense.pending && <em aria-label="Ожидает отправки">●</em>}</button>
    </div>
    <button type="button" className="history-swipe-delete" tabIndex={open ? 0 : -1} aria-hidden={!open} disabled={disabled} onClick={() => onDelete(expense)}><TrashIcon/><span>Удалить</span></button>
  </div>
})

export type HistoryInbox = { count: number; onOpen: () => void }

export type HistoryReminder = { onSave: () => void }

// Вкладка не размонтируется, пока открыто пространство, поэтому она не должна перерисовываться от чужих
// изменений состояния приложения — только от своих данных и колбэков (все они стабильны у родителя).
export const HistoryView = memo(function HistoryView({ userId, workspaceId, bootstrap, setBootstrap, edit, createNew, refreshPending, inbox = null, reminder = null }: {
  userId: string
  workspaceId: string
  bootstrap: Bootstrap
  setBootstrap: React.Dispatch<React.SetStateAction<Bootstrap>>
  edit: (id: string) => void
  createNew: () => void
  refreshPending: () => void
  inbox?: HistoryInbox | null
  reminder?: HistoryReminder | null
}) {
  const [filters, setFilters] = useState<HistoryPreferences>(() => parseHistoryPreferences(
    getWorkspacePreference(userId, workspaceId, 'history-filters'),
    localDateKey(new Date()),
  ))
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [deleting, setDeleting] = useState(false)
  const [openRow, setOpenRow] = useState<string | null>(null)
  const [calendar, setCalendar] = useState(false)
  const [periodOpen, setPeriodOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(() => Boolean(filters.query))
  const [showParts, setShowParts] = useState(false)
  const [voided, setVoided] = useState<Expense | null>(null)
  const [including, setIncluding] = useState(false)
  const { toast, notify, dismiss } = useToast()
  // Всё производное от данных и фильтров считается один раз на их изменение: вкладка остаётся смонтированной,
  // пока открыто пространство, и без мемоизации каждый рендер приложения (например свайп по расходам на экране
  // ввода) заново фильтровал, группировал и форматировал всю историю.
  const derived = useMemo(() => {
    const categoryMap = new Map(bootstrap.categories.map((category) => [category.id, category]))
    const tags = bootstrap.tags ?? []
    const activeExpenses = bootstrap.expenses.filter((item) => !item.deletedAt)
    // Варианты фильтров идут в том же порядке, что на экране расхода и в настройках, а не по алфавиту.
    const tagOptions = sortTags(tags.filter((tag) => filters.tagIds.includes(tag.id) || activeExpenses.some((expense) => expense.tagIds?.includes(tag.id))))
    const categoryOptions = bootstrap.categories
      .filter((category) => filters.categoryIds.includes(category.id) || activeExpenses.some((expense) => expense.categoryId === category.id))
      .sort((left, right) => Number(left.placement === 'additional') - Number(right.placement === 'additional') || left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, 'ru-RU'))
    const currencyOptions = bootstrap.currencies
      .filter((currency) => filters.currencies.includes(currency.code) || activeExpenses.some((expense) => expense.currency === currency.code))
      .sort((left, right) => left.code.localeCompare(right.code))
    const normalizedQuery = filters.query.trim().toLocaleLowerCase('ru-RU')
    const expenses = filterHistoryExpenses(activeExpenses, filters).filter((item) => {
      // Текст для поиска собирается только при непустом запросе: он дорогой, а без запроса не нужен.
      if (!normalizedQuery) return true
      const dateKey = localDateKey(item.occurredAt)
      const date = new Date(item.occurredAt)
      const searchText = [
        categoryMap.get(item.categoryId)?.name,
        ...expenseTagNames(item, tags),
        item.currency,
        item.note,
        money(item.amountMinor, item.currency, bootstrap.currencies),
        String(item.amountMinor / 10 ** (bootstrap.currencies.find((currency) => currency.code === item.currency)?.decimals ?? 2)).replace('.', ','),
        formatHistoryDate(dateKey),
        cachedDateTimeFormat('ru-RU', { timeZone: 'Europe/Belgrade' }).format(date),
      ].filter(Boolean).join(' ').toLocaleLowerCase('ru-RU')
      return searchText.includes(normalizedQuery)
    })
    const grouped = expenses.reduce<Record<string, Expense[]>>((result, item) => { (result[localDateKey(item.occurredAt)] ||= []).push(item); return result }, {})
    // Итог по показанным записям. В одной валюте — точная сумма; в нескольких — пересчёт в валюту аналитики и разбивка.
    const totalsTarget = (filters.currencies.length === 1 ? filters.currencies[0] : null) || getWorkspacePreference(userId, workspaceId, 'analytics-currency') || bootstrap.defaultAnalyticsCurrency || 'RSD'
    const sumLabel = (items: Expense[]) => {
      const totals = historyTotals(items, bootstrap.currencies, bootstrap.rates, totalsTarget)
      if (!items.length) return { label: null as string | null, parts: '', totals }
      const label = totals.byCurrency.length === 1 ? money(totals.byCurrency[0]!.amountMinor, totals.byCurrency[0]!.currency, bootstrap.currencies)
        : totals.converted !== null ? `≈ ${formatAnalyticsAmount(totals.converted, totals.target)}` : null
      const parts = totals.byCurrency.length > 1 ? totals.byCurrency.map((part) => money(part.amountMinor, part.currency, bootstrap.currencies)).join(' + ') : ''
      return { label, parts, totals }
    }
    // Заголовок дня показывает сумму дня, а не число записей: по ней читается ритм трат.
    const groups = Object.entries(grouped).map(([date, items]) => ({ date, items, total: sumLabel(items).label }))
    const { label: totalLabel, parts: totalParts, totals } = sumLabel(expenses)
    return { categoryMap, tags, activeExpenses, tagOptions, categoryOptions, currencyOptions, normalizedQuery, expenses, groups, totals, totalLabel, totalParts }
  }, [bootstrap, filters, userId, workspaceId])
  const { categoryMap, tags, activeExpenses, tagOptions, categoryOptions, currencyOptions, normalizedQuery, expenses, groups, totals, totalLabel, totalParts } = derived
  useEffect(() => {
    setWorkspacePreference(userId, workspaceId, 'history-filters', JSON.stringify(filters))
  }, [filters, userId, workspaceId])
  const updateFilters = (patch: Partial<HistoryPreferences>) => {
    setFilters((current) => ({ ...current, ...patch }))
    setSelected(new Set())
  }
  const toggle = useCallback((id: string) => setSelected((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }), [])
  const filtersActive = Boolean(normalizedQuery || filters.categoryIds.length || filters.tagIds.length || filters.currencies.length || filters.period !== 'all')
  const chipStrip = useRef<HTMLDivElement>(null)
  const chipsMore = useOverflowHint(chipStrip)
  const resetFilters = () => {
    setFilters(defaultHistoryPreferences(localDateKey(new Date())))
    setSelected(new Set())
    setSearchOpen(false)
  }
  // «Учитывать всё равно»: снимает пометку провайдера. Только онлайн, как и остальные действия по карте.
  const includeOne = async (expense: Expense) => {
    if (!navigator.onLine) { notify('Нужно подключение к серверу', undefined, true); return }
    setIncluding(true)
    try {
      const updated = await includeExpense(workspaceId, expense.id, expense.version)
      setBootstrap((data) => ({ ...data, expenses: data.expenses.map((item) => item.id === updated.id ? updated : item) }))
      setVoided(null)
      notify('Расход снова учитывается')
    } catch (reason) {
      notify(reason instanceof ApiError ? reason.message : 'Не удалось обновить расход', undefined, true)
    } finally { setIncluding(false) }
  }
  const describeVoid = (expense: Expense) => {
    const reason = expense.voidReason
    const when = expense.voidedAt ? new Date(expense.voidedAt).toLocaleDateString('ru-RU') : ''
    const what = reason ? `${reason.merchantName ? `${reason.merchantName} · ` : ''}${money(reason.amountMinor, reason.currency, bootstrap.currencies)}` : ''
    return `${reason?.kind === 'reversed' ? 'Банк вернул этот платёж' : 'Этот платёж не прошёл'}${when ? ` ${when}` : ''}${what ? `: ${what}` : ''}. Запись остаётся в истории, но не считается в итогах и аналитике.`
  }
  // Удаление одной записи свайпом: мягкое удаление на сервере можно отменить обновлением той же записи.
  const restoreOne = async (deleted: Expense, original: Expense) => {
    const revived: Expense = { ...original, deletedAt: null, version: deleted.version + 1, updatedAt: new Date().toISOString(), pending: !navigator.onLine }
    setBootstrap((data) => ({ ...data, expenses: data.expenses.map((item) => item.id === revived.id ? revived : item) }))
    try {
      const result = await submitExpenseOperation(userId, workspaceId, 'updateExpense', revived)
      if (result?.expense) setBootstrap((data) => ({ ...data, expenses: data.expenses.map((item) => item.id === revived.id ? result.expense! : item) }))
      tap(6)
    } catch (error) {
      setBootstrap((data) => ({ ...data, expenses: data.expenses.map((item) => item.id === revived.id ? deleted : item) }))
      notify(error instanceof ApiError ? error.message : 'Не удалось вернуть расход', undefined, true)
    } finally { refreshPending() }
  }
  const removeOne = async (expense: Expense) => {
    if (deleting) return
    setOpenRow(null)
    setDeleting(true)
    const deletedAt = new Date().toISOString()
    setBootstrap((data) => ({ ...data, expenses: data.expenses.map((item) => item.id === expense.id ? { ...item, deletedAt, pending: !navigator.onLine } : item) }))
    setSelected((current) => { if (!current.has(expense.id)) return current; const next = new Set(current); next.delete(expense.id); return next })
    try {
      const result = await submitExpenseOperation(userId, workspaceId, 'deleteExpense', expense)
      if (result?.status === 'error') throw new ApiError(400, result.error?.code ?? 'VALIDATION', result.error?.message ?? 'Не удалось удалить расход')
      const stored = result?.expense ?? { ...expense, deletedAt, version: expense.version + 1, pending: true }
      setBootstrap((data) => ({ ...data, expenses: data.expenses.map((item) => item.id === expense.id ? stored : item) }))
      tap(8)
      notify('Расход удалён', { label: 'Вернуть', run: () => void restoreOne(stored, expense) })
    } catch (error) {
      setBootstrap((data) => ({ ...data, expenses: data.expenses.map((item) => item.id === expense.id ? expense : item) }))
      notify(error instanceof ApiError ? error.message : 'Не удалось удалить расход', undefined, true)
    } finally {
      refreshPending()
      setDeleting(false)
    }
  }
  const removeSelected = async () => {
    const targets = bootstrap.expenses.filter((expense) => !expense.deletedAt && selected.has(expense.id))
    if (!targets.length || deleting) return
    setDeleting(true)
    const targetIds = new Set(targets.map((expense) => expense.id))
    const originals = new Map(targets.map((expense) => [expense.id, expense]))
    const deletedAt = new Date().toISOString()
    setBootstrap((data) => ({ ...data, expenses: data.expenses.map((expense) => targetIds.has(expense.id) ? { ...expense, deletedAt, pending: !navigator.onLine } : expense) }))
    setSelected(new Set())
    try {
      const results = await submitExpenseOperations(userId, workspaceId, 'deleteExpense', targets)
      const failed = new Set<string>()
      const stored = new Map<string, Expense>()
      results.forEach((result, index) => {
        const target = targets[index]!
        if (result?.status === 'error') failed.add(target.id)
        else stored.set(target.id, result?.expense ?? { ...target, deletedAt, version: target.version + 1, pending: true })
      })
      setBootstrap((data) => ({ ...data, expenses: data.expenses.map((expense) => {
        if (failed.has(expense.id)) return originals.get(expense.id) ?? expense
        return stored.get(expense.id) ?? expense
      }) }))
      if (failed.size) setSelected(failed)
      notify(failed.size ? `Удалено: ${targets.length - failed.size}. Не удалось: ${failed.size}` : `Удалено расходов: ${targets.length}`, undefined, Boolean(failed.size))
    } catch (error) {
      setBootstrap((data) => ({ ...data, expenses: data.expenses.map((expense) => originals.get(expense.id) ?? expense) }))
      setSelected(targetIds)
      notify(error instanceof ApiError ? error.message : 'Не удалось удалить выбранные расходы', undefined, true)
    } finally {
      refreshPending()
      setDeleting(false)
    }
  }
  // Удаление и открытие записи замыкаются на актуальные данные, а строкам отдаются неизменные ссылки.
  const latest = useRef({ removeOne, edit })
  latest.current = { removeOne, edit }
  const deleteRow = useCallback((expense: Expense) => void latest.current.removeOne(expense), [])
  const editRow = useCallback((id: string) => latest.current.edit(id), [])
  const periodLabel = filters.period === 'all' ? 'Даты' : filters.period === 'range'
    ? (filters.from && filters.to ? formatDateRange(filters.from, filters.to) : 'Даты')
    : HISTORY_PERIOD_LABELS[filters.period]
  const countLabel = expenses.length !== activeExpenses.length ? `${expenses.length} из ${activeExpenses.length} записей` : `${expenses.length} ${pluralRu(expenses.length, ['запись', 'записи', 'записей'])}`
  return <section className="page history-page">
    {activeExpenses.length > 0 && <div className="history-toolbar">
      {selected.size > 0
        ? <div className="history-selectbar" role="toolbar" aria-label="Выбранные расходы"><span>Выбрано {selected.size}</span><button type="button" className="danger-link" onClick={removeSelected} disabled={deleting} aria-label={`Удалить выбранные расходы: ${selected.size}`}>Удалить</button><button type="button" className="text-button" onClick={() => setSelected(new Set())}>Отмена</button></div>
        : <div className={`history-chips${chipsMore ? ' more' : ''}`}>
          <div className="history-chip-strip" ref={chipStrip}>
          <button type="button" className={`filter-chip${filters.period !== 'all' ? ' active' : ''}`} aria-label="Период истории" aria-haspopup="dialog" aria-expanded={periodOpen} onClick={() => setPeriodOpen(true)}><span>{periodLabel}</span><ChevronIcon/></button>
          <MultiSelect label="Категория истории" title="Категории" placeholder="Категория" allLabel="Все категории" values={filters.categoryIds} onChange={(values) => updateFilters({ categoryIds: values })} count={(n) => `${n} ${pluralRu(n, ['категория', 'категории', 'категорий'])}`} options={categoryOptions.map((category) => ({ value: category.id, label: category.name, ...(category.archivedAt ? { hint: 'скрыта' } : {}) }))}/>
          {(currencyOptions.length > 1 || filters.currencies.length > 0) && <MultiSelect label="Валюта истории" title="Валюты" placeholder="Валюта" allLabel="Все валюты" values={filters.currencies} onChange={(values) => updateFilters({ currencies: values })} count={(n) => `${n} ${pluralRu(n, ['валюта', 'валюты', 'валют'])}`} options={currencyOptions.map((currency) => ({ value: currency.code, label: currency.code, hint: currency.name }))}/>}
          {(tagOptions.length > 0 || filters.tagIds.length > 0) && <MultiSelect label="Тег истории" title="Теги" placeholder="Тег" allLabel="Все теги" values={filters.tagIds} onChange={(values) => updateFilters({ tagIds: values })} count={(n) => `${n} ${pluralRu(n, ['тег', 'тега', 'тегов'])}`} options={tagOptions.map((tag) => ({ value: tag.id, label: tag.name }))}/>}
          </div>
          <button type="button" className={`filter-chip chip-icon${searchOpen || filters.query ? ' active' : ''}`} aria-label="Поиск" aria-pressed={searchOpen} onClick={() => { if (searchOpen) updateFilters({ query: '' }); setSearchOpen((value) => !value) }}><SearchIcon/></button>
        </div>}
      {(searchOpen || filters.query) && selected.size === 0 && <input className="search" type="search" placeholder="Поиск" aria-label="Поиск по истории" autoFocus value={filters.query} onChange={(event) => updateFilters({ query: event.target.value })}/>}
      {periodOpen && <PeriodSheet value={filters.period} onClose={() => setPeriodOpen(false)} onSelect={(period) => {
        setPeriodOpen(false)
        // Свой период без дат бесполезен, поэтому календарь открывается сразу.
        if (period === 'range') { setCalendar(true); return }
        if (period !== filters.period) updateFilters({ period })
      }}/>}
      <div className="history-total-line">
        {totalLabel && <button type="button" className="history-total" aria-label={`Сумма показанных расходов: ${totalLabel}`} aria-expanded={totalParts ? showParts : undefined} onClick={() => totalParts && setShowParts((value) => !value)}>{totalLabel}</button>}
        <span>{totalLabel ? '· ' : ''}{countLabel}</span>
        {filtersActive && <button type="button" className="history-reset" onClick={resetFilters}>Сбросить</button>}
      </div>
      {showParts && totalParts && <p className="history-total-parts">{totalParts}{totals.missing.length ? ` · нет курса: ${totals.missing.join(', ')}` : ''}</p>}
    </div>}
    {reminder && !selected.size && <div className="history-inbox history-reminder"><span className="reminder-mark"><LockIcon/></span><span><b>Сохраните ссылку доступа</b><small>Иначе без этого телефона расходы не вернуть</small></span><button type="button" className="reminder-action" onClick={reminder.onSave}>Сохранить</button></div>}
    {inbox && inbox.count > 0 && !selected.size && <button type="button" className="history-inbox" onClick={inbox.onOpen}><span className="bybit-mark">B</span><span><b>{inbox.count} {pluralRu(inbox.count, ['операция с карты ждёт', 'операции с карты ждут', 'операций с карты ждут'])} разбора</b><small>Выбрать категории</small></span><ChevronIcon/></button>}
    <div className={`history-list${selected.size ? ' selecting' : ''}`}>{groups.map(({ date, items, total }) => <div key={date} className="history-day"><div className="history-date"><span>{formatHistoryDate(date)}</span>{total && <b>{total}</b>}</div>{items.map((expense) => <HistoryRow key={expense.id} expense={expense} category={categoryMap.get(expense.categoryId)} tags={tags} currencies={bootstrap.currencies} checked={selected.has(expense.id)} selecting={selected.size > 0} open={openRow === expense.id} disabled={deleting} onOpen={setOpenRow} onToggle={toggle} onEdit={editRow} onDelete={deleteRow} onVoided={setVoided}/>)}</div>)}</div>
    {!groups.length && <div className="list-empty" role="status"><span>{filtersActive ? 'Ничего не найдено' : 'История пока пуста'}</span><p>{filtersActive ? 'Измените фильтры или сбросьте их.' : 'Добавьте первый расход — он сразу появится здесь.'}</p>{!filtersActive && <button type="button" className="primary history-empty-action" onClick={createNew}>Добавить первый расход</button>}</div>}
    {calendar && <CalendarSheet
      from={filters.period === 'range' ? filters.from : ''}
      to={filters.period === 'range' ? filters.to : ''}
      onClose={() => setCalendar(false)}
      onPick={(from, to) => { updateFilters({ period: 'range', from, to }); setCalendar(false) }}
    />}
    {voided&&<div className="sheet-backdrop" onMouseDown={()=>{if(!including)setVoided(null)}}><div className="bottom-sheet confirm voided-sheet" role="dialog" aria-modal="true" aria-labelledby="voided-title" onMouseDown={(event)=>event.stopPropagation()}><div className="sheet-handle"/><h2 id="voided-title">{voided.voidReason?.kind==='reversed'?'Платёж возвращён':'Платёж не прошёл'}</h2><p>{describeVoid(voided)}</p><button type="button" className="primary" disabled={including} onClick={()=>void includeOne(voided)}>{including?'Сохраняем…':'Учитывать всё равно'}</button><button type="button" className="sheet-cancel" disabled={including} onClick={()=>{const target=voided;setVoided(null);edit(target.id)}}>Изменить</button><button type="button" className="danger-link" disabled={including} onClick={()=>{const target=voided;setVoided(null);void removeOne(target)}}>Удалить</button></div></div>}
    {toast&&<Toast toast={toast} onDismiss={dismiss}/>}
  </section>
})
