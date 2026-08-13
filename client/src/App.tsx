import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import {
  WorkspaceApiError as ApiError, allowWorkspaceMutations, blockWorkspaceMutations, createCategory, discardOutboxIssues, getAnalytics, getBootstrap,
  createDeviceLink, createInvitation, getSession, isLinkInvalid, legacyClaim, leaveWorkspace, listInvitations, listMembers, listSessions, logoutExpected, prepareInitialOrManualRecovery,
  prepareRecovery, previewDeviceLink, previewInvitation, previewRecovery, removeMember, renameWorkspace, reorderCategories, revokeInvitation, revokeSession, submitExpenseOperation,
  setSessionContext, submitExpenseOperations, syncAllWorkspaces, transferOwnership, updateCategory, updateProfile,
} from './workspace-api'
import { cacheBootstrap, clearWorkspaceOfflineData, migrateLegacyOfflineData, outboxStats, readCachedProfile, readOutbox, waitForWorkspaceOfflineWrites } from './workspace-offline'
import { applyMembershipLoss, beginLogout, chooseCachedWorkspace, closeCapability, createAppState, createIdentityCoordinator, createLoggedOutState, forgetKnownProfile, getWorkspacePreference, hydrateAppState, openLegacyClaim, setActiveWorkspace, setWorkspacePreference, settlePendingLogout, updateWorkspace } from './app-state'
import type { AppState } from './app-state'
import { AccessFlowError, acceptDeviceWithProbe, acceptInvitationWithProbe, createIdentityWithProbe, createWorkspaceWithProbe, generateAttemptToken } from './access-flow'
import { completeRecoverySafely, completeRotationSafely } from './recovery-flow'
import { monitorServiceWorkerUpdates } from './service-worker-update'
import type { AnalyticsData, AuthenticatedSession, CapabilityIntent, Category, Currency, Expense, RecoveryPrepareResponse, SessionState, WorkspaceBootstrap, WorkspaceOutboxItem, WorkspaceSummary } from './types'
import { amountToMinor, applyKeypad, convertExpense, countCalendarWeekdays, isoToLocalInput, localDateKey, localInputToIso, monthDateRange, shiftDateKey, swipeDirection, weekdayFromDateKey, weekDateRange } from './utils'

const AnalyticsChart = lazy(() => import('./AnalyticsCharts'))

export type Tab = 'entry' | 'history' | 'analytics' | 'settings'
type Theme = 'light' | 'dark'
type AnalyticsPeriod = 'week' | 'month'
const CHART_COLOR = '#758d69'
const EMPTY_FORM = { amount: '', currency: 'RSD', note: '', occurredAt: '' }

const SWIPE_START = 14
const SWIPE_COMMIT = 64
type Bootstrap = WorkspaceBootstrap

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
type BackgroundLock = { count: number; inert: boolean; ariaHidden: string | null }
const backgroundLocks = new Map<HTMLElement, BackgroundLock>()

function lockDialogBackground(node: HTMLElement) {
  const existing = backgroundLocks.get(node)
  if (existing) { existing.count += 1; return }
  backgroundLocks.set(node, { count: 1, inert: node.inert, ariaHidden: node.getAttribute('aria-hidden') })
  node.inert = true
  node.setAttribute('aria-hidden', 'true')
}

function unlockDialogBackground(node: HTMLElement) {
  const lock = backgroundLocks.get(node)
  if (!lock) return
  lock.count -= 1
  if (lock.count > 0) return
  node.inert = lock.inert
  if (lock.ariaHidden === null) node.removeAttribute('aria-hidden')
  else node.setAttribute('aria-hidden', lock.ariaHidden)
  backgroundLocks.delete(node)
}

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

function useOnlineStatus() {
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  return online
}

function useDialog(onClose: () => void, dismissible = true, instanceKey: unknown = null) {
  const ref = useRef<HTMLElement>(null)
  const closeRef = useRef(onClose)
  const dismissibleRef = useRef(dismissible)
  closeRef.current = onClose
  dismissibleRef.current = dismissible
  useEffect(() => {
    const dialog = ref.current
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!dialog) return
    const background: HTMLElement[] = []
    const root = document.getElementById('root')
    let branch: HTMLElement | null = dialog
    while (branch && branch !== root) {
      const parent: HTMLElement | null = branch.parentElement
      if (!parent) break
      for (const sibling of Array.from(parent.children)) {
        if (!(sibling instanceof HTMLElement) || sibling === branch) continue
        background.push(sibling)
        lockDialogBackground(sibling)
      }
      branch = parent
    }
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((node) => !node.hidden && node.getAttribute('aria-hidden') !== 'true' && !(node instanceof HTMLButtonElement && node.disabled))
    const preferred = dialog.querySelector<HTMLElement>('[data-dialog-initial-focus]')
    const initial = preferred && focusable().includes(preferred) ? preferred : focusable()[0]
    requestAnimationFrame(() => initial?.focus({ preventScroll: true }))
    const keydown = (event: KeyboardEvent) => {
      const openDialogs = Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]'))
      if (openDialogs.at(-1) !== dialog) return
      if (event.key === 'Escape' && dismissibleRef.current) {
        event.preventDefault()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusable()
      if (!items.length) { event.preventDefault(); dialog.focus(); return }
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault(); last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus()
      }
    }
    document.addEventListener('keydown', keydown)
    return () => {
      document.removeEventListener('keydown', keydown)
      for (const node of background) unlockDialogBackground(node)
      requestAnimationFrame(() => returnFocus?.isConnected && returnFocus.focus({ preventScroll: true }))
    }
  }, [instanceKey])
  return ref
}

type ConfirmOptions = { title: string; message: string; confirmLabel: string; danger?: boolean }

function ConfirmSheet({ options, onResult }: { options: ConfirmOptions; onResult: (confirmed: boolean) => void }) {
  const dialogRef = useDialog(() => onResult(false))
  return <div className="sheet-backdrop" onMouseDown={() => onResult(false)}>
    <section ref={dialogRef} className="bottom-sheet confirm-sheet" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message" onMouseDown={(event) => event.stopPropagation()}>
      <div className="sheet-handle"/>
      <h2 id="confirm-title">{options.title}</h2>
      <p id="confirm-message">{options.message}</p>
      <button type="button" className={`primary${options.danger ? ' danger' : ''}`} onClick={() => onResult(true)}>{options.confirmLabel}</button>
      <button type="button" className="sheet-cancel" data-dialog-initial-focus onClick={() => onResult(false)}>Отмена</button>
    </section>
  </div>
}

function useConfirm() {
  const [request, setRequest] = useState<(ConfirmOptions & { resolve: (confirmed: boolean) => void }) | null>(null)
  const pending = useRef<((confirmed: boolean) => void) | null>(null)
  useEffect(() => () => pending.current?.(false), [])
  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => {
    pending.current?.(false)
    pending.current = resolve
    setRequest({ ...options, resolve })
  }), [])
  const settle = useCallback((confirmed: boolean) => {
    const current = pending.current
    pending.current = null
    setRequest(null)
    current?.(confirmed)
  }, [])
  const confirmation = request ? <ConfirmSheet options={request} onResult={settle}/> : null
  return { confirm, confirmation }
}

async function copyText(value: string) {
  if (!navigator.clipboard?.writeText) throw new Error('Копирование недоступно. Выделите ссылку вручную.')
  await navigator.clipboard.writeText(value)
}

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
  const amountSize = face.amount.replace(/\D/g, '').length > 10 ? 'long' : face.amount.replace(/\D/g, '').length > 7 ? 'medium' : 'normal'
  return <>
    <header className="topline">
      <div>
        <p className="eyebrow">{face.title}</p>
        <button type="button" className="date-chip" onClick={onDate} tabIndex={inert}>{face.date}<span>⌄</span></button>
      </div>
    </header>
    <div className="amount-row">
      <output className={`amount-value${face.amount ? '' : ' empty'}`} data-size={amountSize} aria-label="Сумма">{face.amount || '0'}</output>
      <button type="button" onClick={onCurrency} tabIndex={inert}>{face.currency}<span>⌄</span></button>
    </div>
  </>
}

const TrashIcon = () => <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>

function styleDeleteButton(node: HTMLButtonElement | null, presence: number, duration: number) {
  if (!node) return
  if (prefersReducedMotion()) duration = 0
  const easing = 'cubic-bezier(.25,.8,.3,1)'
  node.style.transition = duration ? `opacity ${duration}ms ${easing}, transform ${duration}ms ${easing}` : 'none'
  node.style.opacity = String(presence)
  node.style.transform = `scale(${0.82 + presence * 0.18})`
}

type ToastState = { text: string; urgent?: boolean; action?: { label: string; run: () => void } }

export function useToast(timeout = 2600) {
  const [toast, setToast] = useState<ToastState | null>(null)
  useEffect(() => {
    if (!toast) return
    // Тост с действием живёт дольше: на «Вернуть» нужно успеть среагировать.
    const timer = setTimeout(() => setToast(null), toast.action || toast.urgent ? 5600 : timeout)
    return () => clearTimeout(timer)
  }, [toast, timeout])
  const notify = useCallback((text: string, action?: ToastState['action'], urgent = false) => setToast({ text, action, urgent }), [])
  const dismiss = useCallback(() => setToast(null), [])
  return { toast, notify, dismiss }
}

function Toast({ toast, onDismiss }: { toast: ToastState; onDismiss: () => void }) {
  const action = toast.action
  if (!action) return <div className="toast toast-message" role={toast.urgent ? 'alert' : 'status'} aria-live={toast.urgent ? 'assertive' : 'polite'}><span>{toast.text}</span><button type="button" onClick={onDismiss} aria-label="Закрыть уведомление">×</button></div>
  return <div className="toast toast-undo" role="status" aria-live="polite"><span>{toast.text}</span><button type="button" onClick={() => { onDismiss(); action.run() }}>{action.label}</button></div>
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
  const dialogRef = useDialog(onClose)
  const pinned = ['RSD', 'EUR', 'USD', 'RUB']
  const filtered = currencies.filter((currency) => `${currency.code} ${currency.name}`.toLowerCase().includes(query.toLowerCase()))
  return <div className="sheet-backdrop" onMouseDown={onClose}>
    <section ref={dialogRef} className="bottom-sheet tall" role="dialog" aria-modal="true" aria-labelledby="currency-title" onMouseDown={(e) => e.stopPropagation()}>
      <div className="sheet-handle"/><div className="sheet-title"><h2 id="currency-title">Валюта</h2><button type="button" className="icon-button" data-dialog-initial-focus onClick={onClose} aria-label="Закрыть">×</button></div>
      <input className="search" type="search" placeholder="Код или название" aria-label="Поиск валюты" value={query} onChange={(e) => setQuery(e.target.value)} />
      {!query && <div className="currency-pins">{pinned.filter((code) => currencies.some((c) => c.code === code)).map((code) => <button type="button" key={code} aria-pressed={selected === code} className={selected === code ? 'selected' : ''} onClick={() => onSelect(code)}>{code}</button>)}</div>}
      <div className="currency-list">{filtered.map((currency) => <button type="button" key={currency.code} aria-pressed={selected === currency.code} onClick={() => onSelect(currency.code)}><span><b>{currency.code}</b><small>{currency.name}</small></span><span>{currency.symbol}</span></button>)}</div>
      {!filtered.length && <p className="sheet-empty" role="status">По запросу «{query}» валют не найдено.</p>}
    </section>
  </div>
}

