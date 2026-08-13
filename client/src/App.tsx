import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArcElement, BarElement, CategoryScale, Chart as ChartJS, Filler, Legend,
  LinearScale, LineElement, PointElement, Tooltip,
} from 'chart.js'
import type { ChartOptions } from 'chart.js'
import { Bar, Doughnut, Line } from 'react-chartjs-2'
import { QRCodeSVG } from 'qrcode.react'
import {
  WorkspaceApiError as ApiError, createCategory, getAnalytics, getBootstrap,
  createDeviceLink, createInvitation, getSession, isLinkInvalid, legacyClaim, leaveWorkspace, listInvitations, listMembers, listSessions, logoutExpected, prepareInitialOrManualRecovery,
  prepareRecovery, previewDeviceLink, previewInvitation, previewRecovery, removeMember, renameWorkspace, reorderCategories, revokeInvitation, revokeSession, submitExpenseOperation,
  submitExpenseOperations, syncAllWorkspaces, transferOwnership, updateCategory, updateProfile,
} from './workspace-api'
import { cacheBootstrap, clearWorkspaceOfflineData, migrateLegacyOfflineData, outboxStats, readCachedProfile, waitForWorkspaceOfflineWrites } from './workspace-offline'
import { applyMembershipLoss, beginLogout, chooseCachedWorkspace, closeCapability, createAppState, createIdentityCoordinator, createLoggedOutState, forgetKnownProfile, getWorkspacePreference, hydrateAppState, openLegacyClaim, setActiveWorkspace, setWorkspacePreference, settlePendingLogout, updateWorkspace } from './app-state'
import type { AppState } from './app-state'
import { AccessFlowError, acceptDeviceWithProbe, acceptInvitationWithProbe, createIdentityWithProbe, createWorkspaceWithProbe, generateAttemptToken } from './access-flow'
import { completeRecoverySafely, completeRotationSafely } from './recovery-flow'
import { monitorServiceWorkerUpdates } from './service-worker-update'
import type { AnalyticsData, AuthenticatedSession, CapabilityIntent, Category, Currency, Expense, RecoveryPrepareResponse, SessionState, WorkspaceBootstrap, WorkspaceSummary } from './types'
import { amountToMinor, applyKeypad, convertExpense, countCalendarWeekdays, isoToLocalInput, localDateKey, localInputToIso, monthDateRange, shiftDateKey, swipeDirection, weekdayFromDateKey, weekDateRange } from './utils'

ChartJS.register(ArcElement, BarElement, CategoryScale, Filler, Legend, LinearScale, LineElement, PointElement, Tooltip)

type Tab = 'entry' | 'history' | 'analytics' | 'settings'
type Theme = 'light' | 'dark'
type AnalyticsPeriod = 'week' | 'month'
const CHART_COLOR = '#758d69'
const EMPTY_FORM = { amount: '', currency: 'RSD', note: '', occurredAt: '' }

const SWIPE_START = 14
const SWIPE_COMMIT = 64
type Bootstrap = WorkspaceBootstrap

function tap(pattern = 8) {
  navigator.vibrate?.(pattern)
}