function DateSheet({ value, onClose, onPick }: { value: string; onClose: () => void; onPick: (value: string) => void }) {
  const now = () => isoToLocalInput(new Date().toISOString())
  const [draft, setDraft] = useState(value || now())
  const [validation, setValidation] = useState('')
  const dialogRef = useDialog(onClose)
  const shift = (days: number) => {
    const date = new Date()
    date.setDate(date.getDate() - days)
    setDraft(isoToLocalInput(date.toISOString()))
  }
  return <div className="sheet-backdrop" onMouseDown={onClose}>
    <form ref={dialogRef as React.Ref<HTMLFormElement>} className="bottom-sheet editor" role="dialog" aria-modal="true" aria-labelledby="date-title" noValidate onSubmit={(event) => { event.preventDefault(); if (!draft) { setValidation('Выберите дату и время.'); return } onPick(draft) }} onMouseDown={(event) => event.stopPropagation()}>
      <div className="sheet-handle"/>
      <div className="sheet-title"><h2 id="date-title">Когда</h2><button type="button" className="icon-button" data-dialog-initial-focus onClick={onClose} aria-label="Закрыть">×</button></div>
      <div className="date-presets"><button type="button" onClick={() => shift(0)}>Сейчас</button><button type="button" onClick={() => shift(1)}>Вчера</button><button type="button" onClick={() => shift(2)}>Позавчера</button></div>
      <label>Дата и время<input type="datetime-local" aria-invalid={Boolean(validation)} value={draft} onChange={(event) => { setValidation(''); setDraft(event.target.value) }}/></label>
      {validation && <p className="form-error" role="alert">{validation}</p>}
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
  const dialogRef = useDialog(onClose)
  return <div className="sheet-backdrop" onMouseDown={onClose}><section ref={dialogRef} className="bottom-sheet" role="dialog" aria-modal="true" aria-labelledby="category-sheet-title" onMouseDown={(e) => e.stopPropagation()}>
    <div className="sheet-handle"/><div className="sheet-title"><h2 id="category-sheet-title">Другое</h2><button type="button" className="icon-button" data-dialog-initial-focus onClick={onClose} aria-label="Закрыть">×</button></div>
    <div className="category-grid">{categories.map((category) => <button type="button" key={category.id} aria-pressed={category.id === selectedId} className={category.id === selectedId ? 'selected' : undefined} onClick={() => onPick(category)}><i style={{ backgroundColor: category.color ?? '#a9afa5' }}/><span>{category.name}</span></button>)}</div>
    {!categories.length && <p className="sheet-empty" role="status">Дополнительных категорий пока нет. Их можно добавить в настройках.</p>}
  </section></div>
}

export function EntryView({ userId, workspaceId, bootstrap, setBootstrap, currentId, setCurrentId, refreshPending, onDraftDirtyChange, active }: {
  userId: string
  workspaceId: string
  bootstrap: Bootstrap; setBootstrap: React.Dispatch<React.SetStateAction<Bootstrap>>; currentId: string | null; setCurrentId: (id: string | null) => void; refreshPending: () => void; onDraftDirtyChange: (dirty: boolean) => void; active: boolean
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
      notify(result?.status === 'conflict' ? 'Изменение конфликтует с сервером. Откройте «Нужна проверка» вверху.' : current ? 'Изменения сохранены' : 'Расход добавлен')
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
      notify(error instanceof ApiError ? error.message : 'Не удалось сохранить', undefined, true)
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
      notify(result?.status === 'conflict' ? 'Возврат конфликтует с сервером. Откройте «Нужна проверка» вверху.' : 'Расход возвращён')
    } catch (error) {
      setBootstrap((data) => ({ ...data, expenses: data.expenses.map((item) => item.id === deleted.id && item.version === restored.version && item.updatedAt === restored.updatedAt ? deleted : item) }))
      notify(error instanceof ApiError ? error.message : 'Не удалось вернуть расход', undefined, true)
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
      if (result?.status === 'conflict') notify('Удаление конфликтует с сервером. Откройте «Нужна проверка» вверху.')
      else notify('Расход удалён', { label: 'Вернуть', run: () => void restore(stored) })
    } catch (error) {
      setBootstrap((data) => ({ ...data, expenses: data.expenses.map((item) => item.id === target.id && item.version === target.version && item.deletedAt === deletedAt ? target : item) }))
      setCurrentId(target.id)
      notify(error instanceof ApiError ? error.message : 'Не удалось удалить', undefined, true)
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
    else slide(0, prefersReducedMotion() ? 0 : 220)
    return true
  }

  const swipeCancelAt = () => {
    const start = swipe.current
    swipe.current = null
    if (!start?.active) return
    // pointercancel/touchcancel means the browser interrupted the gesture
    // (for example for system navigation), so it must never commit a move.
    slide(0, prefersReducedMotion() ? 0 : 220)
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
  const physicalKey = (event: KeyboardEvent) => {
    if(event.metaKey||event.ctrlKey||event.altKey)return
    if(document.querySelector('[aria-modal="true"]'))return
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return
    const value = /^\d$/.test(event.key) ? event.key : event.key === 'Backspace' ? '⌫' : event.key === '.' || event.key === ',' ? ',' : null
    if (!value) return
    event.preventDefault()
    key(value)
  }
  useEffect(()=>{
    if(!active)return
    const handle=(event:KeyboardEvent)=>physicalKey(event)
    window.addEventListener('keydown',handle)
    return()=>window.removeEventListener('keydown',handle)
  },[active,physicalKey])
  return <section ref={entryRef} className={`entry-view${current ? ' editing' : ''}`} aria-label="Ввод суммы" onPointerDown={swipeStart} onPointerMove={swipeMove} onPointerUpCapture={swipeEnd} onPointerCancel={swipeCancel}>
    <div className="swipe-area">
      <div className="entry-track" ref={trackRef}>
        {olderFace && <div className="entry-card aside older" aria-hidden="true"><EntryCard face={olderFace}/></div>}
        <div className="entry-card"><EntryCard face={liveFace} onDate={() => setDateSheet(true)} onCurrency={() => setCurrencySheet(true)}/></div>
        {newerFace && <div className="entry-card aside newer" aria-hidden="true"><EntryCard face={newerFace}/></div>}
      </div>
    </div>
    <button ref={deleteRef} type="button" className={`icon-danger entry-delete${current ? '' : ' off'}`} onClick={remove} tabIndex={current ? 0 : -1} aria-hidden={!current} aria-label="Удалить расход"><TrashIcon/></button>
    <Keypad onKey={key}/>
    <div className={`categories${ready ? '' : ' locked'}${dirty ? ' unsaved' : ''}`}><p>{categoryHint}</p><div className="main-categories">{main.map((category) => <button type="button" disabled={!ready || saving} aria-pressed={category.id === current?.categoryId} key={category.id} className={category.id === current?.categoryId ? 'selected' : undefined} onClick={() => chooseCategory(category)}><i style={{backgroundColor:category.color ?? '#a9afa5'}}/><span>{category.name}</span></button>)}<button type="button" disabled={!ready || saving} aria-pressed={Boolean(otherFace)} className={otherFace ? 'selected' : undefined} onClick={() => setCategorySheet(true)}>{otherFace ? <i style={{backgroundColor:otherFace.color ?? '#a9afa5'}}/> : <i className="dots">•••</i>}<span>{otherFace ? otherFace.name : 'Другое'}</span></button></div></div>
    <div className="note-block">{!showNote ? <button type="button" className="text-button" onClick={() => setShowNote(true)}>{form.note ? `✎ ${form.note}` : '＋ Добавить заметку'}</button> : <label>Заметка <span>необязательно</span><input autoFocus maxLength={200} placeholder="Например, IKEA" value={form.note} onFocus={(event) => { const node = event.currentTarget; requestAnimationFrame(() => node.scrollIntoView({ block: 'center' })) }} onChange={(e) => setForm({...form,note:e.target.value})}/></label>}</div>
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
  return <section className="page"><header className="page-header history-title"><div><p className="eyebrow">Все записи</p><h1>История</h1></div><button type="button" className={`icon-danger history-delete${selected.size ? '' : ' off'}`} onClick={removeSelected} disabled={deleting} tabIndex={selected.size ? 0 : -1} aria-hidden={!selected.size} aria-label={`Удалить выбранные расходы: ${selected.size}`}><TrashIcon/></button></header><input className="search" type="search" placeholder="Категория или валюта" value={query} onChange={(e) => setQuery(e.target.value)}/>
    <div className="history-list">{groups.map(([date, items]) => <div key={date} className="history-day"><div className="history-date"><span>{new Date(`${date}T12:00:00Z`).toLocaleDateString('ru-RU',{timeZone:'Europe/Belgrade',day:'numeric',month:'long'})}</span><b>{items?.length}</b></div>{items?.map((expense) => { const category=categoryMap.get(expense.categoryId); const checked=selected.has(expense.id); return <div key={expense.id} className={`history-expense${checked ? ' selected' : ''}`}><label className="expense-check" aria-label={`Выбрать расход ${category?.name || ''}`}><input type="checkbox" checked={checked} onChange={()=>toggle(expense.id)}/><span/></label><button type="button" className="history-row" onClick={() => edit(expense.id)}><i style={{backgroundColor:category?.color ?? '#a9afa5'}}/><span><b>{category?.name || 'Архивная категория'}</b><small>{new Date(expense.occurredAt).toLocaleTimeString('ru-RU',{timeZone:'Europe/Belgrade',hour:'2-digit',minute:'2-digit'})}{expense.note ? ` · ${expense.note}`:''}</small></span><strong>{money(expense.amountMinor,expense.currency,bootstrap.currencies)}</strong>{expense.pending && <em aria-label="Ожидает синхронизации">●</em>}</button></div>})}</div>)}</div>
    {!groups.length && <div className="list-empty" role="status"><span>{query ? 'Ничего не найдено' : 'История пока пуста'}</span><p>{query ? 'Попробуйте изменить запрос.' : 'Сохранённые расходы появятся здесь.'}</p></div>}
    {toast&&<Toast toast={toast} onDismiss={dismiss}/>}
  </section>
}

function AnalyticsView({ userId, workspaceId, bootstrap, theme, online }: { userId: string; workspaceId: string; bootstrap: Bootstrap; theme: Theme; online: boolean }) {
  const [target, setTarget] = useState(getWorkspacePreference(userId, workspaceId, 'analytics-currency') || 'RSD')
  const [period, setPeriod] = useState<AnalyticsPeriod>('week')
  const [weekOffset, setWeekOffset] = useState(0)
  const [monthOffset, setMonthOffset] = useState(0)
  const [categoryByPeriod, setCategoryByPeriod] = useState<Record<AnalyticsPeriod,string|null>>({week:'products',month:null})
  const [currencySheet, setCurrencySheet] = useState(false)
  const [remote,setRemote]=useState<{key:string;data:AnalyticsData;previousTotalMinor:number|null}|null>(null)
  const [analyticsOffline,setAnalyticsOffline]=useState(!online)
  const [analyticsLoading,setAnalyticsLoading]=useState(online)
  const [analyticsError,setAnalyticsError]=useState<string|null>(null)
  const [retryEpoch,setRetryEpoch]=useState(0)
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
  useEffect(()=>{let active=true;const controller=new AbortController();setAnalyticsError(null);if(!online){setAnalyticsOffline(true);setAnalyticsLoading(false);setRemote(null);return()=>controller.abort()}setAnalyticsLoading(true);Promise.all([getAnalytics(workspaceId,from,analyticsTo,target,categoryId??undefined,controller.signal),period==='week'?getAnalytics(workspaceId,previousWeek.from,previousAnalyticsTo,target,categoryId??undefined,controller.signal):Promise.resolve(null)]).then(([result,previous])=>{if(active){setRemote({key:requestKey,data:result,previousTotalMinor:previous?.totalMinor??null});setAnalyticsOffline(false);setAnalyticsLoading(false)}}).catch((reason)=>{if(active&&!controller.signal.aborted){setRemote(null);setAnalyticsOffline(false);setAnalyticsError(reason instanceof ApiError?reason.message:'Не удалось обновить аналитику');setAnalyticsLoading(false)}});return()=>{active=false;controller.abort()}},[workspaceId,from,analyticsTo,target,categoryId,period,previousWeek.from,previousAnalyticsTo,requestKey,online,retryEpoch])
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
  const chartGrid=theme==='dark'?'rgba(255,255,255,.06)':'rgba(32,37,31,.06)'
  return <section className="page analytics"><header className="page-header analytics-title"><div><p className="eyebrow">{period==='week'?'Расходы за неделю':'Расходы за месяц'} · {selectedCategoryName}</p><h1>{new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}).format(total)} <small>{target}</small></h1>{period==='week'&&<p className="analytics-comparison">{weekComparisonLabel(total,previousTotal,currentWeekPartial)}</p>}</div><button className="currency-choice" onClick={()=>setCurrencySheet(true)}>{target}⌄</button></header>
    <div className="analytics-period" role="group" aria-label="Период аналитики"><button type="button" aria-pressed={period==='week'} className={period==='week'?'selected':''} onClick={()=>setPeriod('week')}>Неделя</button><button type="button" aria-pressed={period==='month'} className={period==='month'?'selected':''} onClick={()=>setPeriod('month')}>Месяц</button></div>
    <label className="analytics-category"><span>Категория</span><select aria-label="Категория расходов" value={categoryId??''} onChange={(event)=>setCategoryByPeriod((current)=>({...current,[period]:event.target.value||null}))}><option value="">Все категории</option>{activeCategories.map((category)=><option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
    {period==='week'&&<div className="week-navigator"><button type="button" onClick={()=>setWeekOffset((value)=>value-1)} aria-label="Предыдущая неделя">‹</button><div><b>{weekOffset===0?'Текущая неделя':weekOffset===-1?'Прошлая неделя':'Выбранная неделя'}</b><span>{weekRange}</span></div><button type="button" onClick={()=>setWeekOffset((value)=>Math.min(0,value+1))} disabled={weekOffset===0} aria-label="Следующая неделя">›</button></div>}
    {period==='month'&&<div className="week-navigator"><button type="button" onClick={()=>setMonthOffset((value)=>value-1)} aria-label="Предыдущий месяц">‹</button><div><b>{monthOffset===0?'Текущий месяц':monthOffset===-1?'Прошлый месяц':'Выбранный месяц'}</b><span>{monthLabel}</span></div><button type="button" onClick={()=>setMonthOffset((value)=>Math.min(0,value+1))} disabled={monthOffset===0} aria-label="Следующий месяц">›</button></div>}
    <div className="analytics-stats"><div><span>Среднее в день</span><strong>{formatAnalyticsAmount(total/elapsedDays,target)}</strong></div><div><span>Операций</span><strong>{data.expenseCount}</strong></div></div>
    <div className={`rate-caption${analyticsError?' error':''}`} role={analyticsError?'alert':'status'}>{analyticsLoading?'Обновляем аналитику…':analyticsError?<>{analyticsError} <button type="button" onClick={()=>setRetryEpoch((value)=>value+1)}>Повторить</button></>:analyticsOffline?'Офлайн-оценка по последнему сохранённому курсу':data.rateDate?`Исторические курсы с ${new Date(`${data.rateDate}T12:00:00Z`).toLocaleDateString('ru-RU')}`:'Курсы обновляются'}{data.missingCurrencies.length?` · без ${data.missingCurrencies.join(', ')}`:''}</div>
    <div className="chart-card"><div><h2>Динамика</h2><p>{period==='week'?'Понедельник — воскресенье':'По дням выбранного месяца'}</p></div>{data.convertedCount?<div className="line-chart"><Suspense fallback={<ChartSkeleton/>}><AnalyticsChart kind="line" labels={days.map((d)=>new Date(`${d}T12:00`).toLocaleDateString('ru-RU',period==='week'?{weekday:'short'}:{day:'numeric',month:'short'}))} values={byDay} color={chartColor} fillColor={theme==='dark'?'rgba(154,181,142,.16)':'rgba(117,141,105,.12)'} pointRadius={period==='week'?3:0} target={target} textColor={chartText} gridColor={chartGrid} maxTicksLimit={period==='week'?7:6}/></Suspense></div>:<AnalyticsEmpty>{data.expenseCount?'Нет курса для выбранной валюты':'В этом периоде ещё нет расходов'}</AnalyticsEmpty>}</div>
    <div className={`chart-card${byCategory.length?' split':''}`}><div><h2>Категории</h2><p>{period==='week'?'За выбранную неделю':'За выбранный месяц'}</p></div>{byCategory.length?<><div className="donut-wrap"><Suspense fallback={<ChartSkeleton/>}><AnalyticsChart kind="doughnut" labels={byCategory.map((x)=>x.name)} values={byCategory.map((x)=>x.value)} colors={byCategory.map((x)=>x.color||'#a9afa5')} target={target}/></Suspense><span>{formatCompactNumber(total)}</span></div><div className="legend">{byCategory.slice(0,5).map((x)=><div key={x.categoryId}><i style={{background:x.color||'#a9afa5'}}/><span>{x.name}</span><span className="legend-value"><b>{formatAnalyticsAmount(x.value,target)}</b><small>{Math.round(x.value/total*100)||0}%</small></span></div>)}{byCategory.length>5&&<div className="legend-rest"><i/><span>Остальные</span><span className="legend-value"><b>{formatAnalyticsAmount(byCategory.slice(5).reduce((sum,item)=>sum+item.value,0),target)}</b><small>{byCategory.length-5}</small></span></div>}</div></>:<AnalyticsEmpty>Категории появятся после первого расхода</AnalyticsEmpty>}</div>
    {period==='month'&&<div className="chart-card"><div><h2>По дням недели</h2><p>Средние траты за календарный день</p></div>{data.convertedCount?<div className="bar-chart"><Suspense fallback={<ChartSkeleton/>}><AnalyticsChart kind="bar" labels={['Пн','Вт','Ср','Чт','Пт','Сб','Вс']} values={weekdays} color={chartColor} target={target} textColor={chartText} gridColor={chartGrid}/></Suspense></div>:<AnalyticsEmpty>Недостаточно данных для сравнения</AnalyticsEmpty>}</div>}
    {currencySheet && <CurrencySheet currencies={bootstrap.currencies} selected={target} onClose={()=>setCurrencySheet(false)} onSelect={(code)=>{setTarget(code);setWorkspacePreference(userId, workspaceId, 'analytics-currency', code);setCurrencySheet(false)}}/>}
  </section>
}

function AnalyticsEmpty({children}:{children:string}) {
  return <div className="analytics-empty"><span>⌁</span><p>{children}</p></div>
}

function ChartSkeleton() {
  return <div className="chart-skeleton" role="status" aria-label="Загружаем график"><i/><i/><i/><i/><i/></div>
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

export function fallbackAnalytics(bootstrap:Bootstrap,target:string,from:string,to:string,categoryId:string|null):AnalyticsData {
  const decimals=bootstrap.currencies.find((currency)=>currency.code===target)?.decimals??2
  const categories=new Map(bootstrap.categories.map((category)=>[category.id,category]))
  const periodExpenses=bootstrap.expenses.filter((expense)=>!expense.deletedAt&&(!categoryId||expense.categoryId===categoryId)).map((expense)=>({expense,date:localDateKey(expense.occurredAt)})).filter((item)=>item.date>=from&&item.date<=to)
  const canConvert=(expense:Expense)=>expense.currency===target||Boolean(bootstrap.rates.ratesToRsd[expense.currency]??(expense.currency==='RSD'?1:0))&&Boolean(bootstrap.rates.ratesToRsd[target]??(target==='RSD'?1:0))
  const missingCurrencies=[...new Set(periodExpenses.filter(({expense})=>!canConvert(expense)).map(({expense})=>expense.currency))]
  const expenses=periodExpenses.filter(({expense})=>canConvert(expense)).map(({expense,date})=>({expense,date,amountMinor:Math.round(convertExpense(expense,target,bootstrap.currencies,bootstrap.rates)*10**decimals)}))
  const sum=(items:typeof expenses)=>items.reduce((total,item)=>total+item.amountMinor,0)
  const dates=[...new Set(expenses.map((item)=>item.date))]
  return {currency:target,from,to,totalMinor:sum(expenses),expenseCount:periodExpenses.length,convertedCount:expenses.length,rateDate:bootstrap.rates.date,missingCurrencies,daily:dates.map((date)=>{const items=expenses.filter((item)=>item.date===date);return{date,amountMinor:sum(items),count:items.length}}),categories:[...categories.values()].map((category)=>{const items=expenses.filter((item)=>item.expense.categoryId===category.id);return{categoryId:category.id,name:category.name,color:category.color,amountMinor:sum(items),count:items.length}}),weekdays:Array.from({length:7},(_,weekday)=>{const items=expenses.filter((item)=>(weekdayFromDateKey(item.date)+1)%7===weekday);return{weekday,amountMinor:sum(items),count:items.length}}),calendar:dates.map((date)=>{const items=expenses.filter((item)=>item.date===date);return{date,amountMinor:sum(items),count:items.length}})}
}

function formatWeekRange(from:string,to:string) {
  const start=new Date(`${from}T12:00:00Z`),end=new Date(`${to}T12:00:00Z`)
  const sameMonth=start.getUTCFullYear()===end.getUTCFullYear()&&start.getUTCMonth()===end.getUTCMonth()
  const startLabel=start.toLocaleDateString('ru-RU',{timeZone:'UTC',day:'numeric',...(sameMonth?{}:{month:'short'})}).replace('.','')
  const endLabel=end.toLocaleDateString('ru-RU',{timeZone:'UTC',day:'numeric',month:sameMonth?'long':'short'}).replace('.','')
  return `${startLabel}–${endLabel}`
}

function AccessLinkSheet({ link, onClose, onRevoke }: { link: { title: string; url: string; expiresAt?: string; revoke?: () => Promise<void> }; onClose: () => void; onRevoke: (reason: unknown) => void }) {
  const dialogRef = useDialog(onClose)
  const [feedback, setFeedback] = useState('')
  const [feedbackError, setFeedbackError] = useState(false)
  const [busy, setBusy] = useState(false)
  const copy = async () => {
    try { await copyText(link.url); setFeedbackError(false); setFeedback('Ссылка скопирована') }
    catch (reason) { setFeedbackError(true); setFeedback(reason instanceof Error ? reason.message : 'Не удалось скопировать ссылку') }
  }
  const share = async () => {
    try {
      if (typeof navigator.share === 'function') { await navigator.share({ title: link.title, url: link.url }); setFeedbackError(false); setFeedback('Меню «Поделиться» открыто') }
      else await copy()
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') return
      setFeedbackError(true); setFeedback('Не удалось поделиться ссылкой')
    }
  }
  const revoke = async () => {
    if (!link.revoke || busy) return
    setBusy(true)
    try { await link.revoke() }
    catch (reason) { onRevoke(reason); setBusy(false) }
  }
  return <div className="sheet-backdrop" onMouseDown={onClose}><section ref={dialogRef} className="bottom-sheet access-sheet" role="dialog" aria-modal="true" aria-labelledby="access-link-title" onMouseDown={(event) => event.stopPropagation()}>
    <div className="sheet-handle"/><div className="sheet-title"><h2 id="access-link-title">{link.title}</h2><button type="button" className="icon-button" data-dialog-initial-focus onClick={onClose} aria-label="Закрыть">×</button></div>
    {link.expiresAt && <p>Действует до {new Date(link.expiresAt).toLocaleString('ru-RU')}</p>}
    <div className="qr"><QRCodeSVG value={link.url} size={180}/></div><code className="access-link">{link.url}</code>
    {feedback && <p className="inline-feedback" role={feedbackError ? 'alert' : 'status'}>{feedback}</p>}
    <button type="button" className="primary" onClick={() => void copy()}>Скопировать</button>
    <button type="button" className="sheet-cancel" onClick={() => void share()}>Поделиться</button>
    {link.revoke && <button type="button" className="danger-link" disabled={busy} onClick={() => void revoke()}>{busy ? 'Отзываем…' : 'Отозвать'}</button>}
  </section></div>
}

function AccessSettings({ user, workspace, pendingCount, online, onSession, onCreateWorkspace, onNotice, onBusyChange }: {
  user: AuthenticatedSession
  workspace: WorkspaceSummary
  pendingCount: number
  online: boolean
  onSession: (session: SessionState) => Promise<void>
  onCreateWorkspace: () => void
  onNotice: (message: string, urgent?: boolean) => void
  onBusyChange: (busy: boolean) => void
}) {
  const [members, setMembers] = useState<import('./types').Participant[]>([])
  const [devices, setDevices] = useState<import('./types').DeviceSession[]>([])
  const [invitations, setInvitations] = useState<import('./types').InvitationMetadata[]>([])
  const [link, setLink] = useState<{ title: string; url: string; expiresAt?: string; revoke?: () => Promise<void> } | null>(null)
  const [name, setName] = useState(user.user.displayName)
  const [workspaceName, setWorkspaceName] = useState(workspace.name)
  const [recovery, setRecovery] = useState<RecoveryPrepareResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const { confirm, confirmation } = useConfirm()

  useEffect(() => { setWorkspaceName(workspace.name) }, [workspace.id, workspace.name])
  useEffect(() => { setName(user.user.displayName) }, [user.user.displayName])
  useEffect(() => {
    onBusyChange(Boolean(busyAction))
    return () => onBusyChange(false)
  }, [busyAction, onBusyChange])

  const showError = useCallback((reason: unknown, fallback: string) => {
    onNotice(reason instanceof ApiError || reason instanceof Error ? reason.message : fallback, true)
  }, [onNotice])

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!online) {
      setLoading(false)
      setLoadError('Данные доступа обновятся после подключения к интернету.')
      return
    }
    setLoading(true); setLoadError('')
    try {
      const [people, sessions, links] = await Promise.all([
        listMembers(workspace.id, signal),
        listSessions(signal),
        workspace.role === 'owner' ? listInvitations(workspace.id, signal) : Promise.resolve({ invitations: [] }),
      ])
      if (signal?.aborted) return
      setMembers(people.members); setDevices(sessions.sessions); setInvitations(links.invitations)
      setLoading(false)
    } catch (reason) {
      if (signal?.aborted) return
      setLoading(false); setLoadError('Не удалось обновить данные доступа.')
      showError(reason, 'Не удалось обновить настройки доступа')
    }
  }, [online, showError, workspace.id, workspace.role])

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [refresh])

  const invite = async () => {
    if (busyAction) return
    setBusyAction('invite')
    try {
      const result = await createInvitation(workspace.id)
      setLink({
        title: 'Приглашение', url: result.url, expiresAt: result.invitation.expiresAt,
        revoke: async () => { await revokeInvitation(workspace.id, result.invitation.id); setLink(null); await refresh() },
      })
      await refresh()
    } catch (reason) { showError(reason, 'Не удалось создать приглашение') }
    finally { setBusyAction(null) }
  }

  const device = async () => {
    if (busyAction) return
    setBusyAction('device')
    try {
      const result = await createDeviceLink()
      setLink({ title: 'Подключить моё устройство', url: result.url, expiresAt: result.deviceLink.expiresAt })
    } catch (reason) { showError(reason, 'Не удалось создать ссылку') }
    finally { setBusyAction(null) }
  }

  const rotateRecovery = async () => {
    if (user.user.recoveryConfigured && !await confirm({ title: 'Заменить ссылку восстановления?', message: 'После завершения старая ссылка сразу перестанет работать. Сначала убедитесь, что сможете сохранить новую.', confirmLabel: 'Создать новую ссылку', danger: true })) return
    setBusyAction('recovery')
    try { setRecovery(await prepareInitialOrManualRecovery()) }
    catch (reason) { showError(reason, 'Не удалось подготовить восстановление') }
    finally { setBusyAction(null) }
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

  const runAction = async (key: string, action: () => Promise<void>, fallback: string, success?: string) => {
    if (busyAction) return
    setBusyAction(key)
    try { await action(); if (success) onNotice(success) }
    catch (reason) { showError(reason, fallback) }
    finally { setBusyAction(null) }
  }

  const saveWorkspaceName = async () => {
    const trimmed = workspaceName.trim()
    if (workspace.role !== 'owner' || trimmed === workspace.name) return
    if (!trimmed) { setWorkspaceName(workspace.name); onNotice('Название пространства не может быть пустым.', true); return }
    await runAction('workspace-name', async () => {
      await renameWorkspace(workspace.id, trimmed, workspace.version)
      await onSession(await getSession())
    }, 'Не удалось переименовать пространство', 'Название пространства сохранено')
  }

  const saveDisplayName = async () => {
    const trimmed = name.trim()
    if (trimmed === user.user.displayName) return
    if (!trimmed) { setName(user.user.displayName); onNotice('Имя не может быть пустым.', true); return }
    await runAction('display-name', async () => {
      await updateProfile(trimmed)
      await onSession(await getSession())
    }, 'Не удалось изменить имя', 'Имя сохранено')
  }

  return <>
    <div className="settings-group">
      <h2>Пространство</h2>
      <label>Название<input value={workspaceName} maxLength={80} disabled={workspace.role !== 'owner' || !online || busyAction === 'workspace-name'} aria-busy={busyAction === 'workspace-name'} onChange={(event) => setWorkspaceName(event.target.value)} onBlur={() => void saveWorkspaceName()}/></label>
      <small>{workspace.role === 'owner' ? 'Вы владелец пространства' : 'Вы участник пространства'}</small>
      <button type="button" className="sheet-cancel" disabled={!online || Boolean(busyAction)} onClick={onCreateWorkspace}>Создать новое пространство</button>
    </div>
    <div className="settings-group">
      <h2>Участники</h2>
      {loading && <p className="management-state" role="status">Загружаем участников…</p>}
      {loadError && <p className="management-state" role="status">{loadError}</p>}
      {!loading && !loadError && !members.length && <p className="management-state" role="status">Участников пока нет.</p>}
      {members.map((member) => <div className="management-row" key={member.userId}>
        <span>{member.displayName}<small>{member.role === 'owner' ? 'Владелец' : 'Участник'}</small></span>
        {workspace.role === 'owner' && !member.isCurrentUser && <span>
          <button type="button" disabled={!online || Boolean(busyAction)} onClick={() => void (async () => {
            if (!await confirm({ title: 'Передать владение?', message: `${member.displayName} станет владельцем пространства, а вы — участником.`, confirmLabel: 'Передать', danger: true })) return
            await runAction(`transfer-${member.userId}`, async () => { await transferOwnership(workspace.id, member.userId, workspace.version); await onSession(await getSession()) }, 'Не удалось передать владение', 'Владение передано')
          })()}>Передать</button>
          <button type="button" disabled={!online || Boolean(busyAction)} onClick={() => void (async () => {
            if (!await confirm({ title: 'Удалить участника?', message: 'Серверный доступ прекратится, но уже скачанные на его устройства офлайн-данные удалённо стереть нельзя.', confirmLabel: 'Удалить', danger: true })) return
            await runAction(`remove-${member.userId}`, async () => { await removeMember(workspace.id, member.userId); await refresh() }, 'Не удалось удалить участника', 'Участник удалён')
          })()}>Удалить</button>
        </span>}
      </div>)}
      {workspace.role === 'owner' ? <>
        <button type="button" className="sheet-cancel" disabled={!online || Boolean(busyAction)} onClick={() => void invite()}>{busyAction === 'invite' ? 'Создаём приглашение…' : 'Пригласить человека'}</button>
        {!loading && !loadError && !invitations.length && <p className="management-state" role="status">Активных приглашений нет.</p>}
        {invitations.map((item) => <div className="management-row" key={item.id}><span>Активное приглашение<small>до {new Date(item.expiresAt).toLocaleString('ru-RU')}</small></span><button type="button" disabled={!online || Boolean(busyAction)} onClick={() => void runAction(`invite-${item.id}`, async () => { await revokeInvitation(workspace.id, item.id); await refresh() }, 'Не удалось отозвать приглашение', 'Приглашение отозвано')}>Отозвать</button></div>)}
      </> : <button type="button" className="danger-link" disabled={!online || Boolean(busyAction)} onClick={() => {
        const warning = pendingCount ? `Есть несинхронизированные изменения: ${pendingCount}. Выйти и удалить их с этого устройства?` : 'Выйти из пространства?'
        void (async () => {
          if (!await confirm({ title: 'Выйти из пространства?', message: warning, confirmLabel: 'Выйти', danger: true })) return
          await runAction('leave', async () => { await leaveWorkspace(workspace.id); await clearWorkspaceOfflineData(user.user.id, workspace.id); await onSession(await getSession()) }, 'Не удалось выйти из пространства')
        })()
      }}>Выйти из пространства</button>}
    </div>
    <div className="settings-group">
      <h2>Доступ</h2>
      <label>Ваше имя<input value={name} maxLength={80} disabled={!online || busyAction === 'display-name'} aria-busy={busyAction === 'display-name'} onChange={(event) => setName(event.target.value)} onBlur={() => void saveDisplayName()}/></label>
      <button type="button" className="sheet-cancel" disabled={!online || Boolean(busyAction)} onClick={() => void device()}>{busyAction === 'device' ? 'Готовим ссылку…' : 'Подключить моё устройство'}</button>
      {loading && <p className="management-state" role="status">Загружаем устройства…</p>}
      {!loading && !loadError && !devices.length && <p className="management-state" role="status">Подключённых устройств пока нет.</p>}
      {devices.map((deviceItem) => <div className="management-row" key={deviceItem.id}>
        <span>{deviceItem.label}<small>{deviceItem.current ? 'Это устройство' : `Активность: ${new Date(deviceItem.lastSeenAt).toLocaleString('ru-RU')}`}</small></span>
        {!deviceItem.current && <button type="button" disabled={!online || Boolean(busyAction)} onClick={() => void runAction(`device-${deviceItem.id}`, async () => { await revokeSession(deviceItem.id); await refresh() }, 'Не удалось отключить сессию', 'Устройство отключено')}>Отключить</button>}
      </div>)}
      {!user.user.recoveryConfigured && <p className="page-intro device-note">Восстановление пока не настроено. Без сохранённой ссылки доступ нельзя будет вернуть после потери всех устройств.</p>}
      <button type="button" className="primary" disabled={!online || Boolean(busyAction)} onClick={() => void rotateRecovery()}>{busyAction === 'recovery' ? 'Готовим ссылку…' : user.user.recoveryConfigured ? 'Создать новую ссылку восстановления' : 'Настроить восстановление'}</button>
    </div>
    {link && <AccessLinkSheet link={link} onClose={() => setLink(null)} onRevoke={(reason) => showError(reason, 'Не удалось отозвать ссылку')}/>}
    {recovery && <RecoverySave key={recovery.completionToken} prepared={recovery} mode={user.user.recoveryConfigured ? 'rotation' : 'initial'} close={() => setRecovery(null)} complete={completeRotation}/>}
    {confirmation}
  </>
}