function formatEntryDate(localInput: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(localInput)
  if (!match) return ''
  const [, year, month, day, hour, minute] = match
  return `${new Date(`${year}-${month}-${day}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}, ${hour}:${minute}`
}

const CARD_GAP = 18

type CardFace = { title: string; date: string; amount: string; currency: string }

function EntryCard({ face, onDate, onCurrency }: { face: CardFace; onDate?: () => void; onCurrency?: () => void }) {
  const inert = onCurrency ? undefined : -1
  return <>
    <header className="topline">
      <div>
        <p className="eyebrow">{face.title}</p>
        <button type="button" className="date-chip" onClick={onDate} tabIndex={inert}>{face.date}<span>⌄</span></button>
      </div>
    </header>
    <div className="amount-row">
      <output className={`amount-value${face.amount ? '' : ' empty'}`} aria-label="Сумма">{face.amount || '0'}</output>
      <button type="button" onClick={onCurrency} tabIndex={inert}>{face.currency}<span>⌄</span></button>
    </div>
  </>
}

const TrashIcon = () => <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>

function styleDeleteButton(node: HTMLButtonElement | null, presence: number, duration: number) {
  if (!node) return
  const easing = 'cubic-bezier(.25,.8,.3,1)'
  node.style.transition = duration ? `opacity ${duration}ms ${easing}, transform ${duration}ms ${easing}` : 'none'
  node.style.opacity = String(presence)
  node.style.transform = `scale(${0.82 + presence * 0.18})`
}

type ToastState = { text: string; action?: { label: string; run: () => void } }

function useToast(timeout = 2600) {
  const [toast, setToast] = useState<ToastState | null>(null)
  useEffect(() => {
    if (!toast) return
    // Тост с действием живёт дольше: на «Вернуть» нужно успеть среагировать.
    const timer = setTimeout(() => setToast(null), toast.action ? 5600 : timeout)
    return () => clearTimeout(timer)
  }, [toast, timeout])
  const notify = useCallback((text: string, action?: ToastState['action']) => setToast({ text, action }), [])
  const dismiss = useCallback(() => setToast(null), [])
  return { toast, notify, dismiss }
}

function Toast({ toast, onDismiss }: { toast: ToastState; onDismiss: () => void }) {
  const action = toast.action
  if (!action) return <button className="toast" onClick={onDismiss}>{toast.text}</button>
  return <div className="toast toast-undo" role="status"><span>{toast.text}</span><button type="button" onClick={() => { onDismiss(); action.run() }}>{action.label}</button></div>
}

function money(amountMinor: number, currency: string, currencies: Currency[]) {
  const decimals = currencies.find((item) => item.code === currency)?.decimals ?? 2
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency, maximumFractionDigits: decimals }).format(amountMinor / 10 ** decimals)
}

function inputFromExpense(expense: Expense, currencies: Currency[]) {
  const decimals = currencies.find((item) => item.code === expense.currency)?.decimals ?? 2
  return {
    amount: String(expense.amountMinor / 10 ** decimals),
    currency: expense.currency,
    note: expense.note || '',
    occurredAt: isoToLocalInput(expense.occurredAt),
  }
}

function CurrencySheet({ currencies, selected, onClose, onSelect }: { currencies: Currency[]; selected: string; onClose: () => void; onSelect: (code: string) => void }) {
  const [query, setQuery] = useState('')
  const pinned = ['RSD', 'EUR', 'USD', 'RUB']
  const filtered = currencies.filter((currency) => `${currency.code} ${currency.name}`.toLowerCase().includes(query.toLowerCase()))
  return <div className="sheet-backdrop" onMouseDown={onClose}>
    <section className="bottom-sheet tall" role="dialog" aria-modal="true" aria-label="Выберите валюту" onMouseDown={(e) => e.stopPropagation()}>
      <div className="sheet-handle"/><div className="sheet-title"><h2>Валюта</h2><button className="icon-button" onClick={onClose} aria-label="Закрыть">×</button></div>
      <input className="search" type="search" placeholder="Код или название" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
      {!query && <div className="currency-pins">{pinned.filter((code) => currencies.some((c) => c.code === code)).map((code) => <button key={code} className={selected === code ? 'selected' : ''} onClick={() => onSelect(code)}>{code}</button>)}</div>}
      <div className="currency-list">{filtered.map((currency) => <button key={currency.code} onClick={() => onSelect(currency.code)}><span><b>{currency.code}</b><small>{currency.name}</small></span><span>{currency.symbol}</span></button>)}</div>
    </section>
  </div>
}

function DateSheet({ value, onClose, onPick }: { value: string; onClose: () => void; onPick: (value: string) => void }) {
  const now = () => isoToLocalInput(new Date().toISOString())
  const [draft, setDraft] = useState(value || now())
  const shift = (days: number) => {
    const date = new Date()
    date.setDate(date.getDate() - days)
    setDraft(isoToLocalInput(date.toISOString()))
  }
  return <div className="sheet-backdrop" onMouseDown={onClose}>
    <form className="bottom-sheet editor" onSubmit={(event) => { event.preventDefault(); onPick(draft) }} onMouseDown={(event) => event.stopPropagation()}>
      <div className="sheet-handle"/>
      <div className="sheet-title"><h2>Когда</h2><button type="button" className="icon-button" onClick={onClose} aria-label="Закрыть">×</button></div>
      <div className="date-presets"><button type="button" onClick={() => shift(0)}>Сейчас</button><button type="button" onClick={() => shift(1)}>Вчера</button><button type="button" onClick={() => shift(2)}>Позавчера</button></div>
      <label>Дата и время<input type="datetime-local" required value={draft} onChange={(event) => setDraft(event.target.value)}/></label>
      <button className="primary">Готово</button>
    </form>
  </div>
}

const Keypad = memo(function Keypad({ onKey }: { onKey: (key: string) => void }) {
  const press = (key: string) => { tap(); onKey(key) }
  return <div className="keypad" aria-label="Клавиатура суммы">{['1','2','3','4','5','6','7','8','9',',','0','⌫'].map((key) => <button
    key={key}
    type="button"
    className={key === ',' || key === '⌫' ? 'keypad-aux' : undefined}
    onPointerDown={(event) => event.preventDefault()}
    onPointerUp={() => press(key)}
    onClick={(event) => { if (event.detail === 0) press(key) }}
    aria-label={key === '⌫' ? 'Удалить цифру' : key}
  >{key}</button>)}</div>
})

function CategorySheet({ categories, selectedId, onClose, onPick }: { categories: Category[]; selectedId?: string; onClose: () => void; onPick: (category: Category) => void }) {
  return <div className="sheet-backdrop" onMouseDown={onClose}><section className="bottom-sheet" role="dialog" aria-modal="true" aria-label="Другие категории" onMouseDown={(e) => e.stopPropagation()}>
    <div className="sheet-handle"/><div className="sheet-title"><h2>Другое</h2><button className="icon-button" onClick={onClose} aria-label="Закрыть">×</button></div>
    <div className="category-grid">{categories.map((category) => <button key={category.id} className={category.id === selectedId ? 'selected' : undefined} onClick={() => onPick(category)}><i style={{ backgroundColor: category.color ?? '#a9afa5' }}/><span>{category.name}</span></button>)}</div>
  </section></div>
}

function EntryView({ userId, workspaceId, bootstrap, setBootstrap, currentId, setCurrentId, refreshPending, onDraftDirtyChange }: {
  userId: string
  workspaceId: string
  bootstrap: Bootstrap; setBootstrap: React.Dispatch<React.SetStateAction<Bootstrap>>; currentId: string | null; setCurrentId: (id: string | null) => void; refreshPending: () => void; onDraftDirtyChange: (dirty: boolean) => void
}) {
  const activeExpenses = useMemo(() => bootstrap.expenses.filter((item) => !item.deletedAt).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)), [bootstrap.expenses])
  const currentIndex = currentId ? activeExpenses.findIndex((item) => item.id === currentId) : -1
  const current = currentIndex >= 0 ? activeExpenses[currentIndex] : null
  const [form, setForm] = useState(EMPTY_FORM)
  const [categorySheet, setCategorySheet] = useState(false)
  const [currencySheet, setCurrencySheet] = useState(false)
  const [dateSheet, setDateSheet] = useState(false)
  const [showNote, setShowNote] = useState(false)
  const [saving, setSaving] = useState(false)
  const { toast, notify, dismiss } = useToast()
  const swipe = useRef<{ x: number; y: number; lastX: number; active: boolean; touchId: number | null } | null>(null)
  const suppressTouchPointerUp = useRef(false)
  const entryRef = useRef<HTMLElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const deleteRef = useRef<HTMLButtonElement>(null)
  const offset = useRef(0)
  const swapped = useRef(false)
  const committing = useRef(false)
  const swapTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // Черновик несохранённого нового расхода, чтобы свайп по истории не стирал набранную сумму.
  const draft = useRef(EMPTY_FORM)
  const synced = useRef<{ id: string; form: typeof EMPTY_FORM }>({ id: '', form: EMPTY_FORM })

  useEffect(() => () => clearTimeout(swapTimer.current), [])

  // Соседняя карточка уже стоит на месте текущей, поэтому ленту возвращаем в ноль синхронно — до кадра, без мигания.
  useLayoutEffect(() => {
    const didSwap = swapped.current
    if (didSwap) {
      swapped.current = false
      committing.current = false
      const node = trackRef.current
      if (node) { node.style.transition = 'none'; node.style.transform = ''; offset.current = 0 }
    }
    // При свайпе новое состояние уже достигнуто анимацией; при удалении кнопка мягко гаснет сама.
    styleDeleteButton(deleteRef.current, currentId ? 1 : 0, didSwap ? 0 : 180)
  }, [currentId])

  useLayoutEffect(() => {
    const base = current ? inputFromExpense(current, bootstrap.currencies) : draft.current.amount ? draft.current : { ...EMPTY_FORM, currency: getWorkspacePreference(userId, workspaceId, 'last-currency') || 'RSD' }
    // Свежую версию записи подхватываем, только пока пользователь не начал править её сам.
    const sameRecord = synced.current.id === (currentId || '')
    if (sameRecord && JSON.stringify(form) !== JSON.stringify(synced.current.form)) return
    synced.current = { id: currentId || '', form: base }
    setForm(base)
    // Заметка всегда свёрнута в одну строку: развёрнутое поле у одних расходов и свёрнутое у других меняло высоту при листании.
    setShowNote(false)
  }, [currentId, current?.version]) // eslint-disable-line react-hooks/exhaustive-deps

  const key = useCallback((value: string) => setForm((previous) => ({ ...previous, amount: applyKeypad(previous.amount, value, bootstrap.currencies.find((item) => item.code === previous.currency)?.decimals ?? 2) })), [bootstrap.currencies])

  const buildExpense = (categoryId: string): Expense => {
    const now = new Date().toISOString()
    return {
      id: current?.id || crypto.randomUUID(), amountMinor: amountToMinor(form.amount, form.currency, bootstrap.currencies), currency: form.currency,
      categoryId, note: form.note.trim() || null, occurredAt: form.occurredAt ? localInputToIso(form.occurredAt) : now,
      createdAt: current?.createdAt || now, updatedAt: now, version: current ? current.version + 1 : 1, deletedAt: null, pending: !navigator.onLine,
    }
  }

  const chooseCategory = async (category: Category) => {
    if (!form.amount || Number(form.amount) <= 0) { notify('Сначала введите сумму'); return }
    setSaving(true); setCategorySheet(false)
    const expense = buildExpense(category.id)
    const previousExpense = bootstrap.expenses.find((item) => item.id === expense.id)
    setBootstrap((data) => ({ ...data, expenses: [expense, ...data.expenses.filter((item) => item.id !== expense.id)] }))
    try {
      const result = await submitExpenseOperation(userId, workspaceId, current ? 'updateExpense' : 'createExpense', expense)
      if (result?.expense) setBootstrap((data) => ({ ...data, expenses: data.expenses.map((item) => item.id === expense.id ? result.expense! : item) }))
      else if (!result) setBootstrap((data) => ({ ...data, expenses: data.expenses.map((item) => item.id === expense.id ? { ...item, pending:true } : item) }))
      notify(result?.status === 'conflict' ? 'Конфликт: выберите действие сверху' : current ? 'Изменения сохранены' : 'Расход добавлен')
      if (!current) { draft.current = EMPTY_FORM; setCurrentId(null); setForm({ ...EMPTY_FORM, currency: form.currency }) }
      else synced.current = { id: current.id, form }
      refreshPending()
    } catch (error) {
      setBootstrap((data) => {
        const optimistic = data.expenses.find((item) => item.id === expense.id)
        if (optimistic?.version !== expense.version || optimistic.updatedAt !== expense.updatedAt) return data
        return { ...data, expenses: previousExpense
          ? data.expenses.map((item) => item.id === expense.id ? previousExpense : item)
          : data.expenses.filter((item) => item.id !== expense.id) }
      })
      notify(error instanceof ApiError ? error.message : 'Не удалось сохранить')
    }
    finally { setSaving(false) }
  }

  const restore = async (deleted: Expense) => {
    // Сервер при обновлении сам снимает deleted_at, поэтому возврат — это обычная правка поверх версии после удаления.
    const restored: Expense = { ...deleted, deletedAt: null, updatedAt: new Date().toISOString(), version: deleted.version + 1, pending: !navigator.onLine }
    setBootstrap((data) => ({ ...data, expenses: data.expenses.map((item) => item.id === restored.id ? restored : item) }))
    try {
      const result = await submitExpenseOperation(userId, workspaceId, 'updateExpense', restored)
      if (result?.expense) setBootstrap((data) => ({ ...data, expenses: data.expenses.map((item) => item.id === restored.id ? result.expense! : item) }))
      notify(result?.status === 'conflict' ? 'Конфликт: выберите действие сверху' : 'Расход возвращён')
    } catch (error) {
      setBootstrap((data) => ({ ...data, expenses: data.expenses.map((item) => item.id === deleted.id && item.version === restored.version && item.updatedAt === restored.updatedAt ? deleted : item) }))
      notify(error instanceof ApiError ? error.message : 'Не удалось вернуть расход')
    }
    refreshPending()
  }

  const remove = async () => {
    if (!current) return
    const target = current
    const deletedAt = new Date().toISOString()
    setBootstrap((data) => ({ ...data, expenses: data.expenses.map((item) => item.id === target.id ? { ...item, deletedAt, pending: !navigator.onLine } : item) }))
    setCurrentId(null)
    try {
      const result = await submitExpenseOperation(userId, workspaceId, 'deleteExpense', target)
      // Версию после удаления сервер поднимает на единицу — без неё возврат ушёл бы в конфликт.
      const stored: Expense = result?.expense ?? { ...target, deletedAt, version: target.version + 1, pending: true }
      setBootstrap((data) => ({ ...data, expenses: data.expenses.map((item) => item.id === target.id ? stored : item) }))
      if (result?.status === 'conflict') notify('Конфликт: выберите действие сверху')
      else notify('Расход удалён', { label: 'Вернуть', run: () => void restore(stored) })
    } catch (error) {
      setBootstrap((data) => ({ ...data, expenses: data.expenses.map((item) => item.id === target.id && item.version === target.version && item.deletedAt === deletedAt ? target : item) }))
      setCurrentId(target.id)
      notify(error instanceof ApiError ? error.message : 'Не удалось удалить')
    }
    refreshPending()
  }

  // Слева от текущей карточки лежит более старый расход, справа — более новый (или карточка нового расхода).
  const olderNeighbour = current ? activeExpenses[currentIndex + 1] : activeExpenses[0]
  const newerNeighbour = currentIndex > 0 ? activeExpenses[currentIndex - 1] : undefined
  const canMove = (direction: 'older' | 'newer') => direction === 'older' ? Boolean(olderNeighbour) : currentIndex >= 0

  // Лента едет за пальцем один к одному, поэтому соседняя карточка видна на всём пути.
  const slide = (dx: number, duration: number) => {
    const node = trackRef.current
    if (!node) return
    const easing = 'cubic-bezier(.25,.8,.3,1)'
    node.style.transition = duration ? `transform ${duration}ms ${easing}` : 'none'
    node.style.transform = dx ? `translateX(${dx}px)` : ''
    offset.current = dx

    const sourcePresence = current ? 1 : 0
    const direction = dx ? swipeDirection(dx) : null
    const targetPresence = !direction || !canMove(direction)
      ? sourcePresence
      : direction === 'older' || Boolean(newerNeighbour) ? 1 : 0
    const progress = Math.min(Math.abs(dx) / (node.clientWidth + CARD_GAP), 1)
    styleDeleteButton(deleteRef.current, sourcePresence + (targetPresence - sourcePresence) * progress, duration)
  }

  const move = (direction: 'older' | 'newer') => {
    if (!canMove(direction)) return
    const target = direction === 'older' ? olderNeighbour : newerNeighbour ?? null
    if (!current) draft.current = form
    const span = (trackRef.current?.clientWidth ?? 320) + CARD_GAP
    const destination = direction === 'older' ? span : -span
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    // Чем ближе карточка уже подтянута пальцем, тем короче доводка — быстрый флик не должен ощущаться вязким.
    const duration = reduced ? 0 : Math.min(300, Math.max(150, Math.abs(destination - offset.current) * 0.55))
    committing.current = true
    slide(destination, duration)
    clearTimeout(swapTimer.current)
    // Подмену делаем ровно в той точке, где соседняя карточка встала на место текущей: сдвиг снимет useLayoutEffect до отрисовки.
    swapTimer.current = setTimeout(() => { swapped.current = true; setCurrentId(target?.id ?? null) }, duration)
    tap(6)
  }

  const swipeStartAt = (clientX: number, clientY: number, touchId: number | null = null) => {
    // Пока лента доезжает до соседа, новый жест перехватывать нельзя: подмена карточки дёрнет её из-под пальца.
    if (committing.current || categorySheet || currencySheet || dateSheet) return false
    swipe.current = { x: clientX, y: clientY, lastX: clientX, active: false, touchId }
    return true
  }

  const swipeMoveTo = (clientX: number, clientY: number) => {
    const start = swipe.current
    if (!start) return false
    const dx = clientX - start.x
    const dy = clientY - start.y
    start.lastX = clientX
    if (!start.active) {
      // Пока не ясно, горизонтальный это жест или что-то ещё, — не мешаем вертикальному скроллу и нажатию клавиши.
      if (Math.abs(dy) > SWIPE_START && Math.abs(dy) > Math.abs(dx)) { swipe.current = null; return false }
      if (Math.abs(dx) < SWIPE_START || Math.abs(dx) < Math.abs(dy) * 1.5) return false
      start.active = true
    }
    // В тупике (дальше расходов нет) лента почти не поддаётся — это и есть подсказка.
    slide(canMove(swipeDirection(dx)) ? dx : Math.max(-26, Math.min(26, dx * 0.2)), 0)
    return true
  }

  const swipeEndAt = (clientX: number) => {
    const start = swipe.current
    swipe.current = null
    if (!start?.active) return false
    const dx = clientX - start.x
    if (Math.abs(dx) > SWIPE_COMMIT && canMove(swipeDirection(dx))) move(swipeDirection(dx))
    else slide(0, 220)
    return true
  }

  const swipeCancelAt = () => {
    const start = swipe.current
    swipe.current = null
    if (!start?.active) return
    const dx = start.lastX - start.x
    if (Math.abs(dx) > SWIPE_COMMIT && canMove(swipeDirection(dx))) move(swipeDirection(dx))
    else slide(0, 220)
  }

  const usesNativeTouch = () => 'ontouchstart' in window

  const swipeStart = (event: React.PointerEvent) => {
    if (event.pointerType === 'touch' && usesNativeTouch()) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    swipeStartAt(event.clientX, event.clientY)
  }

  const swipeMove = (event: React.PointerEvent) => {
    if (event.pointerType === 'touch' && usesNativeTouch()) return
    swipeMoveTo(event.clientX, event.clientY)
  }

  const swipeEnd = (event: React.PointerEvent) => {
    if (event.pointerType === 'touch' && usesNativeTouch()) {
      // touchend завершит жест следом; здесь нужно лишь не пропустить pointerup до нажатой клавиши.
      if (suppressTouchPointerUp.current || swipe.current?.active) event.stopPropagation()
      return
    }
    if (!swipe.current?.active) { swipe.current = null; return }
    // Capture-фаза секции срабатывает раньше pointerup клавиши и не даёт свайпу случайно ввести цифру.
    event.stopPropagation()
    swipeEndAt(event.clientX)
  }

  const swipeCancel = (event: React.PointerEvent) => {
    if (event.pointerType === 'touch' && usesNativeTouch()) return
    swipeCancelAt()
  }

  useEffect(() => {
    const node = entryRef.current
    if (!node || !usesNativeTouch()) return
    const findTouch = (touches: TouchList, identifier: number) => Array.from(touches).find((touch) => touch.identifier === identifier)
    const touchStart = (event: TouchEvent) => {
      suppressTouchPointerUp.current = false
      if (event.touches.length !== 1) { swipe.current = null; return }
      const touch = event.touches[0]
      if (touch) swipeStartAt(touch.clientX, touch.clientY, touch.identifier)
    }
    const touchMove = (event: TouchEvent) => {
      const start = swipe.current
      if (!start || start.touchId === null) return
      const touch = findTouch(event.touches, start.touchId)
      if (touch && swipeMoveTo(touch.clientX, touch.clientY)) {
        suppressTouchPointerUp.current = true
        event.preventDefault()
      }
    }
    const touchEnd = (event: TouchEvent) => {
      const start = swipe.current
      if (!start || start.touchId === null) return
      const touch = findTouch(event.changedTouches, start.touchId)
      if (touch) swipeEndAt(touch.clientX)
      setTimeout(() => { suppressTouchPointerUp.current = false }, 0)
    }
    const touchCancel = () => {
      swipeCancelAt()
      setTimeout(() => { suppressTouchPointerUp.current = false }, 0)
    }
    node.addEventListener('touchstart', touchStart, { passive: true })
    node.addEventListener('touchmove', touchMove, { passive: false })
    node.addEventListener('touchend', touchEnd, { passive: true })
    node.addEventListener('touchcancel', touchCancel, { passive: true })
    return () => {
      node.removeEventListener('touchstart', touchStart)
      node.removeEventListener('touchmove', touchMove)
      node.removeEventListener('touchend', touchEnd)
      node.removeEventListener('touchcancel', touchCancel)
    }
  })

  const occurredLabel = formatEntryDate(form.occurredAt) || formatEntryDate(isoToLocalInput(new Date().toISOString()))
  const faceOf = (expense: Expense): CardFace => {
    const data = inputFromExpense(expense, bootstrap.currencies)
    return { title: 'Редактирование', date: formatEntryDate(data.occurredAt), amount: data.amount, currency: data.currency }
  }
  const blankFace = (amount: string, currency: string): CardFace => ({ title: 'Новый расход', date: formatEntryDate(isoToLocalInput(new Date().toISOString())), amount, currency })
  const liveFace: CardFace = current
    ? { title: 'Редактирование', date: occurredLabel, amount: form.amount, currency: form.currency }
    : { ...blankFace(form.amount, form.currency), date: occurredLabel }
  const olderFace = olderNeighbour ? faceOf(olderNeighbour) : null
  const newerFace = newerNeighbour ? faceOf(newerNeighbour)
    : currentIndex === 0 ? blankFace(draft.current.amount, draft.current.amount ? draft.current.currency : getWorkspacePreference(userId, workspaceId, 'last-currency') || 'RSD')
    : null
  const main = bootstrap.categories.filter((item) => !item.archivedAt && item.placement === 'main').sort((a,b) => a.sortOrder-b.sortOrder)
  const additional = bootstrap.categories.filter((item) => !item.archivedAt && item.placement === 'additional').sort((a,b) => a.sortOrder-b.sortOrder)
  const ready = Boolean(form.amount) && Number(form.amount) > 0
  const currentCategory = current ? bootstrap.categories.find((item) => item.id === current.categoryId) : undefined
  // Категорию из «Другого» показываем на самой кнопке «Другое»: добавлять её в сетку нельзя — та переносится на вторую строку и дёргает раскладку.
  const otherFace = currentCategory && !main.some((item) => item.id === currentCategory.id) ? currentCategory : null
  const dirty = current ? JSON.stringify(form) !== JSON.stringify(inputFromExpense(current, bootstrap.currencies)) : Boolean(form.amount || form.note || form.occurredAt)
  useEffect(() => { onDraftDirtyChange(dirty) }, [dirty, onDraftDirtyChange])
  useEffect(() => () => onDraftDirtyChange(false), [onDraftDirtyChange])
  const categoryHint = !ready ? 'Сначала введите сумму' : dirty ? 'Выберите категорию, чтобы сохранить' : 'Категория'
  return <section ref={entryRef} className={`entry-view${current ? ' editing' : ''}`} onPointerDown={swipeStart} onPointerMove={swipeMove} onPointerUpCapture={swipeEnd} onPointerCancel={swipeCancel}>
    <div className="swipe-area">
      <div className="entry-track" ref={trackRef}>
        {olderFace && <div className="entry-card aside older" aria-hidden="true"><EntryCard face={olderFace}/></div>}
        <div className="entry-card"><EntryCard face={liveFace} onDate={() => setDateSheet(true)} onCurrency={() => setCurrencySheet(true)}/></div>
        {newerFace && <div className="entry-card aside newer" aria-hidden="true"><EntryCard face={newerFace}/></div>}
      </div>
    </div>
    <button ref={deleteRef} type="button" className={`icon-danger entry-delete${current ? '' : ' off'}`} onClick={remove} tabIndex={current ? 0 : -1} aria-hidden={!current} aria-label="Удалить расход"><TrashIcon/></button>
    <Keypad onKey={key}/>
    <div className={`categories${ready ? '' : ' locked'}${dirty ? ' unsaved' : ''}`}><p>{categoryHint}</p><div className="main-categories">{main.map((category) => <button disabled={saving} key={category.id} className={category.id === current?.categoryId ? 'selected' : undefined} onClick={() => chooseCategory(category)}><i style={{backgroundColor:category.color ?? '#a9afa5'}}/><span>{category.name}</span></button>)}<button className={otherFace ? 'selected' : undefined} onClick={() => setCategorySheet(true)}>{otherFace ? <i style={{backgroundColor:otherFace.color ?? '#a9afa5'}}/> : <i className="dots">•••</i>}<span>{otherFace ? otherFace.name : 'Другое'}</span></button></div></div>
    <div className="note-block">{!showNote ? <button className="text-button" onClick={() => setShowNote(true)}>{form.note ? `✎ ${form.note}` : '＋ Добавить заметку'}</button> : <label>Заметка <span>необязательно</span><input autoFocus maxLength={200} placeholder="Например, IKEA" value={form.note} onChange={(e) => setForm({...form,note:e.target.value})}/></label>}</div>
    {dateSheet && <DateSheet value={form.occurredAt} onClose={() => setDateSheet(false)} onPick={(value) => { setForm({ ...form, occurredAt: value }); setDateSheet(false) }}/>}
    {categorySheet && <CategorySheet categories={additional} selectedId={current?.categoryId} onClose={() => setCategorySheet(false)} onPick={chooseCategory}/>}
    {currencySheet && <CurrencySheet
      currencies={bootstrap.currencies}
      selected={form.currency}
      onClose={() => setCurrencySheet(false)}
      onSelect={(currency) => {
        setForm({...form,currency})
        setWorkspacePreference(userId, workspaceId, 'last-currency', currency)
        setCurrencySheet(false)
      }}
    />}
    {toast && <Toast toast={toast} onDismiss={dismiss}/>}
  </section>
}

function HistoryView({ userId, workspaceId, bootstrap, setBootstrap, edit, refreshPending }: {
  userId: string
  workspaceId: string
  bootstrap: Bootstrap
  setBootstrap: React.Dispatch<React.SetStateAction<Bootstrap>>
  edit: (id: string) => void
  refreshPending: () => void
}) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [deleting, setDeleting] = useState(false)
  const { toast, notify, dismiss } = useToast()
  const categoryMap = new Map(bootstrap.categories.map((category) => [category.id, category]))
  const expenses = bootstrap.expenses.filter((item) => !item.deletedAt && `${categoryMap.get(item.categoryId)?.name} ${item.currency}`.toLowerCase().includes(query.toLowerCase())).sort((a,b) => b.occurredAt.localeCompare(a.occurredAt))
  const grouped = expenses.reduce<Record<string, Expense[]>>((result, item) => { (result[localDateKey(item.occurredAt)] ||= []).push(item); return result }, {})
  const groups = Object.entries(grouped)
  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const removeSelected = async () => {
    const targets = bootstrap.expenses.filter((expense) => !expense.deletedAt && selected.has(expense.id))
    if (!targets.length || deleting) return
    setDeleting(true)
    const targetIds = new Set(targets.map((expense) => expense.id))
    const originals = new Map(targets.map((expense) => [expense.id, expense]))
    const deletedAt = new Date().toISOString()
    setBootstrap((data) => ({ ...data, expenses: data.expenses.map((expense) => targetIds.has(expense.id) ? { ...expense, deletedAt, pending: !navigator.onLine } : expense) }))
    setSelected(new Set())
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
    notify(failed.size ? `Удалено: ${targets.length - failed.size}. Не удалось: ${failed.size}` : `Удалено расходов: ${targets.length}`)
    refreshPending()
    setDeleting(false)
  }
  return <section className="page"><header className="page-header history-title"><div><p className="eyebrow">Все записи</p><h1>История</h1></div><button type="button" className={`icon-danger history-delete${selected.size ? '' : ' off'}`} onClick={removeSelected} disabled={deleting} tabIndex={selected.size ? 0 : -1} aria-hidden={!selected.size} aria-label={`Удалить выбранные расходы: ${selected.size}`}><TrashIcon/></button></header><input className="search" type="search" placeholder="Категория или валюта" value={query} onChange={(e) => setQuery(e.target.value)}/>
    <div className="history-list">{groups.map(([date, items]) => <div key={date} className="history-day"><div className="history-date"><span>{new Date(`${date}T12:00:00Z`).toLocaleDateString('ru-RU',{timeZone:'Europe/Belgrade',day:'numeric',month:'long'})}</span><b>{items?.length}</b></div>{items?.map((expense) => { const category=categoryMap.get(expense.categoryId); const checked=selected.has(expense.id); return <div key={expense.id} className={`history-expense${checked ? ' selected' : ''}`}><label className="expense-check" aria-label={`Выбрать расход ${category?.name || ''}`}><input type="checkbox" checked={checked} onChange={()=>toggle(expense.id)}/><span/></label><button className="history-row" onClick={() => edit(expense.id)}><i style={{backgroundColor:category?.color ?? '#a9afa5'}}/><span><b>{category?.name || 'Архивная категория'}</b><small>{new Date(expense.occurredAt).toLocaleTimeString('ru-RU',{timeZone:'Europe/Belgrade',hour:'2-digit',minute:'2-digit'})}{expense.note ? ` · ${expense.note}`:''}</small></span><strong>{money(expense.amountMinor,expense.currency,bootstrap.currencies)}</strong>{expense.pending && <em>●</em>}</button></div>})}</div>)}</div>
    {toast&&<Toast toast={toast} onDismiss={dismiss}/>}
  </section>
}

function AnalyticsView({ userId, workspaceId, bootstrap, theme }: { userId: string; workspaceId: string; bootstrap: Bootstrap; theme: Theme }) {
  const [target, setTarget] = useState(getWorkspacePreference(userId, workspaceId, 'analytics-currency') || 'RSD')
  const [period, setPeriod] = useState<AnalyticsPeriod>('week')
  const [weekOffset, setWeekOffset] = useState(0)
  const [monthOffset, setMonthOffset] = useState(0)
  const [categoryByPeriod, setCategoryByPeriod] = useState<Record<AnalyticsPeriod,string|null>>({week:'products',month:null})
  const [currencySheet, setCurrencySheet] = useState(false)
  const [remote,setRemote]=useState<{key:string;data:AnalyticsData;previousTotalMinor:number|null}|null>(null)
  const [analyticsOffline,setAnalyticsOffline]=useState(!navigator.onLine)
  const [analyticsLoading,setAnalyticsLoading]=useState(navigator.onLine)
  const today=localDateKey(new Date())
  const selectedWeek=weekDateRange(today,weekOffset)
  const selectedMonth=monthDateRange(today,monthOffset)
  const previousWeek=weekDateRange(today,weekOffset-1)
  const currentWeekPartial=weekOffset===0&&weekdayFromDateKey(today)<6
  const previousAnalyticsTo=currentWeekPartial?shiftDateKey(previousWeek.from,weekdayFromDateKey(today)):previousWeek.to
  const activeCategories=bootstrap.categories.filter((category)=>!category.archivedAt).sort((a,b)=>a.placement.localeCompare(b.placement)||a.sortOrder-b.sortOrder)
  const requestedCategoryId=categoryByPeriod[period]
  const categoryId=requestedCategoryId&&activeCategories.some((category)=>category.id===requestedCategoryId)?requestedCategoryId:null
  const selectedRange=period==='week'?selectedWeek:selectedMonth
  const from=selectedRange.from
  const analyticsTo=selectedRange.to>today?today:selectedRange.to
  const expenseRevision=bootstrap.expenses.map((expense)=>`${expense.id}:${expense.version}:${expense.updatedAt}:${expense.deletedAt||''}:${expense.amountMinor}:${expense.currency}:${expense.categoryId}:${expense.occurredAt}`).join('|')
  const requestKey=`${expenseRevision}:${from}:${analyticsTo}:${target}:${period}:${categoryId??'all'}`
  const fallback=useMemo(()=>fallbackAnalytics(bootstrap,target,from,analyticsTo,categoryId),[bootstrap,target,from,analyticsTo,categoryId])
  const previousFallback=useMemo(()=>fallbackAnalytics(bootstrap,target,previousWeek.from,previousAnalyticsTo,categoryId),[bootstrap,target,previousWeek.from,previousAnalyticsTo,categoryId])
  useEffect(()=>{let active=true;if(!navigator.onLine){setAnalyticsOffline(true);setAnalyticsLoading(false);setRemote(null);return}setAnalyticsLoading(true);Promise.all([getAnalytics(workspaceId,from,analyticsTo,target,categoryId??undefined),period==='week'?getAnalytics(workspaceId,previousWeek.from,previousAnalyticsTo,target,categoryId??undefined):Promise.resolve(null)]).then(([result,previous])=>{if(active){setRemote({key:requestKey,data:result,previousTotalMinor:previous?.totalMinor??null});setAnalyticsOffline(false);setAnalyticsLoading(false)}}).catch(()=>{if(active){setRemote(null);setAnalyticsOffline(true);setAnalyticsLoading(false)}});return()=>{active=false}},[workspaceId,from,analyticsTo,target,categoryId,period,previousWeek.from,previousAnalyticsTo,requestKey])
  const data=remote?.key===requestKey?remote.data:fallback
  const previousTotalMinor=remote?.key===requestKey?remote.previousTotalMinor:period==='week'?previousFallback.totalMinor:null
  const decimals=bootstrap.currencies.find((currency)=>currency.code===target)?.decimals??2
  const divisor=10**decimals
  const periodDays=Math.round((new Date(`${selectedRange.to}T12:00:00Z`).getTime()-new Date(`${selectedRange.from}T12:00:00Z`).getTime())/86400000)+1
  const days=Array.from({length:periodDays},(_,index)=>shiftDateKey(selectedRange.from,index))
  const dailyMap=new Map(data.daily.map((point)=>[point.date,point.amountMinor/divisor]))
  const byDay=days.map((date)=>dailyMap.get(date)||0)
  const byCategory=data.categories.filter((item)=>item.amountMinor>0).map((item)=>({...item,value:item.amountMinor/divisor}))
  const serverWeekdays=new Map(data.weekdays.map((point)=>[point.weekday,point.amountMinor/divisor]))
  const weekdayCounts=countCalendarWeekdays(from,analyticsTo)
  const weekdays=[1,2,3,4,5,6,0].map((day)=>Math.round((serverWeekdays.get(day)||0)/(weekdayCounts[day]||1)))
  const total=data.totalMinor/divisor
  const previousTotal=(previousTotalMinor??0)/divisor
  const elapsedDays=Math.max(1,Math.round((new Date(`${analyticsTo}T12:00:00Z`).getTime()-new Date(`${from}T12:00:00Z`).getTime())/86400000)+1)
  const weekRange=formatWeekRange(selectedWeek.from,selectedWeek.to)
  const monthLabel=new Date(`${selectedMonth.from}T12:00:00Z`).toLocaleDateString('ru-RU',{timeZone:'UTC',month:'long',year:'numeric'})
  const selectedCategoryName=categoryId?activeCategories.find((category)=>category.id===categoryId)?.name:'Все категории'
  const chartColor=theme==='dark'?'#9ab58e':CHART_COLOR
  const chartText=theme==='dark'?'#a6aaa1':'#73776f'
  const lineOptions:ChartOptions<'line'>={responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:(context)=>formatAnalyticsAmount(context.parsed.y??0,target)}}},scales:{x:{grid:{display:false},ticks:{maxTicksLimit:period==='week'?7:6,color:chartText}},y:{beginAtZero:true,border:{display:false},grid:{color:theme==='dark'?'rgba(255,255,255,.06)':'rgba(32,37,31,.06)'},ticks:{color:chartText,maxTicksLimit:4,callback:(value)=>formatCompactNumber(Number(value))}}}}
  const barOptions:ChartOptions<'bar'>={responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:(context)=>formatAnalyticsAmount(context.parsed.y??0,target)}}},scales:{x:{grid:{display:false},ticks:{color:chartText}},y:{beginAtZero:true,border:{display:false},grid:{color:theme==='dark'?'rgba(255,255,255,.06)':'rgba(32,37,31,.06)'},ticks:{color:chartText,maxTicksLimit:4,callback:(value)=>formatCompactNumber(Number(value))}}}}
  return <section className="page analytics"><header className="page-header analytics-title"><div><p className="eyebrow">{period==='week'?'Расходы за неделю':'Расходы за месяц'} · {selectedCategoryName}</p><h1>{new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}).format(total)} <small>{target}</small></h1>{period==='week'&&<p className="analytics-comparison">{weekComparisonLabel(total,previousTotal,currentWeekPartial)}</p>}</div><button className="currency-choice" onClick={()=>setCurrencySheet(true)}>{target}⌄</button></header>
    <div className="analytics-period" role="group" aria-label="Период аналитики"><button type="button" aria-pressed={period==='week'} className={period==='week'?'selected':''} onClick={()=>setPeriod('week')}>Неделя</button><button type="button" aria-pressed={period==='month'} className={period==='month'?'selected':''} onClick={()=>setPeriod('month')}>Месяц</button></div>
    <label className="analytics-category"><span>Категория</span><select aria-label="Категория расходов" value={categoryId??''} onChange={(event)=>setCategoryByPeriod((current)=>({...current,[period]:event.target.value||null}))}><option value="">Все категории</option>{activeCategories.map((category)=><option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
    {period==='week'&&<div className="week-navigator"><button type="button" onClick={()=>setWeekOffset((value)=>value-1)} aria-label="Предыдущая неделя">‹</button><div><b>{weekOffset===0?'Текущая неделя':weekOffset===-1?'Прошлая неделя':'Выбранная неделя'}</b><span>{weekRange}</span></div><button type="button" onClick={()=>setWeekOffset((value)=>Math.min(0,value+1))} disabled={weekOffset===0} aria-label="Следующая неделя">›</button></div>}
    {period==='month'&&<div className="week-navigator"><button type="button" onClick={()=>setMonthOffset((value)=>value-1)} aria-label="Предыдущий месяц">‹</button><div><b>{monthOffset===0?'Текущий месяц':monthOffset===-1?'Прошлый месяц':'Выбранный месяц'}</b><span>{monthLabel}</span></div><button type="button" onClick={()=>setMonthOffset((value)=>Math.min(0,value+1))} disabled={monthOffset===0} aria-label="Следующий месяц">›</button></div>}
    <div className="analytics-stats"><div><span>Среднее в день</span><strong>{formatAnalyticsAmount(total/elapsedDays,target)}</strong></div><div><span>Операций</span><strong>{data.expenseCount}</strong></div></div>
    <p className="rate-caption">{analyticsLoading?'Обновляем аналитику…':analyticsOffline?'Офлайн-оценка по последнему сохранённому курсу':data.rateDate?`Исторические курсы с ${new Date(`${data.rateDate}T12:00:00Z`).toLocaleDateString('ru-RU')}`:'Курсы обновляются'}{data.missingCurrencies.length?` · без ${data.missingCurrencies.join(', ')}`:''}</p>
    <div className="chart-card"><div><h2>Динамика</h2><p>{period==='week'?'Понедельник — воскресенье':'По дням выбранного месяца'}</p></div>{data.expenseCount?<div className="line-chart"><Line data={{labels:days.map((d)=>new Date(`${d}T12:00`).toLocaleDateString('ru-RU',period==='week'?{weekday:'short'}:{day:'numeric',month:'short'})),datasets:[{data:byDay,borderColor:chartColor,backgroundColor:theme==='dark'?'rgba(154,181,142,.16)':'rgba(117,141,105,.12)',fill:true,tension:.38,pointRadius:period==='week'?3:0,pointBackgroundColor:chartColor,borderWidth:2}]}} options={lineOptions}/></div>:<AnalyticsEmpty>В этом периоде ещё нет расходов</AnalyticsEmpty>}</div>
    <div className={`chart-card${byCategory.length?' split':''}`}><div><h2>Категории</h2><p>{period==='week'?'За выбранную неделю':'За выбранный месяц'}</p></div>{byCategory.length?<><div className="donut-wrap"><Doughnut data={{labels:byCategory.map((x)=>x.name),datasets:[{data:byCategory.map((x)=>x.value),backgroundColor:byCategory.map((x)=>x.color||'#a9afa5'),borderWidth:0,spacing:3}]}} options={{responsive:true,maintainAspectRatio:false,cutout:'72%',plugins:{legend:{display:false},tooltip:{callbacks:{label:(context)=>formatAnalyticsAmount(context.parsed,target)}}}}}/><span>{formatCompactNumber(total)}</span></div><div className="legend">{byCategory.slice(0,5).map((x)=><div key={x.categoryId}><i style={{background:x.color||'#a9afa5'}}/><span>{x.name}</span><span className="legend-value"><b>{formatAnalyticsAmount(x.value,target)}</b><small>{Math.round(x.value/total*100)||0}%</small></span></div>)}</div></>:<AnalyticsEmpty>Категории появятся после первого расхода</AnalyticsEmpty>}</div>
    {period==='month'&&<div className="chart-card"><div><h2>По дням недели</h2><p>Средние траты за календарный день</p></div>{data.expenseCount?<div className="bar-chart"><Bar data={{labels:['Пн','Вт','Ср','Чт','Пт','Сб','Вс'],datasets:[{data:weekdays,backgroundColor:chartColor,borderRadius:6,borderSkipped:false}]}} options={barOptions}/></div>:<AnalyticsEmpty>Недостаточно данных для сравнения</AnalyticsEmpty>}</div>}
    {currencySheet && <CurrencySheet currencies={bootstrap.currencies} selected={target} onClose={()=>setCurrencySheet(false)} onSelect={(code)=>{setTarget(code);setWorkspacePreference(userId, workspaceId, 'analytics-currency', code);setCurrencySheet(false)}}/>}
  </section>
}

function AnalyticsEmpty({children}:{children:string}) {
  return <div className="analytics-empty"><span>⌁</span><p>{children}</p></div>
}

function formatAnalyticsAmount(value:number,currency:string) {
  return `${new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}).format(value)} ${currency}`
}

function formatCompactNumber(value:number) {
  return new Intl.NumberFormat('ru-RU',{notation:'compact',maximumFractionDigits:1}).format(value)
}

function weekComparisonLabel(total:number,previous:number,partial:boolean) {
  const comparison=partial?'за те же дни прошлой недели':'на прошлой неделе'
  if(previous===0)return total===0?`Как и ${comparison}`:partial?'За те же дни прошлой недели расходов не было':'На прошлой неделе расходов не было'
  const difference=Math.round(Math.abs(total-previous)/previous*100)
  if(difference===0)return partial?'На уровне тех же дней прошлой недели':'На уровне прошлой недели'
  return `На ${difference}% ${total>previous?'больше':'меньше'}, чем ${comparison}`
}

function fallbackAnalytics(bootstrap:Bootstrap,target:string,from:string,to:string,categoryId:string|null):AnalyticsData {
  const decimals=bootstrap.currencies.find((currency)=>currency.code===target)?.decimals??2
  const categories=new Map(bootstrap.categories.map((category)=>[category.id,category]))
  const expenses=bootstrap.expenses.filter((expense)=>!expense.deletedAt&&(!categoryId||expense.categoryId===categoryId)).map((expense)=>({expense,date:localDateKey(expense.occurredAt),amountMinor:Math.round(convertExpense(expense,target,bootstrap.currencies,bootstrap.rates)*10**decimals)})).filter((item)=>item.date>=from&&item.date<=to)
  const sum=(items:typeof expenses)=>items.reduce((total,item)=>total+item.amountMinor,0)
  const dates=[...new Set(expenses.map((item)=>item.date))]
  return {currency:target,from,to,totalMinor:sum(expenses),expenseCount:expenses.length,convertedCount:expenses.length,rateDate:bootstrap.rates.date,missingCurrencies:[],daily:dates.map((date)=>{const items=expenses.filter((item)=>item.date===date);return{date,amountMinor:sum(items),count:items.length}}),categories:[...categories.values()].map((category)=>{const items=expenses.filter((item)=>item.expense.categoryId===category.id);return{categoryId:category.id,name:category.name,color:category.color,amountMinor:sum(items),count:items.length}}),weekdays:Array.from({length:7},(_,weekday)=>{const items=expenses.filter((item)=>(weekdayFromDateKey(item.date)+1)%7===weekday);return{weekday,amountMinor:sum(items),count:items.length}}),calendar:dates.map((date)=>{const items=expenses.filter((item)=>item.date===date);return{date,amountMinor:sum(items),count:items.length}})}
}

function formatWeekRange(from:string,to:string) {
  const start=new Date(`${from}T12:00:00Z`),end=new Date(`${to}T12:00:00Z`)
  const sameMonth=start.getUTCFullYear()===end.getUTCFullYear()&&start.getUTCMonth()===end.getUTCMonth()
  const startLabel=start.toLocaleDateString('ru-RU',{timeZone:'UTC',day:'numeric',...(sameMonth?{}:{month:'short'})}).replace('.','')
  const endLabel=end.toLocaleDateString('ru-RU',{timeZone:'UTC',day:'numeric',month:sameMonth?'long':'short'}).replace('.','')
  return `${startLabel}–${endLabel}`
}

function AccessSettings({ user, workspace, pendingCount, onSession, onCreateWorkspace, onNotice }: {
  user: AuthenticatedSession
  workspace: WorkspaceSummary
  pendingCount: number
  onSession: (session: SessionState) => Promise<void>
  onCreateWorkspace: () => void
  onNotice: (message: string) => void
}) {
  const [members, setMembers] = useState<import('./types').Participant[]>([])
  const [devices, setDevices] = useState<import('./types').DeviceSession[]>([])
  const [invitations, setInvitations] = useState<import('./types').InvitationMetadata[]>([])
  const [link, setLink] = useState<{ title: string; url: string; expiresAt?: string; revoke?: () => Promise<void> } | null>(null)
  const [name, setName] = useState(user.user.displayName)
  const [workspaceName, setWorkspaceName] = useState(workspace.name)
  const [recovery, setRecovery] = useState<RecoveryPrepareResponse | null>(null)

  useEffect(() => { setWorkspaceName(workspace.name) }, [workspace.id, workspace.name])
  useEffect(() => { setName(user.user.displayName) }, [user.user.displayName])

  const showError = useCallback((reason: unknown, fallback: string) => {
    onNotice(reason instanceof ApiError ? reason.message : fallback)
  }, [onNotice])

  const refresh = useCallback(async () => {
    if (!navigator.onLine) {
      setMembers([]); setDevices([]); setInvitations([])
      return
    }
    try {
      const [people, sessions, links] = await Promise.all([
        listMembers(workspace.id),
        listSessions(),
        workspace.role === 'owner' ? listInvitations(workspace.id) : Promise.resolve({ invitations: [] }),
      ])
      setMembers(people.members); setDevices(sessions.sessions); setInvitations(links.invitations)
    } catch (reason) {
      showError(reason, 'Не удалось обновить настройки доступа')
    }
  }, [showError, workspace.id, workspace.role])

  useEffect(() => { void refresh() }, [refresh])

  const invite = async () => {
    try {
      const result = await createInvitation(workspace.id)
      setLink({
        title: 'Приглашение', url: result.url, expiresAt: result.invitation.expiresAt,
        revoke: async () => { await revokeInvitation(workspace.id, result.invitation.id); setLink(null); await refresh() },
      })
      await refresh()
    } catch (reason) { showError(reason, 'Не удалось создать приглашение') }
  }

  const device = async () => {
    try {
      const result = await createDeviceLink()
      setLink({ title: 'Подключить моё устройство', url: result.url, expiresAt: result.deviceLink.expiresAt })
    } catch (reason) { showError(reason, 'Не удалось создать ссылку') }
  }

  const rotateRecovery = async () => {
    if (user.user.recoveryConfigured && !window.confirm('После завершения старая ссылка сразу перестанет работать. Сначала убедитесь, что сможете сохранить новую.')) return
    try { setRecovery(await prepareInitialOrManualRecovery()) }
    catch (reason) { showError(reason, 'Не удалось подготовить восстановление') }
  }

  const completeRotation = async (): Promise<void> => {
    if (!recovery) return
    const outcome = await completeRotationSafely({ prepared: recovery, targetUserId: user.user.id })
    if (outcome.status !== 'completed') {
      if (outcome.status === 'rotation-stale') throw new Error('Параллельно была сохранена другая ссылка. Используйте последнюю подтверждённую ссылку.')
      throw new Error('Не удалось подтвердить замену ссылки. Не удаляйте предыдущую, пока не повторите операцию.')
    }
    await onSession(outcome.session)
  }

  const shareLink = async () => {
    if (!link) return
    if (navigator.share) await navigator.share({ title: link.title, url: link.url })
    else await navigator.clipboard?.writeText(link.url)
  }

  return <>
    <div className="settings-group">
      <h2>Пространство</h2>
      <label>Название<input value={workspaceName} disabled={workspace.role !== 'owner' || !navigator.onLine} onChange={(event) => setWorkspaceName(event.target.value)} onBlur={() => {
        if (workspace.role !== 'owner' || workspaceName === workspace.name) return
        void renameWorkspace(workspace.id, workspaceName, workspace.version).then(async () => onSession(await getSession())).catch((reason) => showError(reason, 'Не удалось переименовать пространство'))
      }}/></label>
      <small>{workspace.role === 'owner' ? 'Вы владелец пространства' : 'Вы участник пространства'}</small>
      <button className="sheet-cancel" disabled={!navigator.onLine} onClick={onCreateWorkspace}>Создать новое пространство</button>
    </div>
    <div className="settings-group">
      <h2>Участники</h2>
      {members.map((member) => <div className="management-row" key={member.userId}>
        <span>{member.displayName}<small>{member.role === 'owner' ? 'Владелец' : 'Участник'}</small></span>
        {workspace.role === 'owner' && !member.isCurrentUser && <span>
          <button onClick={() => {
            if (!window.confirm(`Передать владение ${member.displayName}?`)) return
            void transferOwnership(workspace.id, member.userId, workspace.version).then(async () => onSession(await getSession())).catch((reason) => showError(reason, 'Не удалось передать владение'))
          }}>Передать</button>
          <button onClick={() => {
            if (!window.confirm('Удалить участника? Его серверный доступ прекратится, но уже скачанные офлайн-данные удалённо стереть нельзя.')) return
            void removeMember(workspace.id, member.userId).then(refresh).catch((reason) => showError(reason, 'Не удалось удалить участника'))
          }}>Удалить</button>
        </span>}
      </div>)}
      {workspace.role === 'owner' ? <>
        <button className="sheet-cancel" disabled={!navigator.onLine} onClick={() => void invite()}>Пригласить человека</button>
        {invitations.map((item) => <div className="management-row" key={item.id}><span>Активное приглашение<small>до {new Date(item.expiresAt).toLocaleString('ru-RU')}</small></span><button onClick={() => void revokeInvitation(workspace.id, item.id).then(refresh).catch((reason) => showError(reason, 'Не удалось отозвать приглашение'))}>Отозвать</button></div>)}
      </> : <button className="danger-link" disabled={!navigator.onLine} onClick={() => {
        const warning = pendingCount ? `Есть несинхронизированные изменения: ${pendingCount}. Выйти и удалить их с этого устройства?` : 'Выйти из пространства?'
        if (!window.confirm(warning)) return
        void leaveWorkspace(workspace.id).then(async () => { await clearWorkspaceOfflineData(user.user.id, workspace.id); await onSession(await getSession()) }).catch((reason) => showError(reason, 'Не удалось выйти из пространства'))
      }}>Выйти из пространства</button>}
    </div>
    <div className="settings-group">
      <h2>Доступ</h2>
      <label>Ваше имя<input value={name} disabled={!navigator.onLine} onChange={(event) => setName(event.target.value)} onBlur={() => {
        if (name === user.user.displayName) return
        void updateProfile(name).then(async () => onSession(await getSession())).catch((reason) => showError(reason, 'Не удалось изменить имя'))
      }}/></label>
      <button className="sheet-cancel" disabled={!navigator.onLine} onClick={() => void device()}>Подключить моё устройство</button>
      {devices.map((deviceItem) => <div className="management-row" key={deviceItem.id}>
        <span>{deviceItem.label}<small>{deviceItem.current ? 'Это устройство' : `Активность: ${new Date(deviceItem.lastSeenAt).toLocaleString('ru-RU')}`}</small></span>
        {!deviceItem.current && <button onClick={() => void revokeSession(deviceItem.id).then(refresh).catch((reason) => showError(reason, 'Не удалось отключить сессию'))}>Отключить</button>}
      </div>)}
      {!user.user.recoveryConfigured && <p className="page-intro device-note">Восстановление пока не настроено. Без сохранённой ссылки доступ нельзя будет вернуть после потери всех устройств.</p>}
      <button className="primary" disabled={!navigator.onLine} onClick={() => void rotateRecovery()}>{user.user.recoveryConfigured ? 'Создать новую ссылку восстановления' : 'Настроить восстановление'}</button>
    </div>
    {link && <div className="sheet-backdrop" onMouseDown={() => setLink(null)}><section className="bottom-sheet access-sheet" onMouseDown={(event) => event.stopPropagation()}>
      <div className="sheet-handle"/><h2>{link.title}</h2>
      {link.expiresAt && <p>Действует до {new Date(link.expiresAt).toLocaleString('ru-RU')}</p>}
      <div className="qr"><QRCodeSVG value={link.url} size={180}/></div><code className="access-link">{link.url}</code>
      <button className="primary" onClick={() => void navigator.clipboard?.writeText(link.url)}>Скопировать</button>
      <button className="sheet-cancel" onClick={() => void shareLink()}>Поделиться</button>
      {link.revoke && <button className="danger-link" onClick={() => void link.revoke?.().catch((reason) => showError(reason, 'Не удалось отозвать ссылку'))}>Отозвать</button>}
    </section></div>}
    {recovery && <RecoverySave key={recovery.completionToken} prepared={recovery} mode={user.user.recoveryConfigured ? 'rotation' : 'initial'} close={() => setRecovery(null)} complete={completeRotation}/>}
  </>
}

function SettingsView({ user, workspace, workspaceId, bootstrap, setBootstrap, pendingCount, refreshPending, onLogout, theme, onThemeChange, onSession, onCreateWorkspace }: { user: AuthenticatedSession; workspace:WorkspaceSummary; workspaceId:string; bootstrap:Bootstrap; setBootstrap:React.Dispatch<React.SetStateAction<Bootstrap>>; pendingCount:number; refreshPending:()=>void;onLogout:()=>void;theme:Theme;onThemeChange:(theme:Theme)=>void;onSession:(session:SessionState)=>Promise<void>;onCreateWorkspace:()=>void }) {
  const [editing,setEditing]=useState<Category|null>(null)
  const [adding,setAdding]=useState(false)
  const {toast:notice,notify:setNotice,dismiss:hideNotice}=useToast()
  const colors=['#819978','#d98f70','#d2ad62','#7d9db4','#aa8aaf','#797d72']
  const save=async(category:Category)=>{
    const previous=bootstrap.categories.find((item)=>item.id===category.id)
    const matchesOptimistic=(item:Category)=>item.version===category.version&&item.updatedAt===category.updatedAt&&item.name===category.name&&item.color===category.color&&item.placement===category.placement&&item.sortOrder===category.sortOrder&&item.archivedAt===category.archivedAt
    setBootstrap((b)=>({...b,categories:[category,...b.categories.filter((x)=>x.id!==category.id)]}))
    try{
      const saved=previous?await updateCategory(workspaceId,category.id,category):await createCategory(workspaceId,category)
      setBootstrap((b)=>({...b,categories:b.categories.map((x)=>x.id===category.id&&matchesOptimistic(x)?saved:x)}))
      setEditing(null);setAdding(false);setNotice('Категория сохранена')
    }catch(error){
      setBootstrap((b)=>{
        const optimistic=b.categories.find((x)=>x.id===category.id)
        if(!optimistic||!matchesOptimistic(optimistic))return b
        return{...b,categories:previous?b.categories.map((x)=>x.id===category.id?previous:x):b.categories.filter((x)=>x.id!==category.id)}
      })
      setNotice(error instanceof ApiError?error.message:'Не удалось сохранить категорию')
    }
    refreshPending()
  }
  const move=async(category:Category,direction:-1|1)=>{
    const group=bootstrap.categories.filter((x)=>x.placement===category.placement&&!x.archivedAt).sort((a,b)=>a.sortOrder-b.sortOrder)
    const previousOrder=new Map(group.map((item)=>[item.id,item.sortOrder]))
    const index=group.findIndex((x)=>x.id===category.id),next=index+direction;if(next<0||next>=group.length)return
    ;[group[index],group[next]]=[group[next],group[index]]
    const groupIds=group.map((x)=>x.id),optimisticOrder=new Map(groupIds.map((id,order)=>[id,order]))
    const ids=bootstrap.categories.filter((x)=>!x.archivedAt).sort((a,b)=>a.placement.localeCompare(b.placement)||a.sortOrder-b.sortOrder).map((x)=>x.id)
    const ordered=ids.filter((id)=>!groupIds.includes(id));if(category.placement==='main')ordered.unshift(...groupIds);else ordered.push(...groupIds)
    setBootstrap((b)=>({...b,categories:b.categories.map((x)=>optimisticOrder.has(x.id)?{...x,sortOrder:optimisticOrder.get(x.id)!}:x)}))
    try{
      const result=await reorderCategories(workspaceId,ordered);const fresh=new Map(result.categories.map((x)=>[x.id,x]))
      setBootstrap((b)=>({...b,categories:b.categories.map((x)=>optimisticOrder.get(x.id)===x.sortOrder?(fresh.get(x.id)||x):x)}))
    }catch(error){
      setBootstrap((b)=>({...b,categories:b.categories.map((x)=>optimisticOrder.get(x.id)===x.sortOrder?{...x,sortOrder:previousOrder.get(x.id)!}:x)}))
      setNotice(error instanceof ApiError?error.message:'Не удалось изменить порядок')
    }
    refreshPending()
  }
  const groups:[Category['placement'],string][]=[['main','Основные'],['additional','Дополнительные']]
  return <section className="page"><header className="page-header settings-title"><div><p className="eyebrow">Настройки</p><h1>Пространство</h1></div></header><AccessSettings user={user} workspace={workspace} pendingCount={pendingCount} onSession={onSession} onCreateWorkspace={onCreateWorkspace} onNotice={setNotice}/><p className="page-intro">Настройте быстрые кнопки и их порядок. Категории меняются только онлайн; архивные останутся в истории.</p>{notice&&<Toast toast={notice} onDismiss={hideNotice}/>}
    <div className="settings-group"><button className="primary" disabled={!navigator.onLine} onClick={()=>setAdding(true)}>Новая категория</button></div>
    {groups.map(([placement,title])=><div className="settings-group" key={placement}><h2>{title}</h2>{bootstrap.categories.filter((x)=>x.placement===placement&&!x.archivedAt).sort((a,b)=>a.sortOrder-b.sortOrder).map((category)=><div className="category-row" key={category.id}><i style={{background:category.color ?? '#a9afa5'}}/><button className="category-name" onClick={()=>setEditing(category)}>{category.name}</button><button onClick={()=>move(category,-1)} aria-label="Выше">↑</button><button onClick={()=>move(category,1)} aria-label="Ниже">↓</button></div>)}</div>)}
    {(editing||adding)&&<CategoryEditor category={editing} colors={colors} onClose={()=>{setEditing(null);setAdding(false)}} onSave={save}/>}
    <div className="settings-group"><h2>Это устройство</h2><div className="theme-setting"><div><b>Оформление</b><small>Сохраняется только на этом устройстве</small></div><div className="theme-toggle" role="group" aria-label="Тема оформления"><button type="button" className={theme==='light'?'selected':''} aria-pressed={theme==='light'} onClick={()=>onThemeChange('light')}>Светлая</button><button type="button" className={theme==='dark'?'selected':''} aria-pressed={theme==='dark'} onClick={()=>onThemeChange('dark')}>Тёмная</button></div></div><p className="page-intro device-note">Для работы без интернета расходы и сессия доверенно сохраняются в этом браузере. Не используйте эту функцию на общем устройстве.</p><button className="danger-link" onClick={onLogout}>Выйти и удалить локальные данные</button></div>
  </section>
}

function CategoryEditor({ category, colors, onClose, onSave }:{category:Category|null;colors:string[];onClose:()=>void;onSave:(c:Category)=>void}) {
  const now = new Date().toISOString()
  const [draft,setDraft]=useState<Category>(category||{id:crypto.randomUUID(),name:'',color:colors[0] ?? '#819978',placement:'additional',sortOrder:999,createdAt:now,updatedAt:now,archivedAt:null,version:1})
  return <div className="sheet-backdrop" onMouseDown={onClose}><form className="bottom-sheet editor" onSubmit={(e)=>{e.preventDefault();onSave(draft)}} onMouseDown={(e)=>e.stopPropagation()}><div className="sheet-handle"/><div className="sheet-title"><h2>{category?'Изменить':'Новая категория'}</h2><button type="button" className="icon-button" onClick={onClose}>×</button></div><label>Название<input required autoFocus maxLength={40} value={draft.name} onChange={(e)=>setDraft({...draft,name:e.target.value})}/></label><fieldset><legend>Цвет</legend><div className="colors">{colors.map((color)=><button aria-label={color} type="button" key={color} className={draft.color===color?'selected':''} style={{background:color}} onClick={()=>setDraft({...draft,color})}/>)}</div></fieldset><label>Размещение<select value={draft.placement} onChange={(e)=>setDraft({...draft,placement:e.target.value as Category['placement']})}><option value="main">Основные</option><option value="additional">Дополнительные</option></select></label><button className="primary">Сохранить</button>{category&&<button type="button" className="danger-link" onClick={()=>onSave({...draft,archivedAt:new Date().toISOString()})}>Архивировать</button>}</form></div>
}

const tabs:{id:Tab;label:string;icon:string}[]=[{id:'entry',label:'Расход',icon:'＋'},{id:'history',label:'История',icon:'≡'},{id:'analytics',label:'Аналитика',icon:'⌁'},{id:'settings',label:'Настройки',icon:'⚙'}]

export function CreateWorkspaceSheet({ existing, onClose, onCreate }: { existing: boolean; onClose: () => void; onCreate: (id: string, name: string, displayName?: string) => Promise<void> }) {
  const [name,setName]=useState(''); const [displayName,setDisplayName]=useState(''); const [busy,setBusy]=useState(false)
  const stableId = useRef(crypto.randomUUID())
  return <div className="sheet-backdrop" onMouseDown={onClose}><form className="bottom-sheet editor" onMouseDown={(event)=>event.stopPropagation()} onSubmit={(event)=>{event.preventDefault();setBusy(true);void onCreate(stableId.current,name,existing?undefined:displayName).finally(()=>setBusy(false))}}><div className="sheet-handle"/><h2>Создать пространство</h2>{!existing&&<label>Как вас называть<input required value={displayName} onChange={(event)=>setDisplayName(event.target.value)}/></label>}<label>Название пространства<input required value={name} onChange={(event)=>setName(event.target.value)} autoFocus={existing}/></label><button className="primary" disabled={busy}>{busy?'Создаём…':'Создать пространство'}</button><button type="button" className="sheet-cancel" onClick={onClose}>Отмена</button></form></div>
}

export function WorkspaceSwitcher({ items, active, runtimes, onSelect, onCreate }: { items: WorkspaceSummary[]; active: string; runtimes: Record<string, import('./types').WorkspaceRuntime>; onSelect: (id: string) => void; onCreate: () => void }) {
  return <div className="sheet-backdrop" onMouseDown={()=>onSelect(active)}><section className="bottom-sheet" onMouseDown={(event)=>event.stopPropagation()}><div className="sheet-handle"/><h2>Пространства</h2>{items.map((item)=>{const runtime=runtimes[item.id];const disabled=!navigator.onLine&&!runtime?.bootstrap;return <button className="workspace-option" key={item.id} disabled={disabled} onClick={()=>onSelect(item.id)}><span>{item.name}<small>{item.role==='owner'?'Владелец':'Участник'} {runtime?.outbox.total?`· ${runtime.outbox.total}`:''}</small></span>{item.id===active?'✓':disabled?'Нет офлайн-кэша':''}</button>})}<button className="primary" onClick={onCreate}>Создать пространство</button></section></div>
}

export function RecoverySave({ prepared, complete, close, allowLater = true, mode = 'initial' }: { prepared: RecoveryPrepareResponse; complete: () => Promise<void | boolean>; close: () => void; allowLater?: boolean; mode?: 'initial' | 'rotation' | 'public' }) {
  const [saved,setSaved]=useState(false); const [busy,setBusy]=useState(false); const [completed,setCompleted]=useState(false); const [error,setError]=useState('')
  const finish = async () => {
    setBusy(true); setError('')
    try {
      const done = await complete()
      if (done !== false) setCompleted(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось завершить. Ссылка остаётся на экране — не закрывайте его.')
    } finally { setBusy(false) }
  }
  if (completed) return <div className="sheet-backdrop"><section className="bottom-sheet access-sheet"><div className="sheet-handle"/><h2>{mode === 'public' ? 'Доступ восстановлен' : 'Новая ссылка сохранена'}</h2><p>{mode === 'public' ? 'Старая ссылка больше не работает, все прежние устройства отключены. Убедитесь, что новая ссылка сохранена.' : mode === 'rotation' ? 'Предыдущая ссылка больше не работает. Теперь храните новую ссылку.' : 'Восстановление настроено. Храните эту новую ссылку в безопасном месте.'}</p><button className="primary" onClick={close}>Готово</button></section></div>
  const warning = mode === 'initial'
    ? 'Позже показать эту ссылку снова будет нельзя — можно только заменить новой. Любой, у кого есть ссылка, получит полный доступ ко всем вашим пространствам.'
    : mode === 'public'
      ? 'Сохраните новую ссылку прежде чем продолжить. После завершения старая ссылка перестанет работать, а все прежние устройства будут отключены.'
      : 'После завершения старая ссылка сразу перестанет работать. Любой, у кого есть новая ссылка, получит полный доступ.'
  return <div className="sheet-backdrop"><section className="bottom-sheet access-sheet"><div className="sheet-handle"/><h2>Сохраните ссылку восстановления</h2><p>{warning}</p><p>Подтвердить нужно до {new Date(prepared.expiresAt).toLocaleString('ru-RU')}.</p><div className="qr"><QRCodeSVG value={prepared.recoveryUrl} size={180}/></div><code className="access-link">{prepared.recoveryUrl}</code><button className="sheet-cancel" onClick={()=>void navigator.clipboard?.writeText(prepared.recoveryUrl)}>Скопировать</button>{navigator.share&&<button className="sheet-cancel" onClick={()=>void navigator.share({title:'Ссылка восстановления moapp',url:prepared.recoveryUrl})}>Поделиться</button>}<label className="check-line"><input type="checkbox" checked={saved} onChange={(event)=>setSaved(event.target.checked)}/> Я сохранил ссылку</label>{error&&<p className="form-error" role="alert">{error}</p>}<button className="primary" disabled={!saved||busy} onClick={()=>void finish()}>{busy?'Проверяем…':'Завершить'}</button>{allowLater&&<button className="sheet-cancel" disabled={busy} onClick={close}>Позже</button>}</section></div>
}

function LegacyClaimFlow({ hydrate, cancel }: { hydrate: (session: SessionState) => Promise<void>; cancel: () => void }) {
  const [name,setName]=useState(''); const [pin,setPin]=useState(''); const [busy,setBusy]=useState(false); const [error,setError]=useState(''); const attempt=useRef<string>(generateAttemptToken())
  const claim=async(event: React.FormEvent)=>{event.preventDefault();setBusy(true);setError('');try{await hydrate(await legacyClaim(pin,name,attempt.current))}catch(reason){setError(reason instanceof ApiError&&reason.code==='CLAIM_IN_PROGRESS'?'Перенос уже выполняется в другой вкладке.':'PIN не подошёл или попытка временно ограничена.')}finally{setBusy(false)}}
  return <main className="empty-state"><div className="brand-mark">m</div><p className="eyebrow">Существующие расходы</p><h1>Перенести данные</h1><p>Укажите имя и действующий общий PIN. Затем нужно обязательно настроить восстановление.</p><form onSubmit={claim}><label>Ваше имя<input required value={name} onChange={(event)=>setName(event.target.value)}/></label><label>Общий PIN<input required type="password" value={pin} onChange={(event)=>setPin(event.target.value)}/></label>{error&&<p>{error}</p>}<button className="primary" disabled={busy}>{busy?'Проверяем…':'Продолжить'}</button><button type="button" className="sheet-cancel" disabled={busy} onClick={cancel}>Назад</button></form></main>
}

function RestrictedRecovery({ session, hydrate }: { session: AuthenticatedSession; hydrate: (session: SessionState) => Promise<void> }) {
  const [prepared,setPrepared]=useState<RecoveryPrepareResponse|null>(null); const [publicRecovery,setPublicRecovery]=useState(false); const [error,setError]=useState(''); const started=useRef(false)
  useEffect(()=>{if(started.current)return;started.current=true;void prepareInitialOrManualRecovery().then(setPrepared,(reason)=>setError(reason instanceof ApiError?reason.message:'Не удалось подготовить восстановление'))},[])
  if(prepared)return <RecoverySave key={prepared.completionToken} prepared={prepared} mode={publicRecovery?'public':'initial'} allowLater={false} close={()=>{}} complete={async()=>{
    const outcome=publicRecovery
      ?await completeRecoverySafely({prepared,targetUserId:session.user.id})
      :await completeRotationSafely({prepared,targetUserId:session.user.id})
    if(outcome.status==='completed'){await hydrate(outcome.session);return}
    if(outcome.status==='replacement-active-needs-recovery'){
      setPrepared(await prepareRecovery(outcome.replacementToken));setPublicRecovery(true);return false
    }
    throw new Error(outcome.status==='rotation-stale'?'Параллельно была завершена другая настройка восстановления.':'Не удалось подтвердить сохранение ссылки. Не закрывайте экран и повторите попытку.')
  }}/>
  return <main className="empty-state"><div className="brand-mark">m</div><h1>Защитите профиль</h1><p>{error||'Готовим ссылку восстановления…'}</p></main>
}

export function CapabilityScreen({ intent, session, knownUserId, finish, close, resolveIdentityConflict }: {
  intent: CapabilityIntent
  session: SessionState | null
  knownUserId: string | null
  finish: (session: SessionState, workspaceId?: string, offerRecovery?: boolean) => Promise<void>
  close: () => void
  resolveIdentityConflict: (targetUserId: string | null) => Promise<void>
}) {
  const [copy,setCopy]=useState('Проверяем ссылку…')
  const [name,setName]=useState('')
  const [error,setError]=useState('')
  const [ready,setReady]=useState(false)
  const [busy,setBusy]=useState(false)
  const [conflict,setConflict]=useState(false)
  const [targetUserId,setTargetUserId]=useState<string|null>(null)
  const [workspaceTarget,setWorkspaceTarget]=useState<string|null>(null)
  const [prepared,setPrepared]=useState<RecoveryPrepareResponse|null>(null)
  const attempt=useRef(generateAttemptToken())
  const activeUserId=session?.authenticated?session.user.id:knownUserId
  const sessionKey=session?.authenticated?`${session.user.id}:${session.currentSessionId}`:'guest'

  useEffect(()=>{
    let active=true
    setReady(false);setError('');setConflict(false);setTargetUserId(null);setWorkspaceTarget(null)
    const preview=async()=>{
      try{
        if(intent.kind==='invite'){
          const value=await previewInvitation(intent.token)
          if(!active)return
          setWorkspaceTarget(value.workspace.id);setCopy(`Присоединиться к «${value.workspace.name}»`)
          if(knownUserId&&!session?.authenticated){setConflict(true);setError('В браузере сохранён другой профиль. Сначала восстановите его или явно удалите локальные данные.')}
        }else if(intent.kind==='device'){
          const value=await previewDeviceLink(intent.token)
          if(!active)return
          setTargetUserId(value.targetUserId);setCopy(`Подключить устройство к профилю «${value.displayName}»`)
          if(activeUserId&&activeUserId!==value.targetUserId){setConflict(true);setError('Ссылка относится к другому профилю. Для продолжения нужно выйти и удалить локальные данные текущего профиля.')}
        }else{
          const value=await previewRecovery(intent.token)
          if(!active)return
          setTargetUserId(value.targetUserId);setCopy(`Восстановить профиль «${value.displayName}»`)
          if(activeUserId&&activeUserId!==value.targetUserId){setConflict(true);setError('Ссылка относится к другому профилю. Для продолжения нужно выйти и удалить локальные данные текущего профиля.')}
        }
        if(active)setReady(true)
      }catch(reason){
        if(!active)return
        if(reason instanceof ApiError&&reason.code==='IDENTITY_CONFLICT'){
          setConflict(true);setError('Ссылка относится к другому профилю. Для продолжения нужно подтвердить выход из текущего профиля.')
        }else setError(reason instanceof ApiError&&isLinkInvalid(reason)?'Ссылка недействительна или больше не действует.':'Не удалось проверить ссылку.')
      }
    }
    void preview()
    return()=>{active=false}
  },[activeUserId,intent,knownUserId,session?.authenticated,sessionKey])

  const proceed=async()=>{
    if(!ready||busy||conflict)return
    setBusy(true);setError('')
    try{
      if(intent.kind==='invite'){
        if(!workspaceTarget)throw new Error('Не удалось определить пространство')
        let current=session
        const created=!current?.authenticated
        if(!current?.authenticated)current=await createIdentityWithProbe(name)
        const accepted=await acceptInvitationWithProbe(intent.token,workspaceTarget)
        await finish(accepted,workspaceTarget,created&&!accepted.user.recoveryConfigured)
        return
      }
      if(intent.kind==='device'){
        if(!targetUserId)throw new Error('Не удалось определить профиль')
        await finish(await acceptDeviceWithProbe(intent.token,attempt.current,targetUserId))
        return
      }
      if(!targetUserId)throw new Error('Не удалось определить профиль')
      setPrepared(await prepareRecovery(intent.token))
    }catch(reason){
      if((reason instanceof ApiError&&reason.code==='IDENTITY_CONFLICT')||(reason instanceof AccessFlowError&&reason.code==='IDENTITY_CONFLICT')){
        setConflict(true);setError('Ссылка относится к другому профилю. Для продолжения нужно подтвердить выход из текущего профиля.')
      }else setError(reason instanceof ApiError||reason instanceof Error?reason.message:'Не удалось продолжить')
    }
    finally{setBusy(false)}
  }

  const completePublicRecovery=async():Promise<void|boolean>=>{
    if(!prepared||!targetUserId)return false
    const outcome=await completeRecoverySafely({prepared,targetUserId})
    if(outcome.status==='completed'){await finish(outcome.session);return}
    if(outcome.status==='replacement-active-needs-recovery'){
      const next=await prepareRecovery(outcome.replacementToken)
      setPrepared(next)
      setError('Ответ был потерян. Сохраните показанную заменяющую ссылку и подтвердите её ещё раз.')
      return false
    }
    if(outcome.status==='rotation-stale')throw new Error('Параллельно была завершена другая замена ссылки. Используйте последнюю подтверждённую ссылку.')
    throw new Error('Не удалось подтвердить восстановление. Не удаляйте показанную ссылку и повторите с активного устройства.')
  }

  if(prepared)return <RecoverySave key={prepared.completionToken} prepared={prepared} mode="public" allowLater={false} close={close} complete={completePublicRecovery}/>
  return <main className="empty-state"><div className="brand-mark">m</div><p className="eyebrow">Безопасная ссылка</p><h1>{intent.kind==='invite'?'Приглашение':intent.kind==='device'?'Новое устройство':'Восстановление'}</h1><p>{error||copy}</p>
    {intent.kind==='invite'&&!session?.authenticated&&!conflict&&<label>Как вас называть<input required value={name} onChange={(event)=>setName(event.target.value)}/></label>}
    {conflict?<button className="primary danger" disabled={!navigator.onLine||busy} onClick={()=>{if(!window.confirm('Локальные данные текущего профиля будут удалены с этого устройства. Продолжить?'))return;setBusy(true);void resolveIdentityConflict(targetUserId).catch((reason)=>setError(reason instanceof Error?reason.message:'Не удалось выйти')).finally(()=>setBusy(false))}}>Выйти и продолжить</button>:<button className="primary" disabled={!ready||busy||intent.kind==='invite'&&!session?.authenticated&&!name} onClick={()=>void proceed()}>{busy?'Проверяем…':intent.kind==='invite'?'Присоединиться':intent.kind==='device'?'Подключить':'Восстановить доступ'}</button>}
    <button className="sheet-cancel" disabled={busy} onClick={close}>Закрыть</button>
  </main>
}

export default function App({ capability = null }: { capability?: CapabilityIntent | null }) {
  const [state,setState]=useState(()=>createAppState(capability))
  const [tab,setTab]=useState<Tab>('entry')
  const [currentId,setCurrentId]=useState<string|null>(null)
  const [createOpen,setCreateOpen]=useState(false)
  const [switchOpen,setSwitchOpen]=useState(false)
  const [initialRecovery,setInitialRecovery]=useState<RecoveryPrepareResponse|null>(null)
  const [error,setError]=useState('')
  const [notice,setNotice]=useState('')
  const [theme,setTheme]=useState<Theme>(()=>localStorage.getItem('moapp:theme')==='dark'?'dark':'light')
  const [updateWaiting,setUpdateWaiting]=useState(false)
  const [draftDirty,setDraftDirty]=useState(false)
  const [workspaceReloadEpoch,setWorkspaceReloadEpoch]=useState(0)
  const stateRef=useRef(state); stateRef.current=state
  const capabilityRef=useRef(capability)
  const monitor=useRef<ReturnType<typeof monitorServiceWorkerUpdates> | undefined>(undefined)
  const coordinator=useRef<ReturnType<typeof createIdentityCoordinator> | null>(null)
  const requestAbort=useRef(new AbortController())
  const syncAbort=useRef(new AbortController())
  const sessionAbort=useRef(new AbortController())
  const refreshEpoch=useRef(0)
  const pager=useRef<HTMLElement|null>(null)
  const pagerTimer=useRef<ReturnType<typeof setTimeout>>(undefined)
  const draftDirtyRef=useRef(draftDirty); draftDirtyRef.current=draftDirty
  const requestEpoch=useRef<Record<string,number>>({})

  const updateState=useCallback((updater:(value:AppState)=>AppState)=>{
    setState((value)=>{const next=updater(value);stateRef.current=next;return next})
  },[])
  const commitState=useCallback((next:AppState)=>{stateRef.current=next;setState(next)},[])
  const stopNetwork=useCallback(()=>{
    requestAbort.current.abort();syncAbort.current.abort();sessionAbort.current.abort();refreshEpoch.current+=1
    requestAbort.current=new AbortController();syncAbort.current=new AbortController()
  },[])
  const buildState=useCallback(async(next:SessionState,intent:CapabilityIntent|null=capabilityRef.current)=>{
    if(next.authenticated&&!next.restrictedToRecovery&&next.legacyWorkspaceId)await migrateLegacyOfflineData(next.user.id,next.legacyWorkspaceId)
    return hydrateAppState(next,intent)
  },[])
  const hydrate=useCallback(async(next:SessionState,announce=false)=>{
    const built=await buildState(next)
    commitState(built)
    if(announce&&next.authenticated)coordinator.current?.announce(next.user.id,next.currentSessionId)
  },[buildState,commitState])

  const refresh=useCallback(async(reloadWorkspace=false)=>{
    if(reloadWorkspace){
      requestAbort.current.abort();syncAbort.current.abort()
      syncAbort.current=new AbortController()
    }
    sessionAbort.current.abort()
    const controller=new AbortController();sessionAbort.current=controller
    const epoch=++refreshEpoch.current
    const current=()=>!controller.signal.aborted&&refreshEpoch.current===epoch
    const settled=await settlePendingLogout(navigator.onLine,controller.signal)
    if(!current())return
    if(!settled){
      const locked=createAppState(capabilityRef.current);locked.phase=capabilityRef.current?'capability':'known-user-locked'
      commitState(locked);setError('Подключитесь к интернету, чтобы безопасно завершить выход.')
      return
    }
    try{
      setError('')
      const next=await getSession(controller.signal)
      if(!current())return
      const built=await buildState(next)
      if(!current())return
      commitState(built)
      if(reloadWorkspace)setWorkspaceReloadEpoch((value)=>value+1)
    }
    catch{
      if(!current())return
      const currentState=stateRef.current;const known=currentState.knownUserId
      if(known){
        const profile=await readCachedProfile(known)
        if(!current())return
        const candidate=profile?.session
        if(candidate?.authenticated&&Date.parse(candidate.currentSessionExpiresAt)>Date.now()){
          const offline=await buildState(candidate)
          if(!current())return
          if(Object.values(offline.runtimes).some((runtime)=>runtime.bootstrap)){
            const activeWorkspaceId=chooseCachedWorkspace(known,candidate.workspaces,offline.runtimes)
            commitState({...offline,activeWorkspaceId,runtimes:Object.fromEntries(Object.entries(offline.runtimes).map(([id,runtime])=>[id,{...runtime,offline:Boolean(runtime.bootstrap)}]))})
            return
          }
        }
        const locked=createAppState(capabilityRef.current);locked.knownUserId=known;locked.phase=capabilityRef.current?'capability':'known-user-locked';commitState(locked)
        setError('Нет подключения: локальная сессия недоступна, истекла или ещё не содержит сохранённого пространства.')
        return
      }
      const guest=createAppState(capabilityRef.current);guest.session=currentState.session?.authenticated?null:currentState.session;guest.phase=capabilityRef.current?'capability':'guest';commitState(guest)
      setError('Нет подключения к серверу.')
    }
  },[buildState,commitState])

  useEffect(()=>{void refresh()},[refresh])
  useEffect(()=>{
    const item=createIdentityCoordinator({
      refresh,
      abortNetwork:()=>requestAbort.current.abort(),
      stopSync:()=>{syncAbort.current.abort();syncAbort.current=new AbortController()},
      onForeignIdentity:()=>{const locked=createAppState(capabilityRef.current);locked.knownUserId=stateRef.current.knownUserId;commitState(locked)},
    })
    coordinator.current=item
    return()=>{coordinator.current=null;item.dispose()}
  },[commitState,refresh])
  useEffect(()=>{
    const item=monitorServiceWorkerUpdates({
      onWaiting:()=>setUpdateWaiting(true),
      onControllerChange:()=>void waitForWorkspaceOfflineWrites().then(()=>{if(draftDirtyRef.current){setUpdateWaiting(true);return}window.location.reload()}),
    })
    monitor.current=item;void item.checkForUpdate()
    return()=>item.dispose()
  },[])
  useEffect(()=>{document.documentElement.dataset.theme=theme;localStorage.setItem('moapp:theme',theme)},[theme])
  useEffect(()=>{pager.current?.scrollTo({left:tabs.findIndex((item)=>item.id===tab)*pager.current.clientWidth,behavior:'smooth'})},[tab])
  useEffect(()=>()=>clearTimeout(pagerTimer.current),[])

  const session=state.session
  const auth=session?.authenticated?session:null
  const workspaceId=state.activeWorkspaceId
  const workspacesKey=auth?.workspaces.map((workspace)=>`${workspace.id}:${workspace.version}`).join('|')??''

  const refreshWorkspaceStats=useCallback(async(userId:string,id:string)=>{
    const stats=await outboxStats(userId,id)
    updateState((value)=>{
      if(!value.session?.authenticated||value.session.user.id!==userId||!value.runtimes[id])return value
      return updateWorkspace(value,id,(runtime)=>({...runtime,outbox:stats}))
    })
  },[updateState])

  useEffect(()=>{
    if(!auth||!workspaceId)return
    requestAbort.current.abort();const controller=new AbortController();requestAbort.current=controller
    const id=workspaceId,userId=auth.user.id,sessionId=auth.currentSessionId,workspaces=auth.workspaces
    const epoch=(requestEpoch.current[id]??0)+1;requestEpoch.current[id]=epoch
    updateState((value)=>value.runtimes[id]?updateWorkspace(value,id,(runtime)=>({...runtime,status:'loading',requestEpoch:epoch})):value)
    void getBootstrap(id,controller.signal).then((value)=>{
      if(controller.signal.aborted)return
      updateState((current)=>{
        if(!current.session?.authenticated||current.session.user.id!==userId||current.session.currentSessionId!==sessionId||!current.runtimes[id]||current.runtimes[id].requestEpoch!==epoch)return current
        return updateWorkspace(current,id,(runtime)=>({...runtime,bootstrap:value.data,source:value.offline?'cache':'network',offline:value.offline,status:'ready'}))
      })
      void syncAllWorkspaces(userId,workspaces,id,syncAbort.current.signal,(syncedId)=>void refreshWorkspaceStats(userId,syncedId)).catch((reason)=>{
        if(reason instanceof DOMException&&reason.name==='AbortError')return
        if(reason instanceof ApiError&&(reason.status===401||reason.code==='SESSION_CONTEXT_CHANGED'))void refresh()
      })
    }).catch(async(reason)=>{
      if(reason instanceof DOMException&&reason.name==='AbortError')return
      if(reason instanceof ApiError&&reason.code==='WORKSPACE_NOT_FOUND'){
        const base=stateRef.current;const next=await applyMembershipLoss(base,id)
        if(stateRef.current.session?.authenticated&&stateRef.current.session.user.id===userId)commitState(next)
        return
      }
      if(reason instanceof ApiError&&(reason.status===401||reason.code==='SESSION_CONTEXT_CHANGED')){void refresh();return}
      updateState((value)=>value.runtimes[id]?updateWorkspace(value,id,(runtime)=>({...runtime,status:runtime.bootstrap?'ready':'error'})):value)
      setError(reason instanceof ApiError?reason.message:'Не удалось загрузить пространство')
    })
    return()=>controller.abort()
  },[auth?.currentSessionId,auth?.user.id,commitState,refresh,refreshWorkspaceStats,updateState,workspaceId,workspaceReloadEpoch,workspacesKey])

  const setWorkspaceData=useMemo<React.Dispatch<React.SetStateAction<Bootstrap>>>(()=>{
    const expectedWorkspaceId=workspaceId
    const expectedUserId=auth?.user.id
    return(action)=>{
      if(!expectedWorkspaceId||!expectedUserId)return
      updateState((value)=>{
        const runtime=value.runtimes[expectedWorkspaceId]
        if(!runtime?.bootstrap||!value.session?.authenticated||value.session.user.id!==expectedUserId||!value.session.workspaces.some((workspace)=>workspace.id===expectedWorkspaceId))return value
        const next=typeof action==='function'?(action as (previous:Bootstrap)=>Bootstrap)(runtime.bootstrap):action
        if(next.workspaceId!==expectedWorkspaceId)return value
        void cacheBootstrap(expectedUserId,expectedWorkspaceId,next)
        return updateWorkspace(value,expectedWorkspaceId,(current)=>({...current,bootstrap:next}))
      })
    }
  },[auth?.user.id,updateState,workspaceId])

  const refreshPending=useCallback(()=>{
    const current=stateRef.current
    if(!current.session?.authenticated||!current.activeWorkspaceId)return
    void refreshWorkspaceStats(current.session.user.id,current.activeWorkspaceId)
  },[refreshWorkspaceStats])

  const create=async(id:string,name:string,displayName?:string)=>{
    setError('')
    let createdIdentity=false
    try{
      let current=stateRef.current.session
      if(!current?.authenticated){if(!displayName)return;current=await createIdentityWithProbe(displayName);createdIdentity=true}
      await createWorkspaceWithProbe(id,name)
      const next=await getSession()
      if(!next.authenticated)throw new Error('Сервер не подтвердил созданное пространство')
      let built=await buildState(next,null);built=setActiveWorkspace(built,id);capabilityRef.current=null;commitState(built)
      setCreateOpen(false);setSwitchOpen(false);setCurrentId(null);setTab('entry')
      setNotice(`Пространство «${name.trim()}» создано`)
      if(createdIdentity)coordinator.current?.announce(next.user.id,next.currentSessionId)
      if(!next.user.recoveryConfigured){
        try{setInitialRecovery(await prepareInitialOrManualRecovery())}
        catch(reason){setError(`Пространство создано, но восстановление пока не настроено: ${reason instanceof ApiError?reason.message:'повторите в настройках'}`)}
      }
    }catch(reason){setError(reason instanceof ApiError||reason instanceof Error?reason.message:'Не удалось создать пространство')}
  }

  const closeIntent=()=>{capabilityRef.current=null;updateState(closeCapability)}
  const finishIntent=async(next:SessionState,targetWorkspaceId?:string,offerRecovery=false)=>{
    const finishedKind=capabilityRef.current?.kind
    capabilityRef.current=null
    let built=await buildState(next,null)
    if(targetWorkspaceId)built=setActiveWorkspace(built,targetWorkspaceId)
    commitState(built)
    if(next.authenticated)coordinator.current?.announce(next.user.id,next.currentSessionId)
    if(finishedKind==='recovery')setNotice('Доступ восстановлен. Старая ссылка больше не работает, все прежние устройства отключены. Храните новую ссылку.')
    if(offerRecovery&&next.authenticated&&!next.user.recoveryConfigured){
      try{setInitialRecovery(await prepareInitialOrManualRecovery())}
      catch(reason){setError(reason instanceof ApiError?reason.message:'Настройте восстановление позже в настройках')}
    }
  }

  const resolveIdentityConflict=async(targetUserId:string|null)=>{
    if(!navigator.onLine)throw new Error('Для безопасного выхода нужно подключение к интернету')
    stopNetwork();const current=stateRef.current
    const preserveKnown=Boolean(targetUserId&&current.knownUserId===targetUserId)
    if(current.conflictingSession)await logoutExpected(current.conflictingSession.userId,current.conflictingSession.sessionId)
    if(current.session?.authenticated){
      const pending=beginLogout(current)
      const locked=createAppState(capabilityRef.current);locked.phase='capability';commitState(locked)
      await pending
      if(!await settlePendingLogout(true))throw new Error('Не удалось завершить выход')
    }else if(current.knownUserId&&!preserveKnown){
      const pending=forgetKnownProfile(true,current.session)
      const locked=createAppState(capabilityRef.current);locked.phase='capability';commitState(locked)
      if(!await pending)throw new Error('Не удалось удалить локальный профиль')
    }
    coordinator.current?.announce(null,null)
    await hydrate(await getSession())
  }

  const logoutCurrent=async()=>{
    const current=stateRef.current
    if(!current.session?.authenticated)return
    if(!window.confirm('Выйти и удалить локальные данные этого профиля с устройства?'))return
    stopNetwork();const pending=beginLogout(current);capabilityRef.current=null;commitState(createLoggedOutState());coordinator.current?.announce(null,null)
    await pending
    if(navigator.onLine)await settlePendingLogout(true)
    await refresh()
  }

  const forgetCurrent=async()=>{
    if(!window.confirm('Удалить локальный профиль, офлайн-кэш и несинхронизированные изменения с этого устройства?'))return
    const current=stateRef.current;stopNetwork();const pending=forgetKnownProfile(navigator.onLine,current.session);capabilityRef.current=null;commitState(createLoggedOutState());coordinator.current?.announce(null,null)
    await pending;await refresh()
  }

  const logoutUnexpected=async()=>{
    const unexpected=stateRef.current.conflictingSession
    if(!unexpected)return
    await logoutExpected(unexpected.userId,unexpected.sessionId)
    await refresh()
  }

  const confirmDraftDiscard=()=>!draftDirty||window.confirm('Отбросить несохранённый расход и продолжить?')
  const openCreate=()=>{if(confirmDraftDiscard()){setSwitchOpen(false);setCreateOpen(true)}}
  const switchWorkspace=(id:string)=>{
    if(id!==stateRef.current.activeWorkspaceId&&!confirmDraftDiscard())return
    if(id!==stateRef.current.activeWorkspaceId){updateState((value)=>setActiveWorkspace(value,id));setCurrentId(null);setDraftDirty(false);setTab('entry')}
    setSwitchOpen(false)
  }
  const activateUpdate=()=>{if(draftDirty){setError('Сначала сохраните или очистите черновик расхода.');return}monitor.current?.activateWaiting()}
  const onPagerScroll=()=>{
    clearTimeout(pagerTimer.current)
    pagerTimer.current=setTimeout(()=>{const node=pager.current;if(!node?.clientWidth)return;const item=tabs[Math.max(0,Math.min(tabs.length-1,Math.round(node.scrollLeft/node.clientWidth)))];if(item)setTab(item.id)},90)
  }

  if(state.phase==='checking')return <div className="splash"><div className="brand-mark">m</div>{error&&<p>{error}</p>}</div>
  if(state.capability)return <CapabilityScreen intent={state.capability} session={session} knownUserId={state.knownUserId} finish={finishIntent} close={closeIntent} resolveIdentityConflict={resolveIdentityConflict}/>
  if(state.phase==='legacy-claim')return <LegacyClaimFlow hydrate={(next)=>hydrate(next,true)} cancel={()=>updateState((value)=>({...value,phase:'guest'}))}/>
  if(state.phase==='restricted-recovery'&&auth)return <RestrictedRecovery session={auth} hydrate={async(next)=>{await hydrate(next,true);setNotice('Перенос завершён. Новая ссылка восстановления сохранена, старый PIN больше не используется.')}}/>
  if(state.phase==='guest'||state.phase==='no-workspaces'||state.phase==='known-user-locked')return <main className="empty-state"><div className="brand-mark">m</div><p className="eyebrow">Общие расходы</p><h1>{state.phase==='known-user-locked'?'Нужно восстановить доступ':'Простой общий учёт расходов'}</h1><p>{state.phase==='known-user-locked'?'Локальные данные защищены. Откройте сохранённую ссылку восстановления или явно удалите профиль с этого устройства.':'Без регистрации, email и пароля.'}</p>{state.phase==='known-user-locked'?<>{state.conflictingSession&&<button className="primary" disabled={!navigator.onLine} onClick={()=>void logoutUnexpected().catch((reason)=>setError(reason instanceof Error?reason.message:'Не удалось выйти'))}>Выйти из другого профиля</button>}<button className="danger-link" onClick={()=>void forgetCurrent()}>Забыть локальный профиль</button></>:<><button className="primary" disabled={!navigator.onLine} onClick={()=>setCreateOpen(true)}>Создать пространство</button>{state.phase==='guest'&&session&&!session.authenticated&&session.legacyClaimAvailable&&<button className="sheet-cancel" onClick={()=>updateState(openLegacyClaim)}>Продолжить с существующими расходами</button>}</>}{createOpen&&<CreateWorkspaceSheet existing={Boolean(auth)} onClose={()=>setCreateOpen(false)} onCreate={create}/>} {error&&<p className="form-error">{error}</p>}</main>

  const runtime=workspaceId?state.runtimes[workspaceId]:undefined
  const bootstrap=runtime?.bootstrap
  const workspace=auth&&workspaceId?auth.workspaces.find((item)=>item.id===workspaceId):undefined
  if(!auth||!workspaceId||!workspace||!bootstrap)return <div className="splash"><div className="brand-mark">m</div><p>{runtime?.status==='error'?'Не удалось открыть пространство':'Загружаем пространство…'}</p>{error&&<button className="sheet-cancel" onClick={()=>void refresh(true)}>{error} · Повторить</button>}</div>
  const stats=runtime.outbox
  return <div className="app-shell" key={workspaceId}>
    <header className="workspace-header"><button onClick={()=>setSwitchOpen(true)}>{workspace.name}⌄</button>{updateWaiting&&<button onClick={activateUpdate}>Обновить</button>}</header>
    <div className={`sync-status${stats.conflicts||stats.failed?' attention':''}`}><span>{navigator.onLine?stats.conflicts||stats.failed?`Нужна проверка · ${stats.conflicts+stats.failed}`:`Синхронизация · ${stats.total}`:'Офлайн'}</span><i/></div>
    <main className="pager" ref={pager} onScroll={onPagerScroll}>
      <div className="page-slot"><EntryView userId={auth.user.id} workspaceId={workspaceId} bootstrap={bootstrap} setBootstrap={setWorkspaceData} currentId={currentId} setCurrentId={setCurrentId} refreshPending={refreshPending} onDraftDirtyChange={setDraftDirty}/></div>
      <div className="page-slot"><HistoryView userId={auth.user.id} workspaceId={workspaceId} bootstrap={bootstrap} setBootstrap={setWorkspaceData} edit={(id)=>{setCurrentId(id);setTab('entry')}} refreshPending={refreshPending}/></div>
      <div className="page-slot"><AnalyticsView userId={auth.user.id} workspaceId={workspaceId} bootstrap={bootstrap} theme={theme}/></div>
      <div className="page-slot"><SettingsView user={auth} workspace={workspace} workspaceId={workspaceId} bootstrap={bootstrap} setBootstrap={setWorkspaceData} pendingCount={stats.total} refreshPending={refreshPending} onLogout={()=>void logoutCurrent()} theme={theme} onThemeChange={setTheme} onSession={hydrate} onCreateWorkspace={openCreate}/></div>
    </main>
    <nav className="bottom-nav">{tabs.map((item)=><button key={item.id} className={tab===item.id?'active':''} onClick={()=>setTab(item.id)}><span>{item.icon}</span><small>{item.label}</small></button>)}</nav>
    {switchOpen&&<WorkspaceSwitcher items={auth.workspaces} active={workspaceId} runtimes={state.runtimes} onSelect={switchWorkspace} onCreate={openCreate}/>}
    {createOpen&&<CreateWorkspaceSheet existing onClose={()=>setCreateOpen(false)} onCreate={create}/>}
    {initialRecovery&&<RecoverySave key={initialRecovery.completionToken} prepared={initialRecovery} mode="initial" close={()=>setInitialRecovery(null)} complete={async()=>{
      const outcome=await completeRotationSafely({prepared:initialRecovery,targetUserId:auth.user.id})
      if(outcome.status!=='completed')throw new Error(outcome.status==='rotation-stale'?'Параллельно была завершена другая настройка восстановления.':'Не удалось подтвердить настройку. Повторите из настроек.')
      await hydrate(outcome.session,true)
    }}/>}
    {error&&<button className="toast toast-error" onClick={()=>setError('')}>{error}</button>}
    {notice&&<button className="toast" onClick={()=>setNotice('')}>{notice}</button>}
  </div>
}