export function SettingsView({ user, workspace, workspaceId, bootstrap, setBootstrap, pendingCount, refreshPending, onLogout, theme, onThemeChange, onSession, onCreateWorkspace, online }: { user: AuthenticatedSession; workspace:WorkspaceSummary; workspaceId:string; bootstrap:Bootstrap; setBootstrap:React.Dispatch<React.SetStateAction<Bootstrap>>; pendingCount:number; refreshPending:()=>void;onLogout:()=>void;theme:Theme;onThemeChange:(theme:Theme)=>void;onSession:(session:SessionState)=>Promise<void>;onCreateWorkspace:()=>void;online:boolean }) {
  const [editing,setEditing]=useState<Category|null>(null)
  const [adding,setAdding]=useState(false)
  const [moving,setMoving]=useState<string|null>(null)
  const [accessBusy,setAccessBusy]=useState(false)
  const {toast:notice,notify:setNotice,dismiss:hideNotice}=useToast()
  const accessNotice=useCallback((message:string,urgent=false)=>setNotice(message,undefined,urgent),[setNotice])
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
      setNotice(error instanceof ApiError?error.message:'Не удалось сохранить категорию',undefined,true)
    }
    refreshPending()
  }
  const move=async(category:Category,direction:-1|1)=>{
    if(!online||moving)return
    setMoving(category.id)
    const group=bootstrap.categories.filter((x)=>x.placement===category.placement&&!x.archivedAt).sort((a,b)=>a.sortOrder-b.sortOrder)
    const previousOrder=new Map(group.map((item)=>[item.id,item.sortOrder]))
    const index=group.findIndex((x)=>x.id===category.id),next=index+direction;if(next<0||next>=group.length){setMoving(null);return}
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
      setNotice(error instanceof ApiError?error.message:'Не удалось изменить порядок',undefined,true)
    }
    refreshPending()
    setMoving(null)
  }
  const groups:[Category['placement'],string][]=[['main','Основные'],['additional','Дополнительные']]
  return <section className="page"><header className="page-header settings-title"><div><p className="eyebrow">Настройки</p><h1>Пространство</h1></div></header><AccessSettings user={user} workspace={workspace} pendingCount={pendingCount} online={online} onSession={onSession} onCreateWorkspace={onCreateWorkspace} onNotice={accessNotice} onBusyChange={setAccessBusy}/><p className="page-intro">Настройте быстрые кнопки и их порядок. Категории меняются только онлайн; архивные останутся в истории.</p>
    {notice&&<Toast toast={notice} onDismiss={hideNotice}/>}<div className="settings-group"><button type="button" className="primary" disabled={!online} onClick={()=>setAdding(true)}>Новая категория</button></div>
    {groups.map(([placement,title])=>{const items=bootstrap.categories.filter((x)=>x.placement===placement&&!x.archivedAt).sort((a,b)=>a.sortOrder-b.sortOrder);return <div className="settings-group" key={placement}><h2>{title}</h2>{items.map((category,index)=><div className="category-row" key={category.id}><i style={{background:category.color ?? '#a9afa5'}}/><button type="button" className="category-name" disabled={!online||Boolean(moving)} onClick={()=>setEditing(category)}>{category.name}</button><button type="button" disabled={!online||Boolean(moving)||index===0} onClick={()=>void move(category,-1)} aria-label={`Поднять категорию ${category.name}`}>↑</button><button type="button" disabled={!online||Boolean(moving)||index===items.length-1} onClick={()=>void move(category,1)} aria-label={`Опустить категорию ${category.name}`}>↓</button></div>)}{!items.length&&<p className="management-state" role="status">Категорий в этом разделе пока нет.</p>}</div>})}
    {(editing||adding)&&<CategoryEditor category={editing} colors={colors} onClose={()=>{setEditing(null);setAdding(false)}} onSave={save}/>}
    <div className="settings-group"><h2>Это устройство</h2><div className="theme-setting"><div><b>Оформление</b><small>Сохраняется только на этом устройстве</small></div><div className="theme-toggle" role="group" aria-label="Тема оформления"><button type="button" className={theme==='light'?'selected':''} aria-pressed={theme==='light'} onClick={()=>onThemeChange('light')}>Светлая</button><button type="button" className={theme==='dark'?'selected':''} aria-pressed={theme==='dark'} onClick={()=>onThemeChange('dark')}>Тёмная</button></div></div><p className="page-intro device-note">Для работы без интернета расходы и сессия доверенно сохраняются в этом браузере. Не используйте эту функцию на общем устройстве.</p><button type="button" className="danger-link" disabled={accessBusy||Boolean(moving)} onClick={onLogout}>Выйти и удалить локальные данные</button></div>
  </section>
}

function CategoryEditor({ category, colors, onClose, onSave }:{category:Category|null;colors:string[];onClose:()=>void;onSave:(c:Category)=>Promise<void>}) {
  const now = new Date().toISOString()
  const [draft,setDraft]=useState<Category>(category||{id:crypto.randomUUID(),name:'',color:colors[0] ?? '#819978',placement:'additional',sortOrder:999,createdAt:now,updatedAt:now,archivedAt:null,version:1})
  const [busy,setBusy]=useState(false)
  const [validation,setValidation]=useState('')
  const {confirm,confirmation}=useConfirm()
  const dialogRef=useDialog(onClose,!busy)
  const submit=async(next:Category)=>{
    const name=next.name.trim()
    if(!name&&!next.archivedAt){setValidation('Введите название категории.');return}
    setValidation('');setBusy(true)
    try{await onSave({...next,name:name||next.name})}finally{setBusy(false)}
  }
  const colorNames=['шалфейный','терракотовый','песочный','голубой','сиреневый','графитовый']
  return <><div className="sheet-backdrop" onMouseDown={()=>{if(!busy)onClose()}}><form ref={dialogRef as React.Ref<HTMLFormElement>} className="bottom-sheet editor" role="dialog" aria-modal="true" aria-labelledby="category-editor-title" noValidate onSubmit={(e)=>{e.preventDefault();void submit(draft)}} onMouseDown={(e)=>e.stopPropagation()}><div className="sheet-handle"/><div className="sheet-title"><h2 id="category-editor-title">{category?'Изменить':'Новая категория'}</h2><button type="button" className="icon-button" data-dialog-initial-focus disabled={busy} aria-label="Закрыть" onClick={onClose}>×</button></div><label>Название<input maxLength={40} aria-invalid={Boolean(validation)} value={draft.name} onChange={(e)=>{setValidation('');setDraft({...draft,name:e.target.value})}}/></label>{validation&&<p className="form-error" role="alert">{validation}</p>}<fieldset><legend>Цвет</legend><div className="colors">{colors.map((color,index)=><button aria-label={`Цвет: ${colorNames[index] ?? color}`} aria-pressed={draft.color===color} type="button" key={color} className={draft.color===color?'selected':''} style={{background:color}} onClick={()=>setDraft({...draft,color})}/>)}</div></fieldset><label>Размещение<select value={draft.placement} onChange={(e)=>setDraft({...draft,placement:e.target.value as Category['placement']})}><option value="main">Основные</option><option value="additional">Дополнительные</option></select></label><button className="primary" disabled={busy}>{busy?'Сохраняем…':'Сохранить'}</button>{category&&<button type="button" className="danger-link" disabled={busy} onClick={()=>void (async()=>{if(await confirm({title:'Архивировать категорию?',message:'Она исчезнет из выбора, но останется у старых расходов.',confirmLabel:'Архивировать',danger:true}))await submit({...draft,archivedAt:new Date().toISOString()})})()}>Архивировать</button>}</form></div>{confirmation}</>
}

const tabs:{id:Tab;label:string}[]=[{id:'entry',label:'Расход'},{id:'history',label:'История'},{id:'analytics',label:'Аналитика'},{id:'settings',label:'Настройки'}]

function NavIcon({ tab }: { tab: Tab }) {
  if(tab==='entry')return <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 8v8M8 12h8"/></svg>
  if(tab==='history')return <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/></svg>
  if(tab==='analytics')return <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19V13M12 19V5M19 19V9M3.5 19h17"/></svg>
  return <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h7M15 18h5"/><circle cx="16" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="13" cy="18" r="2"/></svg>
}

function outboxActionLabel(type: WorkspaceOutboxItem['type']) {
  if(type==='createExpense')return 'Добавление расхода'
  if(type==='updateExpense')return 'Изменение расхода'
  return 'Удаление расхода'
}

function SyncIssuesSheet({ userId, workspaceId, online, onClose, onDiscard }: { userId: string; workspaceId: string; online: boolean; onClose: () => void; onDiscard: () => Promise<void> }) {
  const [items,setItems]=useState<WorkspaceOutboxItem[]>([])
  const [loading,setLoading]=useState(true)
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const dialogRef=useDialog(onClose,!busy)
  const {confirm,confirmation}=useConfirm()
  useEffect(()=>{let active=true;void readOutbox(userId,workspaceId).then((all)=>{if(active){setItems(all.filter((item)=>item.status==='conflict'||item.status==='failed'));setLoading(false)}},()=>{if(active){setError('Не удалось прочитать локальную очередь.');setLoading(false)}});return()=>{active=false}},[userId,workspaceId])
  const discard=async()=>{
    if(!await confirm({title:'Отменить проблемные изменения?',message:'Локальные версии этих расходов будут удалены из очереди. После обновления приложение покажет серверные данные.',confirmLabel:'Отменить изменения',danger:true}))return
    setBusy(true);setError('')
    try{await onDiscard()}catch(reason){setError(reason instanceof Error?reason.message:'Не удалось очистить проблемные изменения');setBusy(false)}
  }
  return <><div className="sheet-backdrop" onMouseDown={()=>{if(!busy)onClose()}}><section ref={dialogRef} className="bottom-sheet sync-issues-sheet" role="dialog" aria-modal="true" aria-labelledby="sync-issues-title" onMouseDown={(event)=>event.stopPropagation()}><div className="sheet-handle"/><div className="sheet-title"><h2 id="sync-issues-title">Нужна проверка</h2><button type="button" className="icon-button" data-dialog-initial-focus disabled={busy} onClick={onClose} aria-label="Закрыть">×</button></div><p>Сервер не принял некоторые локальные изменения. Их можно отменить и вернуть актуальную версию с сервера.</p>{loading&&<p className="management-state" role="status">Проверяем очередь…</p>}<div className="sync-issue-list">{items.map((item)=><div key={item.operationId}><b>{outboxActionLabel(item.type)}</b><span>{item.status==='conflict'?'Версия на сервере уже изменилась':'Не удалось отправить'}</span><small>{new Date(item.createdAt).toLocaleString('ru-RU')}</small></div>)}</div>{!loading&&!items.length&&!error&&<p className="management-state" role="status">Проблемных изменений уже нет.</p>}{!online&&<p className="form-error" role="status">Подключитесь к интернету, чтобы после отмены загрузить серверную версию.</p>}{error&&<p className="form-error" role="alert">{error}</p>}<button type="button" className="primary danger" disabled={!online||busy||loading||!items.length} onClick={()=>void discard()}>{busy?'Обновляем…':'Отменить проблемные изменения'}</button><button type="button" className="sheet-cancel" disabled={busy} onClick={onClose}>Закрыть</button></section></div>{confirmation}</>
}

export function pagerTabsAt(scrollLeft: number, clientWidth: number): Tab[] {
  if (clientWidth <= 0) return ['entry']
  const position = Math.max(0, Math.min(tabs.length - 1, scrollLeft / clientWidth))
  const touching = [Math.floor(position), Math.ceil(position)].map((index) => tabs[index]!.id)
  return [...new Set<Tab>(['entry', ...touching])]
}

function pagerTabsFor(tab: Tab): Tab[] {
  return tab === 'entry' ? ['entry'] : ['entry', tab]
}

export function CreateWorkspaceSheet({ existing, onClose, onCreate }: { existing: boolean; onClose: () => void; onCreate: (id: string, name: string, displayName?: string) => Promise<void> }) {
  const [name,setName]=useState(''); const [displayName,setDisplayName]=useState(''); const [busy,setBusy]=useState(false); const [validation,setValidation]=useState('')
  const stableId = useRef(crypto.randomUUID())
  const dialogRef=useDialog(onClose,!busy)
  const submit=()=>{if(!name.trim()||!existing&&!displayName.trim()){setValidation(!existing&&!displayName.trim()?'Введите ваше имя.':'Введите название пространства.');return}setValidation('');setBusy(true);void onCreate(stableId.current,name.trim(),existing?undefined:displayName.trim()).finally(()=>setBusy(false))}
  return <div className="sheet-backdrop" onMouseDown={()=>{if(!busy)onClose()}}><form ref={dialogRef as React.Ref<HTMLFormElement>} className="bottom-sheet editor" role="dialog" aria-modal="true" aria-labelledby="create-workspace-title" noValidate onMouseDown={(event)=>event.stopPropagation()} onSubmit={(event)=>{event.preventDefault();submit()}}><div className="sheet-handle"/><div className="sheet-title"><h2 id="create-workspace-title">Создать пространство</h2><button type="button" className="icon-button" data-dialog-initial-focus disabled={busy} aria-label="Закрыть" onClick={onClose}>×</button></div>{!existing&&<label>Как вас называть<input maxLength={80} aria-invalid={Boolean(validation&&!displayName.trim())} value={displayName} onChange={(event)=>{setValidation('');setDisplayName(event.target.value)}}/></label>}<label>Название пространства<input maxLength={80} aria-invalid={Boolean(validation&&!name.trim())} value={name} onChange={(event)=>{setValidation('');setName(event.target.value)}}/></label>{validation&&<p className="form-error" role="alert">{validation}</p>}<button className="primary" disabled={busy}>{busy?'Создаём…':'Создать пространство'}</button><button type="button" className="sheet-cancel" disabled={busy} onClick={onClose}>Отмена</button></form></div>
}

export function WorkspaceSwitcher({ items, active, runtimes, online = navigator.onLine, onSelect, onCreate }: { items: WorkspaceSummary[]; active: string; runtimes: Record<string, import('./types').WorkspaceRuntime>; online?: boolean; onSelect: (id: string) => void; onCreate: () => void }) {
  const close=()=>onSelect(active)
  const dialogRef=useDialog(close)
  return <div className="sheet-backdrop" onMouseDown={close}><section ref={dialogRef} className="bottom-sheet" role="dialog" aria-modal="true" aria-labelledby="workspace-switcher-title" onMouseDown={(event)=>event.stopPropagation()}><div className="sheet-handle"/><div className="sheet-title"><h2 id="workspace-switcher-title">Пространства</h2><button type="button" className="icon-button" onClick={close} aria-label="Закрыть">×</button></div>{items.map((item)=>{const runtime=runtimes[item.id];const disabled=!online&&!runtime?.bootstrap;return <button type="button" data-dialog-initial-focus={item.id===active||undefined} aria-pressed={item.id===active} className="workspace-option" key={item.id} disabled={disabled} onClick={()=>onSelect(item.id)}><span>{item.name}<small>{item.role==='owner'?'Владелец':'Участник'} {runtime?.outbox.total?`· ${runtime.outbox.total} ждут`:''}</small></span>{item.id===active?'✓':disabled?'Нет офлайн-кэша':''}</button>})}<button type="button" className="primary" disabled={!online} onClick={onCreate}>Создать пространство</button></section></div>
}

export function RecoverySave({ prepared, complete, close, allowLater = true, mode = 'initial' }: { prepared: RecoveryPrepareResponse; complete: () => Promise<void | boolean>; close: () => void; allowLater?: boolean; mode?: 'initial' | 'rotation' | 'public' }) {
  const [saved,setSaved]=useState(false); const [busy,setBusy]=useState(false); const [completed,setCompleted]=useState(false); const [error,setError]=useState(''); const [feedback,setFeedback]=useState(''); const [feedbackError,setFeedbackError]=useState(false)
  const dialogRef=useDialog(close,allowLater||completed)
  useEffect(()=>{if(!completed)return;requestAnimationFrame(()=>dialogRef.current?.querySelector<HTMLElement>('[data-dialog-initial-focus]')?.focus({preventScroll:true}))},[completed])
  const finish = async () => {
    setBusy(true); setError('')
    try {
      const done = await complete()
      if (done !== false) setCompleted(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось завершить. Ссылка остаётся на экране — не закрывайте его.')
    } finally { setBusy(false) }
  }
  const copyRecovery=async()=>{try{await copyText(prepared.recoveryUrl);setFeedbackError(false);setFeedback('Ссылка скопирована')}catch(reason){setFeedbackError(true);setFeedback(reason instanceof Error?reason.message:'Не удалось скопировать ссылку')}}
  const shareRecovery=async()=>{try{if(typeof navigator.share==='function'){await navigator.share({title:'Ссылка восстановления moapp',url:prepared.recoveryUrl});setFeedbackError(false);setFeedback('Меню «Поделиться» открыто')}else await copyRecovery()}catch(reason){if(reason instanceof DOMException&&reason.name==='AbortError')return;setFeedbackError(true);setFeedback('Не удалось поделиться ссылкой')}}
  if (completed) return <div className="sheet-backdrop"><section ref={dialogRef} className="bottom-sheet access-sheet" role="dialog" aria-modal="true" aria-labelledby="recovery-complete-title"><div className="sheet-handle"/><h2 id="recovery-complete-title">{mode === 'public' ? 'Доступ восстановлен' : 'Новая ссылка сохранена'}</h2><p>{mode === 'public' ? 'Старая ссылка больше не работает, все прежние устройства отключены. Убедитесь, что новая ссылка сохранена.' : mode === 'rotation' ? 'Предыдущая ссылка больше не работает. Теперь храните новую ссылку.' : 'Восстановление настроено. Храните эту новую ссылку в безопасном месте.'}</p><button type="button" className="primary" data-dialog-initial-focus onClick={close}>Готово</button></section></div>
  const warning = mode === 'initial'
    ? 'Позже показать эту ссылку снова будет нельзя — можно только заменить новой. Любой, у кого есть ссылка, получит полный доступ ко всем вашим пространствам.'
    : mode === 'public'
      ? 'Сохраните новую ссылку прежде чем продолжить. После завершения старая ссылка перестанет работать, а все прежние устройства будут отключены.'
      : 'После завершения старая ссылка сразу перестанет работать. Любой, у кого есть новая ссылка, получит полный доступ.'
  return <div className="sheet-backdrop" onMouseDown={()=>{if(allowLater&&!busy)close()}}><section ref={dialogRef} className="bottom-sheet access-sheet" role="dialog" aria-modal="true" aria-labelledby="recovery-save-title" onMouseDown={(event)=>event.stopPropagation()}><div className="sheet-handle"/><h2 id="recovery-save-title">Сохраните ссылку восстановления</h2><p>{warning}</p><p>Подтвердить нужно до {new Date(prepared.expiresAt).toLocaleString('ru-RU')}.</p><div className="qr"><QRCodeSVG value={prepared.recoveryUrl} size={180}/></div><code className="access-link">{prepared.recoveryUrl}</code>{feedback&&<p className="inline-feedback" role={feedbackError?'alert':'status'}>{feedback}</p>}<button type="button" className="sheet-cancel" data-dialog-initial-focus onClick={()=>void copyRecovery()}>Скопировать</button>{typeof navigator.share==='function'&&<button type="button" className="sheet-cancel" onClick={()=>void shareRecovery()}>Поделиться</button>}<label className="check-line"><input type="checkbox" checked={saved} onChange={(event)=>setSaved(event.target.checked)}/> Я сохранил ссылку</label>{error&&<p className="form-error" role="alert">{error}</p>}<button type="button" className="primary" disabled={!saved||busy} onClick={()=>void finish()}>{busy?'Проверяем…':'Завершить'}</button>{allowLater&&<button type="button" className="sheet-cancel" disabled={busy} onClick={close}>Позже</button>}</section></div>
}

function LegacyClaimFlow({ hydrate, cancel }: { hydrate: (session: SessionState) => Promise<void>; cancel: () => void }) {
  const [name,setName]=useState(''); const [pin,setPin]=useState(''); const [busy,setBusy]=useState(false); const [error,setError]=useState(''); const attempt=useRef<string>(generateAttemptToken())
  const claim=async(event: React.FormEvent)=>{event.preventDefault();if(!name.trim()||!pin.trim()){setError(!name.trim()?'Введите ваше имя.':'Введите общий PIN.');return}setBusy(true);setError('');try{await hydrate(await legacyClaim(pin,name.trim(),attempt.current))}catch(reason){setError(reason instanceof ApiError&&reason.code==='CLAIM_IN_PROGRESS'?'Перенос уже выполняется в другой вкладке.':'PIN не подошёл или попытка временно ограничена.')}finally{setBusy(false)}}
  return <main className="empty-state"><div className="brand-mark">m</div><p className="eyebrow">Существующие расходы</p><h1>Перенести данные</h1><p>Укажите имя и действующий общий PIN. Затем нужно обязательно настроить восстановление.</p><form noValidate onSubmit={claim}><label>Ваше имя<input aria-invalid={Boolean(error&&!name.trim())} value={name} onChange={(event)=>{setError('');setName(event.target.value)}}/></label><label>Общий PIN<input aria-invalid={Boolean(error&&!pin.trim())} type="password" value={pin} onChange={(event)=>{setError('');setPin(event.target.value)}}/></label>{error&&<p className="form-error" role="alert">{error}</p>}<button className="primary" disabled={busy}>{busy?'Проверяем…':'Продолжить'}</button><button type="button" className="sheet-cancel" disabled={busy} onClick={cancel}>Назад</button></form></main>
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
  return <main className="empty-state"><div className="brand-mark">m</div><h1>Защитите профиль</h1><p role={error?'alert':'status'}>{error||'Готовим ссылку восстановления…'}</p></main>
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
  const online=useOnlineStatus()
  const {confirm,confirmation}=useConfirm()
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
        if(!current?.authenticated){current=await createIdentityWithProbe(name);allowWorkspaceMutations()}
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
  return <><main className="empty-state"><div className="brand-mark">m</div><p className="eyebrow">Безопасная ссылка</p><h1>{intent.kind==='invite'?'Приглашение':intent.kind==='device'?'Новое устройство':'Восстановление'}</h1><p>{error||copy}</p>
    {intent.kind==='invite'&&!session?.authenticated&&!conflict&&<label>Как вас называть<input aria-invalid={Boolean(error&&!name.trim())} value={name} onChange={(event)=>{setError('');setName(event.target.value)}}/></label>}
    {conflict?<button type="button" className="primary danger" disabled={!online||busy} onClick={()=>void (async()=>{if(!await confirm({title:'Выйти из текущего профиля?',message:'Локальные данные текущего профиля будут удалены с этого устройства.',confirmLabel:'Выйти и продолжить',danger:true}))return;setBusy(true);void resolveIdentityConflict(targetUserId).catch((reason)=>setError(reason instanceof Error?reason.message:'Не удалось выйти')).finally(()=>setBusy(false))})()}>{busy?'Выходим…':'Выйти и продолжить'}</button>:<button type="button" className="primary" disabled={!ready||busy||intent.kind==='invite'&&!session?.authenticated&&!name.trim()} onClick={()=>void proceed()}>{busy?'Проверяем…':intent.kind==='invite'?'Присоединиться':intent.kind==='device'?'Подключить':'Восстановить доступ'}</button>}
    <button className="sheet-cancel" disabled={busy} onClick={close}>Закрыть</button>
  </main>{confirmation}</>
}

export default function App({ capability = null }: { capability?: CapabilityIntent | null }) {
  const [state,setState]=useState(()=>createAppState(capability))
  const [pagerState,setPagerState]=useState<{workspaceId:string|null;tab:Tab;mounted:Tab[]}>({workspaceId:null,tab:'entry',mounted:['entry']})
  const [currentId,setCurrentId]=useState<string|null>(null)
  const [createOpen,setCreateOpen]=useState(false)
  const [switchOpen,setSwitchOpen]=useState(false)
  const [issuesOpen,setIssuesOpen]=useState(false)
  const [initialRecovery,setInitialRecovery]=useState<RecoveryPrepareResponse|null>(null)
  const [error,setError]=useState('')
  const { toast: notice, notify: setNotice, dismiss: hideNotice } = useToast()
  const { confirm, confirmation } = useConfirm()
  const online=useOnlineStatus()
  const [theme,setTheme]=useState<Theme>(()=>localStorage.getItem('moapp:theme')==='dark'?'dark':'light')
  const [updateWaiting,setUpdateWaiting]=useState(false)
  const [draftDirty,setDraftDirty]=useState(false)
  const [workspaceReloadEpoch,setWorkspaceReloadEpoch]=useState(0)
  const stateRef=useRef(state); stateRef.current=state
  const tab=pagerState.workspaceId===state.activeWorkspaceId?pagerState.tab:'entry'
  const mountedTabs=pagerState.workspaceId===state.activeWorkspaceId?pagerState.mounted:['entry']
  const setTab=useCallback((next:Tab)=>{
    const workspaceId=stateRef.current.activeWorkspaceId
    setPagerState({workspaceId,tab:next,mounted:pagerTabsFor(next)})
  },[])
  const capabilityRef=useRef(capability)
  const monitor=useRef<ReturnType<typeof monitorServiceWorkerUpdates> | undefined>(undefined)
  const coordinator=useRef<ReturnType<typeof createIdentityCoordinator> | null>(null)
  const requestAbort=useRef(new AbortController())
  const syncAbort=useRef(new AbortController())
  const sessionAbort=useRef(new AbortController())
  const refreshEpoch=useRef(0)
  const identityEpoch=useRef(0)
  const pager=useRef<HTMLElement|null>(null)
  const pagerWorkspace=useRef<string|null>(null)
  const pagerTimer=useRef<ReturnType<typeof setTimeout>>(undefined)
  const draftDirtyRef=useRef(draftDirty); draftDirtyRef.current=draftDirty
  const requestEpoch=useRef<Record<string,number>>({})

  const updateState=useCallback((updater:(value:AppState)=>AppState)=>{
    setState((value)=>{const next=updater(value);stateRef.current=next;return next})
  },[])
  const commitState=useCallback((next:AppState)=>{stateRef.current=next;setState(next)},[])
  const stopNetwork=useCallback(()=>{
    requestAbort.current.abort();syncAbort.current.abort();sessionAbort.current.abort();refreshEpoch.current+=1;identityEpoch.current+=1
    requestAbort.current=new AbortController();syncAbort.current=new AbortController()
  },[])
  const buildState=useCallback(async(next:SessionState,intent:CapabilityIntent|null=capabilityRef.current)=>{
    if(next.authenticated)allowWorkspaceMutations()
    if(next.authenticated&&!next.restrictedToRecovery&&next.legacyWorkspaceId)await migrateLegacyOfflineData(next.user.id,next.legacyWorkspaceId)
    return hydrateAppState(next,intent)
  },[])
  const hydrate=useCallback(async(next:SessionState,announce=false,expectedIdentityEpoch=identityEpoch.current)=>{
    if(expectedIdentityEpoch!==identityEpoch.current){setSessionContext(stateRef.current.session);return}
    const built=await buildState(next)
    if(expectedIdentityEpoch!==identityEpoch.current){setSessionContext(stateRef.current.session);return}
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
      if(!current()){setSessionContext(stateRef.current.session);return}
      commitState(built)
      if(reloadWorkspace)setWorkspaceReloadEpoch((value)=>value+1)
    }
    catch{
      if(!current()){setSessionContext(stateRef.current.session);return}
      const currentState=stateRef.current;const known=currentState.knownUserId
      if(known){
        const profile=await readCachedProfile(known)
        if(!current())return
        const candidate=profile?.session
        if(candidate?.authenticated&&Date.parse(candidate.currentSessionExpiresAt)>Date.now()){
          const offline=await buildState(candidate)
          if(!current()){setSessionContext(stateRef.current.session);return}
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
      onForeignIdentity:()=>{identityEpoch.current+=1;blockWorkspaceMutations();setSessionContext(null);const locked=createAppState(capabilityRef.current);locked.knownUserId=stateRef.current.knownUserId;commitState(locked)},
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
  useLayoutEffect(()=>{
    const node=pager.current
    if(!node)return
    const workspaceId=state.activeWorkspaceId
    if(pagerWorkspace.current!==workspaceId){
      pagerWorkspace.current=workspaceId
      clearTimeout(pagerTimer.current)
      node.scrollLeft=0
      setPagerState({workspaceId,tab:'entry',mounted:['entry']})
      return
    }
    node.scrollLeft=tabs.findIndex((item)=>item.id===tab)*node.clientWidth
  },[state.activeWorkspaceId,tab,Boolean(state.activeWorkspaceId&&state.runtimes[state.activeWorkspaceId]?.bootstrap)])
  useEffect(()=>()=>clearTimeout(pagerTimer.current),[])

  const session=state.session
  const auth=session?.authenticated?session:null
  const settingsIdentityEpoch=identityEpoch.current
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
        if(stateRef.current.session?.authenticated&&stateRef.current.session.user.id===userId&&stateRef.current.session.currentSessionId===sessionId)commitState(next)
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
    const expectedSessionId=auth?.currentSessionId
    return(action)=>{
      if(!expectedWorkspaceId||!expectedUserId||!expectedSessionId)return
      updateState((value)=>{
        const runtime=value.runtimes[expectedWorkspaceId]
        if(!runtime?.bootstrap||!value.session?.authenticated||value.session.user.id!==expectedUserId||value.session.currentSessionId!==expectedSessionId||!value.session.workspaces.some((workspace)=>workspace.id===expectedWorkspaceId))return value
        const next=typeof action==='function'?(action as (previous:Bootstrap)=>Bootstrap)(runtime.bootstrap):action
        if(next.workspaceId!==expectedWorkspaceId)return value
        void cacheBootstrap(expectedUserId,expectedWorkspaceId,next)
        return updateWorkspace(value,expectedWorkspaceId,(current)=>({...current,bootstrap:next}))
      })
    }
  },[auth?.currentSessionId,auth?.user.id,updateState,workspaceId])

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
      if(!current?.authenticated){if(!displayName)return;current=await createIdentityWithProbe(displayName);allowWorkspaceMutations();createdIdentity=true}
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
      const verifiedSession=current.session??await getSession()
      const pending=forgetKnownProfile(true,verifiedSession)
      const locked=createAppState(capabilityRef.current);locked.phase='capability';commitState(locked)
      if(!await pending)throw new Error('Не удалось удалить локальный профиль')
    }
    coordinator.current?.announce(null,null)
    await hydrate(await getSession())
  }

  const logoutCurrent=async()=>{
    const current=stateRef.current
    if(!current.session?.authenticated)return
    if(!await confirm({title:'Выйти на этом устройстве?',message:'Локальные данные этого профиля и офлайн-кэш будут удалены с устройства.',confirmLabel:'Выйти и удалить',danger:true}))return
    stopNetwork();const pending=beginLogout(current);capabilityRef.current=null;commitState(createLoggedOutState());coordinator.current?.announce(null,null)
    try{
      await pending
      if(online&&!await settlePendingLogout(true))throw new Error('Не удалось подтвердить выход на сервере')
      await refresh()
    }catch(reason){setError(reason instanceof Error?reason.message:'Не удалось завершить выход. Повторите после подключения к интернету.')}
  }

  const forgetCurrent=async()=>{
    if(!await confirm({title:'Забыть локальный профиль?',message:'Профиль, офлайн-кэш и несинхронизированные изменения будут удалены с этого устройства.',confirmLabel:'Удалить профиль',danger:true}))return
    const current=stateRef.current
    if(!online||!current.session){setError('Подключитесь к интернету, чтобы безопасно удалить профиль с этого устройства.');return}
    stopNetwork()
    const pending=forgetKnownProfile(online,current.session)
    capabilityRef.current=null;commitState(createLoggedOutState());coordinator.current?.announce(null,null)
    try{
      const forgotten=await pending
      if(!forgotten){setError('Не удалось безопасно удалить профиль. Подключитесь к интернету и повторите.');return}
      await refresh()
    }catch(reason){setError(reason instanceof Error?reason.message:'Не удалось удалить локальные данные. Повторите попытку.')}
  }

  const logoutUnexpected=async()=>{
    const unexpected=stateRef.current.conflictingSession
    if(!unexpected)return
    await logoutExpected(unexpected.userId,unexpected.sessionId)
    await refresh()
  }

  const confirmDraftDiscard=async()=>!draftDirty||confirm({title:'Отбросить черновик?',message:'Несохранённая сумма, категория и заметка будут потеряны.',confirmLabel:'Отбросить',danger:true})
  const openCreate=async()=>{if(await confirmDraftDiscard()){setSwitchOpen(false);setCreateOpen(true)}}
  const switchWorkspace=async(id:string)=>{
    if(id!==stateRef.current.activeWorkspaceId&&!await confirmDraftDiscard())return
    if(id!==stateRef.current.activeWorkspaceId){updateState((value)=>setActiveWorkspace(value,id));setCurrentId(null);setDraftDirty(false);setTab('entry')}
    setSwitchOpen(false)
  }
  const discardIssues=async()=>{
    const current=stateRef.current
    if(!current.session?.authenticated||!current.activeWorkspaceId)throw new Error('Пространство уже закрыто')
    const userId=current.session.user.id
    const sessionId=current.session.currentSessionId
    const activeWorkspaceId=current.activeWorkspaceId
    const data=await discardOutboxIssues(userId,activeWorkspaceId)
    updateState((value)=>value.session?.authenticated&&value.session.user.id===userId&&value.session.currentSessionId===sessionId&&value.activeWorkspaceId===activeWorkspaceId&&value.runtimes[activeWorkspaceId]?updateWorkspace(value,activeWorkspaceId,(runtime)=>({...runtime,bootstrap:data,source:'network',offline:false,status:'ready'})):value)
    await refreshWorkspaceStats(userId,activeWorkspaceId)
    setIssuesOpen(false)
    setWorkspaceReloadEpoch((value)=>value+1)
    setNotice('Проблемные изменения отменены. Загружаем серверную версию.')
  }
  const activateUpdate=()=>{if(draftDirty){setError('Сначала сохраните или очистите черновик расхода.');return}monitor.current?.activateWaiting()}
  const onPagerScroll=()=>{
    const node=pager.current
    if(node?.clientWidth){
      const workspaceId=stateRef.current.activeWorkspaceId
      const visible=pagerTabsAt(node.scrollLeft,node.clientWidth)
      setPagerState((previous)=>{
        const tab=previous.workspaceId===workspaceId?previous.tab:'entry'
        return previous.workspaceId===workspaceId&&previous.mounted.length===visible.length&&previous.mounted.every((item,index)=>item===visible[index])?previous:{workspaceId,tab,mounted:visible}
      })
    }
    clearTimeout(pagerTimer.current)
    pagerTimer.current=setTimeout(()=>{const node=pager.current;if(!node?.clientWidth)return;const item=tabs[Math.max(0,Math.min(tabs.length-1,Math.round(node.scrollLeft/node.clientWidth)))];if(item)setTab(item.id)},90)
  }

  if(state.phase==='checking')return <div className="splash"><div className="brand-mark">m</div>{error&&<p>{error}</p>}</div>
  if(state.capability)return <CapabilityScreen intent={state.capability} session={session} knownUserId={state.knownUserId} finish={finishIntent} close={closeIntent} resolveIdentityConflict={resolveIdentityConflict}/>
  if(state.phase==='legacy-claim')return <LegacyClaimFlow hydrate={(next)=>hydrate(next,true)} cancel={()=>updateState((value)=>({...value,phase:'guest'}))}/>
  if(state.phase==='restricted-recovery'&&auth)return <RestrictedRecovery session={auth} hydrate={async(next)=>{await hydrate(next,true);setNotice('Перенос завершён. Новая ссылка восстановления сохранена, старый PIN больше не используется.')}}/>
  if(state.phase==='guest'||state.phase==='no-workspaces'||state.phase==='known-user-locked')return <><main className="empty-state"><div className="brand-mark">m</div><p className="eyebrow">Общие расходы</p><h1>{state.phase==='known-user-locked'?'Нужно восстановить доступ':'Простой общий учёт расходов'}</h1><p>{state.phase==='known-user-locked'?'Локальные данные защищены. Откройте сохранённую ссылку восстановления или явно удалите профиль с этого устройства.':'Без регистрации, email и пароля.'}</p>{state.phase==='known-user-locked'?<>{state.conflictingSession&&<button type="button" className="primary" disabled={!online} onClick={()=>void logoutUnexpected().catch((reason)=>setError(reason instanceof Error?reason.message:'Не удалось выйти'))}>Выйти из другого профиля</button>}<button type="button" className="danger-link" disabled={!online||!state.session} onClick={()=>void forgetCurrent()}>Забыть локальный профиль</button>{(!online||!state.session)&&<p className="management-state" role="status">Удалить защищённый профиль можно после проверки соединения с сервером.</p>}</>:<><button type="button" className="primary" disabled={!online} onClick={()=>setCreateOpen(true)}>Создать пространство</button>{state.phase==='guest'&&session&&!session.authenticated&&session.legacyClaimAvailable&&<button type="button" className="sheet-cancel" onClick={()=>updateState(openLegacyClaim)}>Продолжить с существующими расходами</button>}</>}{createOpen&&<CreateWorkspaceSheet existing={Boolean(auth)} onClose={()=>setCreateOpen(false)} onCreate={create}/>} {error&&<p className="form-error" role="alert">{error}</p>}</main>{confirmation}</>

  const runtime=workspaceId?state.runtimes[workspaceId]:undefined
  const bootstrap=runtime?.bootstrap
  const workspace=auth&&workspaceId?auth.workspaces.find((item)=>item.id===workspaceId):undefined
  if(!auth||!workspaceId||!workspace||!bootstrap)return <div className="splash"><div className="brand-mark">m</div><p role={runtime?.status==='error'?'alert':'status'}>{runtime?.status==='error'?'Не удалось открыть пространство':'Загружаем пространство…'}</p>{error&&<><p className="form-error" role="alert">{error}</p><button type="button" className="sheet-cancel" onClick={()=>void refresh(true)}>Повторить</button></>}</div>
  const stats=runtime.outbox
  return <div className="app-shell" key={workspaceId}>
    <header className="workspace-header"><button type="button" className="workspace-name-button" onClick={()=>setSwitchOpen(true)}><span>{workspace.name}</span><span aria-hidden="true">⌄</span></button><div className="workspace-header-actions">{updateWaiting&&<button type="button" className="update-button" onClick={activateUpdate}>Обновить</button>}{stats.conflicts||stats.failed?<button type="button" className="sync-status attention" onClick={()=>setIssuesOpen(true)} aria-label={`Нужна проверка: ${stats.conflicts+stats.failed}`}><span>Нужна проверка · {stats.conflicts+stats.failed}</span><i/></button>:!online?<div className="sync-status offline" role="status"><span>{stats.total?`Офлайн · ${stats.total}`:'Офлайн'}</span><i/></div>:stats.total?<div className="sync-status" role="status" aria-live="polite"><span>Отправляем · {stats.total}</span><i/></div>:null}</div></header>
    <main className="pager" ref={pager} onScroll={onPagerScroll}>
      <div className="page-slot" inert={tab!=='entry'} aria-hidden={tab!=='entry'}>{mountedTabs.includes('entry')&&<EntryView userId={auth.user.id} workspaceId={workspaceId} bootstrap={bootstrap} setBootstrap={setWorkspaceData} currentId={currentId} setCurrentId={setCurrentId} refreshPending={refreshPending} onDraftDirtyChange={setDraftDirty} active={tab==='entry'}/>}</div>
      <div className="page-slot" inert={tab!=='history'} aria-hidden={tab!=='history'}>{mountedTabs.includes('history')&&<HistoryView userId={auth.user.id} workspaceId={workspaceId} bootstrap={bootstrap} setBootstrap={setWorkspaceData} edit={(id)=>{setCurrentId(id);setTab('entry')}} refreshPending={refreshPending}/>}</div>
      <div className="page-slot" inert={tab!=='analytics'} aria-hidden={tab!=='analytics'}>{mountedTabs.includes('analytics')&&<AnalyticsView userId={auth.user.id} workspaceId={workspaceId} bootstrap={bootstrap} theme={theme} online={online}/>}</div>
      <div className="page-slot" inert={tab!=='settings'} aria-hidden={tab!=='settings'}>{mountedTabs.includes('settings')&&<SettingsView user={auth} workspace={workspace} workspaceId={workspaceId} bootstrap={bootstrap} setBootstrap={setWorkspaceData} pendingCount={stats.total} refreshPending={refreshPending} onLogout={()=>void logoutCurrent()} theme={theme} onThemeChange={setTheme} onSession={(next)=>hydrate(next,false,settingsIdentityEpoch)} onCreateWorkspace={()=>void openCreate()} online={online}/>}</div>
    </main>
    <nav className="bottom-nav" aria-label="Основная навигация">{tabs.map((item)=><button type="button" key={item.id} aria-current={tab===item.id?'page':undefined} className={tab===item.id?'active':''} onClick={()=>setTab(item.id)}><span><NavIcon tab={item.id}/></span><small>{item.label}</small></button>)}</nav>
    {switchOpen&&<WorkspaceSwitcher items={auth.workspaces} active={workspaceId} runtimes={state.runtimes} online={online} onSelect={(id)=>void switchWorkspace(id)} onCreate={()=>void openCreate()}/>} {createOpen&&<CreateWorkspaceSheet existing onClose={()=>setCreateOpen(false)} onCreate={create}/>} {issuesOpen&&<SyncIssuesSheet userId={auth.user.id} workspaceId={workspaceId} online={online} onClose={()=>setIssuesOpen(false)} onDiscard={discardIssues}/>} {initialRecovery&&<RecoverySave key={initialRecovery.completionToken} prepared={initialRecovery} mode="initial" close={()=>setInitialRecovery(null)} complete={async()=>{
      const outcome=await completeRotationSafely({prepared:initialRecovery,targetUserId:auth.user.id})
      if(outcome.status!=='completed')throw new Error(outcome.status==='rotation-stale'?'Параллельно была завершена другая настройка восстановления.':'Не удалось подтвердить настройку. Повторите из настроек.')
      await hydrate(outcome.session,true)
    }}/>}
    {error && <Toast toast={{text:error,urgent:true}} onDismiss={()=>setError('')}/>}
    {notice&&<Toast toast={notice} onDismiss={hideNotice}/>} {confirmation}
  </div>
}
