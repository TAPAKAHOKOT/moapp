import { lazy, memo, startTransition, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import {
  WorkspaceApiError as ApiError, allowWorkspaceMutations, blockWorkspaceMutations, createCategory, describeOutboxIssue, discardOutboxIssues, getAnalytics, getBootstrap, isServerReachable, probeServer, retryOutboxIssue, subscribeServerReachability,
  classifyBybitCardTransaction, connectBybitCard, disconnectBybitCard, getBybitCardStatus, ignoreBybitCardTransaction, listBybitCardTransactions, syncBybitCard, undoBybitCardTransaction,
  createDeviceLink, createInvitation, createTag, deleteTag, includeExpense, reorderTags, updateTag, getSession, isLinkInvalid, legacyClaim, leaveWorkspace, listInvitations, listMembers, listSessions, logoutExpected, prepareInitialOrManualRecovery,
  prepareRecovery, previewDeviceLink, previewInvitation, previewRecovery, removeMember, renameWorkspace, reorderCategories, revokeInvitation, revokeSession, submitExpenseOperation,
  setSessionContext, submitExpenseOperations, syncAllWorkspaces, transferOwnership, updateCategory, updateProfile,
} from './workspace-api'
import { cacheBootstrap, clearWorkspaceOfflineData, migrateLegacyOfflineData, outboxStats, readCachedProfile, readOutbox, waitForWorkspaceOfflineWrites } from './workspace-offline'
import { applyMembershipLoss, beginLogout, chooseCachedWorkspace, closeCapability, createAppState, createIdentityCoordinator, createLoggedOutState, forgetKnownProfile, getWorkspacePreference, hydrateAppState, openLegacyClaim, setActiveWorkspace, setWorkspacePreference, settlePendingLogout, updateWorkspace } from './app-state'
import type { AppState } from './app-state'
import { AccessFlowError, acceptDeviceWithProbe, acceptInvitationWithProbe, createIdentityWithProbe, createWorkspaceWithProbe, generateAttemptToken } from './access-flow'
import { completeRecoverySafely, completeRotationSafely } from './recovery-flow'
import { monitorServiceWorkerUpdates } from './service-worker-update'
import type { AnalyticsData, AuthenticatedSession, BybitCardStatus, BybitCardTransaction, BybitRegion, CapabilityIntent, Category, Currency, Expense, RecoveryPrepareResponse, SessionState, Tag, WorkspaceBootstrap, WorkspaceOutboxItem, WorkspaceSummary } from './types'
import { amountToMinor, applyKeypad, cachedDateTimeFormat, cachedNumberFormat, convertExpense, countCalendarWeekdays, formatAmountInput, hasRate, isoToLocalInput, localDateKey, localInputToIso, monthDateRange, shiftDateKey, swipeDirection, weekdayFromDateKey, weekDateRange } from './utils'
import { buildHistoryCsv, defaultHistoryPreferences, expenseTagNames, filterHistoryExpenses, HISTORY_PERIOD_LABELS, historyTotals, parseHistoryPreferences, type HistoryPeriod, type HistoryPreferences } from './history'

const AnalyticsChart = lazy(() => import('./AnalyticsCharts'))

export type Tab = 'entry' | 'history' | 'analytics' | 'settings'
type Theme = 'light' | 'dark'

function readThemePreference(): ThemePreference {
  const saved = localStorage.getItem('moapp:theme')
  return saved === 'dark' || saved === 'light' ? saved : 'system'
}

function systemTheme(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

// «Как в системе» следует за телефоном и меняется вместе с ним; явный выбор фиксирует тему.
function useResolvedTheme(preference: ThemePreference): Theme {
  const [system, setSystem] = useState<Theme>(systemTheme)
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!media) return
    const update = () => setSystem(media.matches ? 'dark' : 'light')
    update()
    media.addEventListener?.('change', update)
    return () => media.removeEventListener?.('change', update)
  }, [])
  return preference === 'system' ? system : preference
}
type AnalyticsPeriod = 'week' | 'month'
const CHART_COLOR = '#758d69'
const EMPTY_FORM = { amount: '', currency: 'RSD', note: '', occurredAt: '', tagIds: [] as string[], categoryId: '' }
// Черновик считается непустым, если в нём есть что угодно, а не только сумма: категория и теги теперь тоже выбираются до сохранения.
const formHasContent = (form: typeof EMPTY_FORM) => Boolean(form.amount || form.note || form.occurredAt || form.tagIds.length || form.categoryId)

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

// Кольцо фокуса нужно при работе с клавиатуры. После закрытия шторки фокус возвращается на кнопку программно,
// и при управлении пальцем или мышью это кольцо только мешает, поэтому запоминаем последний способ ввода.
function useInputModality() {
  useEffect(() => {
    const root = document.documentElement
    const pointer = () => { root.dataset.input = 'pointer' }
    const keyboard = (event: KeyboardEvent) => { if (event.key === 'Tab' || event.key.startsWith('Arrow') || event.key === 'Enter' || event.key === ' ') root.dataset.input = 'keyboard' }
    window.addEventListener('pointerdown', pointer, true)
    window.addEventListener('keydown', keyboard, true)
    return () => { window.removeEventListener('pointerdown', pointer, true); window.removeEventListener('keydown', keyboard, true) }
  }, [])
}

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

// «Онлайн» — это и флаг браузера, и факт, что сервер отвечает: iOS нередко считает сеть доступной, когда запросы падают.
function useOnlineStatus() {
  const [online, setOnline] = useState(() => navigator.onLine)
  const [reachable, setReachable] = useState(() => isServerReachable())
  useEffect(() => {
    const update = () => {
      setOnline(navigator.onLine)
      if (navigator.onLine && !isServerReachable()) void probeServer()
    }
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    const unsubscribe = subscribeServerReachability(setReachable)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
      unsubscribe()
    }
  }, [])
  // Пока сервер не отвечает, связь проверяется сама: событие online на iPhone приходит не всегда.
  useEffect(() => {
    if (reachable || !online) return
    const timer = setInterval(() => void probeServer(), 20_000)
    return () => clearInterval(timer)
  }, [reachable, online])
  return online && reachable
}

function pluralRu(count: number, forms: [string, string, string]) {
  const tail = count % 100
  if (tail >= 11 && tail <= 19) return forms[2]
  const last = tail % 10
  return last === 1 ? forms[0] : last >= 2 && last <= 4 ? forms[1] : forms[2]
}

const SHEET_EXIT_MS = 180

function useDialog(onClose: () => void, dismissible = true, instanceKey: unknown = null) {
  const ref = useRef<HTMLElement>(null)
  // Выходная анимация шторки. React снимает узел мгновенно, поэтому на время анимации в body остаётся
  // визуальный клон подложки: без обработчиков, скрытый от читалок и не ловящий касания.
  useLayoutEffect(() => {
    const dialog = ref.current
    const backdrop = dialog?.parentElement
    return () => {
      // Без Web Animations API (например, в jsdom) клон некому анимировать и убирать, поэтому шторка просто исчезает.
      if (!dialog || !backdrop || !backdrop.classList.contains('sheet-backdrop') || typeof backdrop.getAnimations !== 'function' || prefersReducedMotion()) return
      queueMicrotask(() => {
        if (dialog.isConnected) return
        const ghost = backdrop.cloneNode(true) as HTMLElement
        ghost.classList.add('closing')
        ghost.setAttribute('aria-hidden', 'true')
        ghost.setAttribute('inert', '')
        for (const modal of ghost.querySelectorAll('[aria-modal]')) modal.removeAttribute('aria-modal')
        document.body.append(ghost)
        setTimeout(() => ghost.remove(), SHEET_EXIT_MS)
      })
    }
  }, [instanceKey])
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

function tap(pattern: number | number[] = 8) {
  navigator.vibrate?.(pattern)
}

function localInputParts(localInput: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(localInput)
  if (!match) return null
  const [, year, month, day, hour, minute] = match
  const date = new Date(`${year}-${month}-${day}T12:00:00Z`)
  return { year, hour, minute, date }
}

function formatShortWeekday(localInput: string) {
  const parts = localInputParts(localInput)
  return parts ? cachedDateTimeFormat('ru-RU', { weekday: 'short', timeZone: 'UTC' }).format(parts.date) : ''
}

export function formatEntryDate(localInput: string) {
  const parts = localInputParts(localInput)
  if (!parts) return ''
  const calendarDate = cachedDateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(parts.date)
  return `${formatShortWeekday(localInput)} · ${calendarDate} ${parts.year}, ${parts.hour}:${parts.minute}`
}

export function formatShortDate(dateKey: string) {
  return cachedDateTimeFormat('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${dateKey}T12:00:00Z`)).replace(' г.', '')
}

// Диапазон дат для чипа фильтра: «3–5 сент.», «28 авг. – 5 сент.», и только через год — с годами.
export function formatDateRange(from: string, to: string) {
  if (from === to) return formatShortDate(from)
  const day = (key: string) => Number(key.slice(8))
  const month = (key: string) => cachedDateTimeFormat('ru-RU', { timeZone: 'UTC', month: 'short' }).format(new Date(`${key}T12:00:00Z`))
  if (from.slice(0, 7) === to.slice(0, 7)) return `${day(from)}–${day(to)} ${month(to)}`
  if (from.slice(0, 4) === to.slice(0, 4)) return `${day(from)} ${month(from)} – ${day(to)} ${month(to)}`
  return `${formatShortDate(from)} – ${formatShortDate(to)}`
}

export function formatHistoryDate(dateKey: string) {
  const localInput = `${dateKey}T12:00`
  const parts = localInputParts(localInput)
  if (!parts) return ''
  const calendarDate = cachedDateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(parts.date)
  return `${formatShortWeekday(localInput)} · ${calendarDate} ${parts.year}`
}

const CARD_GAP = 18

// Вид карточки задаётся её содержимым, а не состоянием экрана: соседняя карточка сохранённого расхода
// рисуется теми же правилами, что и живая, и в момент подмены ничего не меняет цвет и не сдвигается.
type CardFace = { kind: 'new' | 'edit'; title: string; date: string; amount: string; currency: string }

function EntryCard({ face, onDate, onCurrency, disabled = false, limitHit = 0 }: { face: CardFace; onDate?: () => void; onCurrency?: () => void; disabled?: boolean; limitHit?: number }) {
  const inert = onCurrency ? undefined : -1
  return <>
    <header className={`topline${face.kind === 'edit' ? ' topline-edit' : ''}`}>
      <div>
        <p className="eyebrow">{face.title}</p>
        <button type="button" className="date-chip" onClick={onDate} tabIndex={inert} disabled={disabled}><span>{face.date}</span><ChevronIcon/></button>
      </div>
    </header>
    <div className="amount-row">
      <output key={limitHit} className={`amount-value${face.amount ? '' : ' empty'}${limitHit ? ' limit' : ''}`} data-size={amountSize(face.amount)} aria-label="Сумма">{formatAmountInput(face.amount) || '0'}</output>
      <button type="button" onClick={onCurrency} tabIndex={inert} disabled={disabled}>{face.currency}<ChevronIcon/></button>
    </div>
  </>
}

const ChevronIcon = () => <svg className="chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6l5 5 5-5"/></svg>
const CheckIcon = () => <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5"/></svg>

type SelectOption = { value: string; label: string; hint?: string }

// Замена нативного <select>: системный список вариантов не стилизуется и выбивается из интерфейса,
// поэтому варианты открываются в той же нижней шторке, что валюта и категории.
function Select({ label, title = label, value, options, onChange, disabled = false, searchable = options.length > 8, className = 'select-trigger', placeholder }: { label: string; title?: string; value: string; options: SelectOption[]; onChange: (value: string) => void; disabled?: boolean; searchable?: boolean; className?: string; placeholder?: string }) {
  const [open, setOpen] = useState(false)
  const current = options.find((option) => option.value === value)
  // Чип фильтра без значения называет сам фильтр («Категория»), а не «Все категории»: так видно, что включено.
  const text = !value && placeholder ? placeholder : current?.label ?? '—'
  return <>
    <button type="button" className={`${className}${value && className !== 'select-trigger' ? ' active' : ''}`} aria-label={label} aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={() => setOpen(true)}><span>{text}</span><ChevronIcon/></button>
    {open && <SelectSheet title={title} value={value} options={options} searchable={searchable} onClose={() => setOpen(false)} onSelect={(next) => { setOpen(false); if (next !== value) onChange(next) }}/>}
  </>
}

function SelectSheet({ title, value, options, searchable, onClose, onSelect }: { title: string; value: string; options: SelectOption[]; searchable: boolean; onClose: () => void; onSelect: (value: string) => void }) {
  const [query, setQuery] = useState('')
  const dialogRef = useDialog(onClose)
  const titleId = useId()
  const normalized = query.trim().toLowerCase()
  const filtered = normalized ? options.filter((option) => `${option.label} ${option.hint ?? ''}`.toLowerCase().includes(normalized)) : options
  // Шторка живёт внутри <label> рядом с кнопкой-триггером. Когда тап по «×» или варианту размонтирует её, клик
  // добирается до label, и тот по умолчанию «нажимает» триггер — шторка открывалась заново (iOS Safari, WebKit).
  return <div className="sheet-backdrop" onMouseDown={onClose} onClick={(event) => event.preventDefault()}>
    <section ref={dialogRef} className={`bottom-sheet select-sheet${searchable ? ' tall' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(event) => event.stopPropagation()}>
      <div className="sheet-handle"/><div className="sheet-title"><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" data-dialog-initial-focus onClick={onClose} aria-label="Закрыть">×</button></div>
      {searchable && <input className="search" type="search" placeholder="Поиск" aria-label={`Поиск: ${title}`} value={query} onChange={(event) => setQuery(event.target.value)}/>}
      <div className="select-options" role="listbox" aria-label={title}>{filtered.map((option) => <button type="button" role="option" key={option.value} aria-selected={option.value === value} aria-label={option.hint ? `${option.label}, ${option.hint}` : undefined} className="select-option" onClick={() => onSelect(option.value)}><span><b>{option.label}</b>{option.hint && <small>{option.hint}</small>}</span>{option.value === value && <CheckIcon/>}</button>)}</div>
      {!filtered.length && <p className="sheet-empty" role="status">По запросу «{query}» ничего не найдено.</p>}
    </section>
  </div>
}

// Полоса с прокруткой не показывает, что справа есть ещё: пока содержимое не доехало до конца, край затухает.
function useOverflowHint(ref: React.RefObject<HTMLElement | null>) {
  const [more, setMore] = useState(false)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const update = () => setMore(node.scrollWidth - node.clientWidth - node.scrollLeft > 1)
    update()
    node.addEventListener('scroll', update, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(node)
    return () => { node.removeEventListener('scroll', update); observer?.disconnect() }
  })
  return more
}

// Чип фильтра с несколькими значениями: без выбора он называет фильтр, с одним — само значение, с несколькими — счёт.
function MultiSelect({ label, title, placeholder, values, options, onChange, allLabel, count, className = 'filter-chip' }: { label: string; title: string; placeholder: string; values: string[]; options: SelectOption[]; onChange: (values: string[]) => void; allLabel: string; count: (n: number) => string; className?: string }) {
  const [open, setOpen] = useState(false)
  const text = values.length === 0 ? placeholder : values.length === 1 ? options.find((option) => option.value === values[0])?.label ?? placeholder : count(values.length)
  return <>
    <button type="button" className={`${className}${values.length ? ' active' : ''}`} aria-label={label} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><span>{text}</span><ChevronIcon/></button>
    {open && <MultiSelectSheet title={title} values={values} options={options} allLabel={allLabel} onClose={() => setOpen(false)} onChange={onChange}/>}
  </>
}

// Шит выбора нескольких значений: галочки, «Все …» снимает выбор, закрывает «Готово».
function MultiSelectSheet({ title, values, options, allLabel, onClose, onChange }: { title: string; values: string[]; options: SelectOption[]; allLabel: string; onClose: () => void; onChange: (values: string[]) => void }) {
  const [query, setQuery] = useState('')
  const dialogRef = useDialog(onClose)
  const titleId = useId()
  const searchable = options.length > 8
  const normalized = query.trim().toLowerCase()
  const filtered = normalized ? options.filter((option) => `${option.label} ${option.hint ?? ''}`.toLowerCase().includes(normalized)) : options
  const toggle = (value: string) => { tap(4); onChange(values.includes(value) ? values.filter((item) => item !== value) : [...values, value]) }
  return <div className="sheet-backdrop" onMouseDown={onClose}>
    <section ref={dialogRef} className={`bottom-sheet select-sheet${searchable ? ' tall' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(event) => event.stopPropagation()}>
      <div className="sheet-handle"/><div className="sheet-title"><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" data-dialog-initial-focus onClick={onClose} aria-label="Закрыть">×</button></div>
      {searchable && <input className="search" type="search" placeholder="Поиск" aria-label={`Поиск: ${title}`} value={query} onChange={(event) => setQuery(event.target.value)}/>}
      <div className="select-options" role="listbox" aria-label={title} aria-multiselectable="true">
        {!normalized && <button type="button" role="option" aria-selected={values.length === 0} className="select-option" onClick={() => { if (values.length) { tap(4); onChange([]) } }}><span><b>{allLabel}</b></span>{values.length === 0 && <CheckIcon/>}</button>}
        {filtered.map((option) => { const active = values.includes(option.value); return <button type="button" role="option" key={option.value} aria-selected={active} aria-label={option.hint ? `${option.label}, ${option.hint}` : undefined} className="select-option" onClick={() => toggle(option.value)}><span><b>{option.label}</b>{option.hint && <small>{option.hint}</small>}</span>{active && <CheckIcon/>}</button> })}
      </div>
      {!filtered.length && <p className="sheet-empty" role="status">По запросу «{query}» ничего не найдено.</p>}
      <button type="button" className="primary sheet-done" onClick={onClose}>Готово</button>
    </section>
  </div>
}

const MAX_EXPENSE_TAGS = 20

// Тег — короткая плашка поверх категории. Один расход может нести несколько тегов, любой тег подходит любой категории.
function TagChip({ name, color = null, selected = false, onToggle, disabled = false, inert = false }: { name: string; color?: string | null; selected?: boolean; onToggle?: () => void; disabled?: boolean; inert?: boolean }) {
  if (!onToggle) return <span className="tag-chip" style={tagStyle({ color })}>{name}</span>
  return <button type="button" className="tag-chip" style={tagStyle({ color })} aria-pressed={selected} disabled={disabled} tabIndex={inert ? -1 : undefined} onClick={onToggle}>{name}</button>
}

const TAG_COLORS = ['#819978', '#d98f70', '#d2ad62', '#7d9db4', '#aa8aaf', '#797d72']
const TAG_COLOR_NAMES = ['шалфейный', 'терракотовый', 'песочный', 'голубой', 'сиреневый', 'графитовый']

// Порядок тегов задаёт пользователь в настройках: полоса выбора и плашки в истории следуют ему.
function sortTags(tags: Tag[]) {
  return [...tags].sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, 'ru-RU'))
}

function tagStyle(tag: Pick<Tag, 'color'>) {
  return tag.color ? { '--tag': tag.color } as React.CSSProperties : undefined
}

// Сколько тегов лежит на самом экране расхода до чипа «Ещё N». Выбранные видны всегда.
const VISIBLE_TAGS = 5

// Ряд под категориями: заметка первой и всегда на месте, дальше теги как категории — по порядку из настроек,
// остальные за «Ещё N». Полный список с поиском и созданием — в шите.
function ExtrasRow({ tags, selected, note, onChange, onNote, onCreate, disabled = false, online = true, inert = false }: { tags: Tag[]; selected: string[]; note: string; onChange: (ids: string[]) => void; onNote: () => void; onCreate?: (name: string) => Promise<Tag | null>; disabled?: boolean; online?: boolean; inert?: boolean }) {
  const [open, setOpen] = useState(false)
  const stripRef = useRef<HTMLDivElement>(null)
  const sorted = sortTags(tags)
  // Порядок стабилен: выбранный чип не переезжает под пальцем в начало, а тег из хвоста списка встаёт в конец ряда.
  const shown = sorted.filter((tag, index) => index < VISIBLE_TAGS || selected.includes(tag.id))
  const hidden = sorted.length - shown.length
  const tabIndex = inert ? -1 : undefined
  const more = useOverflowHint(stripRef)
  // Полоса тегов — единственное место экрана ввода, где разрешён горизонтальный пан. Пока чипам хватает ширины, ей
  // нечего листать, и браузер отдавал жест пейджеру вкладок: страница отъезжала и возвращалась. Без переполнения пан запрещён.
  useLayoutEffect(() => {
    const node = stripRef.current
    if (!node) return
    const update = () => { node.style.touchAction = node.scrollWidth > node.clientWidth + 1 ? 'pan-x' : 'pan-y' }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  })
  const toggle = (id: string) => {
    tap(4)
    if (selected.includes(id)) onChange(selected.filter((item) => item !== id))
    else if (selected.length < MAX_EXPENSE_TAGS) onChange([...selected, id])
  }
  // Шторка рендерится рядом с рядом, а не внутри него: iOS Safari удерживает position:fixed внутри прокручиваемого
  // контейнера, и подложка оказывалась обрезанной полосой и под футером.
  return <>
    <div className={`extras-row${more ? ' more' : ''}`} role="group" aria-label="Заметка и теги">
      <button type="button" className={`tag-add extra-add extra-note${note ? ' filled' : ''}`} disabled={disabled} tabIndex={tabIndex} onClick={onNote} aria-label={note ? `Заметка: ${note}` : 'Добавить заметку'}>{note ? `✎ ${note}` : '＋ Заметка'}</button>
      <div className="tag-strip" ref={stripRef} role="group" aria-label="Теги">
        {shown.map((tag) => <TagChip key={tag.id} name={tag.name} color={tag.color} selected={selected.includes(tag.id)} disabled={disabled} inert={inert} onToggle={() => toggle(tag.id)}/>)}
        <button type="button" className="tag-add extra-add" disabled={disabled} tabIndex={tabIndex} onClick={() => setOpen(true)} aria-label={hidden ? `Ещё ${hidden} ${pluralRu(hidden, ['тег', 'тега', 'тегов'])}, все теги` : tags.length ? 'Все теги' : 'Добавить тег'}>{hidden ? `Ещё ${hidden}` : '＋ Тег'}</button>
      </div>
    </div>
    {open && <TagSheet tags={tags} selected={selected} online={online} onClose={() => setOpen(false)} onChange={onChange} onCreate={onCreate}/>}
  </>
}

// Заметка правится в шите: поле на самом экране меняло высоту и уводило раскладку под клавиатуру.
function NoteSheet({ value, onClose, onSave }: { value: string; onClose: () => void; onSave: (note: string) => void }) {
  const [draft, setDraft] = useState(value)
  const dialogRef = useDialog(onClose)
  return <div className="sheet-backdrop" onMouseDown={onClose}>
    <form ref={dialogRef as React.Ref<HTMLFormElement>} className="bottom-sheet editor note-sheet" role="dialog" aria-modal="true" aria-labelledby="note-title" noValidate onSubmit={(event) => { event.preventDefault(); onSave(draft.trim()) }} onMouseDown={(event) => event.stopPropagation()}>
      <div className="sheet-handle"/>
      <div className="sheet-title"><h2 id="note-title">Заметка</h2><button type="button" className="icon-button" onClick={onClose} aria-label="Закрыть">×</button></div>
      <label>Заметка<input data-dialog-initial-focus maxLength={200} placeholder="Например, IKEA" value={draft} onChange={(event) => setDraft(event.target.value)}/></label>
      <button className="primary">Готово</button>
      {value && <button type="button" className="danger-link" onClick={() => onSave('')}>Убрать заметку</button>}
    </form>
  </div>
}

function TagSheet({ tags, selected, online, onClose, onChange, onCreate }: { tags: Tag[]; selected: string[]; online: boolean; onClose: () => void; onChange: (ids: string[]) => void; onCreate?: (name: string) => Promise<Tag | null> }) {
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dialogRef = useDialog(onClose, !busy)
  const titleId = useId()
  const normalized = query.trim().toLowerCase()
  const sorted = sortTags(tags)
  const filtered = normalized ? sorted.filter((tag) => tag.name.toLowerCase().includes(normalized)) : sorted
  const exact = tags.find((tag) => tag.name.toLowerCase() === normalized)
  const canCreate = Boolean(onCreate) && normalized.length > 0 && !exact
  const toggle = (id: string) => {
    if (selected.includes(id)) onChange(selected.filter((item) => item !== id))
    else if (selected.length < MAX_EXPENSE_TAGS) onChange([...selected, id])
  }
  const create = async () => {
    if (!onCreate || !canCreate || busy || !online) return
    setBusy(true); setError('')
    try {
      const tag = await onCreate(query.trim())
      if (tag) { if (!selected.includes(tag.id) && selected.length < MAX_EXPENSE_TAGS) onChange([...selected, tag.id]); setQuery('') }
    } catch (reason) { setError(reason instanceof ApiError ? reason.message : 'Не удалось создать тег') }
    finally { setBusy(false) }
  }
  return <div className="sheet-backdrop" onMouseDown={() => { if (!busy) onClose() }}>
    <section ref={dialogRef} className="bottom-sheet tall select-sheet tag-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(event) => event.stopPropagation()}>
      <div className="sheet-handle"/><div className="sheet-title"><h2 id={titleId}>Теги</h2><button type="button" className="icon-button" data-dialog-initial-focus onClick={onClose} aria-label="Закрыть">×</button></div>
      <input className="search" type="search" maxLength={30} placeholder={onCreate ? 'Найти или создать тег' : 'Найти тег'} aria-label="Поиск тега" value={query} disabled={busy} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key !== 'Enter') return; event.preventDefault(); if (canCreate) void create(); else if (exact) toggle(exact.id) }}/>
      {canCreate && <button type="button" className="tag-create" disabled={busy || !online} onClick={() => void create()}>{busy ? 'Создаём…' : `Создать тег «${query.trim()}»`}</button>}
      {canCreate && !online && <p className="sheet-empty" role="status">Новые теги создаются только онлайн.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="select-options" role="listbox" aria-label="Теги" aria-multiselectable="true">{filtered.map((tag) => { const active = selected.includes(tag.id); return <button type="button" role="option" key={tag.id} aria-selected={active} className="select-option" onClick={() => toggle(tag.id)}><span><i className="tag-dot" style={{ background: tag.color ?? 'var(--sage)' }}/><b>{tag.name}</b></span>{active && <CheckIcon/>}</button> })}</div>
      {!tags.length && !normalized && <p className="sheet-empty" role="status">Тегов пока нет. Введите название, чтобы создать первый.</p>}
      <button type="button" className="primary sheet-done" onClick={onClose}>Готово</button>
    </section>
  </div>
}

function TagEditor({ tag, onClose, onSave, onDelete }: { tag: Tag | null; onClose: () => void; onSave: (name: string, color: string | null) => Promise<void>; onDelete?: () => Promise<void> }) {
  const [name, setName] = useState(tag?.name ?? '')
  const [color, setColor] = useState<string | null>(tag ? tag.color : TAG_COLORS[0]!)
  const [busy, setBusy] = useState(false)
  const [validation, setValidation] = useState('')
  const { confirm, confirmation } = useConfirm()
  const dialogRef = useDialog(onClose, !busy)
  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed) { setValidation('Введите название тега.'); return }
    setValidation(''); setBusy(true)
    try { await onSave(trimmed, color) } finally { setBusy(false) }
  }
  const remove = async () => {
    if (!onDelete || !await confirm({ title: 'Удалить тег?', message: 'Он исчезнет со всех расходов, сами расходы останутся.', confirmLabel: 'Удалить', danger: true })) return
    setBusy(true)
    try { await onDelete() } finally { setBusy(false) }
  }
  return <><div className="sheet-backdrop" onMouseDown={() => { if (!busy) onClose() }}><form ref={dialogRef as React.Ref<HTMLFormElement>} className="bottom-sheet editor tag-editor" role="dialog" aria-modal="true" aria-labelledby="tag-editor-title" noValidate onSubmit={(event) => { event.preventDefault(); void submit() }} onMouseDown={(event) => event.stopPropagation()}><div className="sheet-handle"/><div className="sheet-title"><h2 id="tag-editor-title">{tag ? 'Изменить тег' : 'Новый тег'}</h2><button type="button" className="icon-button" data-dialog-initial-focus disabled={busy} aria-label="Закрыть" onClick={onClose}>×</button></div><label>Название<input maxLength={30} aria-invalid={Boolean(validation)} value={name} onChange={(event) => { setValidation(''); setName(event.target.value) }}/></label>{validation && <p className="form-error" role="alert">{validation}</p>}<fieldset><legend>Цвет</legend><div className="colors">{TAG_COLORS.map((option, index) => <button type="button" key={option} aria-label={`Цвет: ${TAG_COLOR_NAMES[index] ?? option}`} aria-pressed={color === option} className={color === option ? 'selected' : ''} style={{ background: option }} onClick={() => setColor(option)}/>)}<button type="button" aria-label="Без цвета" aria-pressed={color === null} className={`colors-none${color === null ? ' selected' : ''}`} onClick={() => setColor(null)}>—</button></div></fieldset><button className="primary" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>{tag && onDelete && <button type="button" className="danger-link" disabled={busy} onClick={() => void remove()}>Удалить</button>}</form></div>{confirmation}</>
}

// Создание тега из любого экрана: дубликат имени не ошибка, а уже существующий тег.
async function createTagOrReuse(workspaceId: string, name: string, color: string | null, publish: (tag: Tag) => void): Promise<Tag> {
  try {
    const tag = await createTag(workspaceId, { name, color })
    publish(tag)
    return tag
  } catch (error) {
    const current = error instanceof ApiError && error.code === 'DUPLICATE' ? (error.details as { current?: Tag } | undefined)?.current : undefined
    if (!current) throw error
    publish(current)
    return current
  }
}

const TrashIcon = () => <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>

// Блок действий над расходом («новый» и «удалить») проявляется и гаснет вместе с карточкой, а не скачком при подмене.
const ENTRY_ACTIONS_HIDDEN: React.CSSProperties = { opacity: 0, transform: 'scale(.82)' }
function styleEntryActions(node: HTMLElement | null, presence: number, duration: number) {
  if (!node) return
  if (prefersReducedMotion()) duration = 0
  const easing = 'cubic-bezier(.25,.8,.3,1)'
  node.style.transition = duration ? `opacity ${duration}ms ${easing}, transform ${duration}ms ${easing}` : 'none'
  node.style.opacity = String(presence)
  node.style.transform = `scale(${0.82 + presence * 0.18})`
}

type ToastState = { text: string; urgent?: boolean; action?: { label: string; run: () => void }; id?: number; leaving?: boolean }
const TOAST_EXIT_MS = 180
let toastSequence = 0

export function useToast(timeout = 2600) {
  const [toast, setToast] = useState<ToastState | null>(null)
  const toastId = toast?.id
  const longLived = Boolean(toast?.action || toast?.urgent)
  useEffect(() => {
    if (toastId === undefined) return
    // Тост с действием живёт дольше: на «Вернуть» нужно успеть среагировать. Последние TOAST_EXIT_MS он затухает.
    const lifetime = longLived ? 5600 : timeout
    const leave = setTimeout(() => setToast((current) => current?.id === toastId ? { ...current, leaving: true } : current), Math.max(0, lifetime - TOAST_EXIT_MS))
    const remove = setTimeout(() => setToast((current) => current?.id === toastId ? null : current), lifetime)
    return () => { clearTimeout(leave); clearTimeout(remove) }
  }, [toastId, longLived, timeout])
  const notify = useCallback((text: string, action?: ToastState['action'], urgent = false) => setToast({ text, action, urgent, id: ++toastSequence }), [])
  const dismiss = useCallback(() => setToast(null), [])
  return { toast, notify, dismiss }
}

function Toast({ toast, onDismiss }: { toast: ToastState; onDismiss: () => void }) {
  const action = toast.action
  const leaving = toast.leaving ? ' leaving' : ''
  if (!action) return <div className={`toast toast-message${leaving}`} role={toast.urgent ? 'alert' : 'status'} aria-live={toast.urgent ? 'assertive' : 'polite'}><span>{toast.text}</span><button type="button" onClick={onDismiss} aria-label="Закрыть уведомление">×</button></div>
  return <div className={`toast toast-undo${leaving}`} role="status" aria-live="polite"><span>{toast.text}</span><button type="button" onClick={() => { onDismiss(); action.run() }}>{action.label}</button></div>
}

// Крупные суммы иначе упираются в многоточие: шрифт ступенчато уменьшается по числу цифр.
// Общая функция для карточки расхода и для строки суммы разбора — пороги должны совпадать.
export function amountSize(amount: string) {
  const digits = amount.replace(/\D/g, '').length
  return digits > 10 ? 'long' : digits > 7 ? 'medium' : 'normal'
}

function money(amountMinor: number, currency: string, currencies: Currency[]) {
  const decimals = currencies.find((item) => item.code === currency)?.decimals ?? 2
  return cachedNumberFormat('ru-RU', { style: 'currency', currency, maximumFractionDigits: decimals }).format(amountMinor / 10 ** decimals)
}

function amountNumber(amountMinor: number, currency: string, currencies: Currency[]) {
  const decimals = currencies.find((item) => item.code === currency)?.decimals ?? 2
  return cachedNumberFormat('ru-RU', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(amountMinor / 10 ** decimals)
}

function inputFromExpense(expense: Expense, currencies: Currency[]) {
  const decimals = currencies.find((item) => item.code === expense.currency)?.decimals ?? 2
  return {
    amount: String(expense.amountMinor / 10 ** decimals),
    currency: expense.currency,
    note: expense.note || '',
    occurredAt: isoToLocalInput(expense.occurredAt),
    tagIds: [...(expense.tagIds ?? [])].sort(),
    categoryId: expense.categoryId,
  }
}

function CurrencySheet({ currencies, used = [], selected, onClose, onSelect }: { currencies: Currency[]; used?: string[]; selected: string; onClose: () => void; onSelect: (code: string) => void }) {
  const [query, setQuery] = useState('')
  const [all, setAll] = useState(false)
  const dialogRef = useDialog(onClose)
  // Первыми стоят валюты, которые в пространстве уже встречались, и текущая: обычно это и есть весь список.
  const familiar = [...new Set([selected, ...used])].map((code) => currencies.find((currency) => currency.code === code)).filter((currency): currency is Currency => Boolean(currency))
  const filtered = currencies.filter((currency) => `${currency.code} ${currency.name}`.toLowerCase().includes(query.toLowerCase()))
  const showAll = all || familiar.length === 0
  const row = (currency: Currency) => <button type="button" key={currency.code} aria-pressed={selected === currency.code} onClick={() => onSelect(currency.code)}><span><b>{currency.code}</b><small>{currency.name}</small></span><span>{selected === currency.code ? <CheckIcon/> : currency.symbol}</span></button>
  return <div className="sheet-backdrop" onMouseDown={onClose}>
    <section ref={dialogRef} className={`bottom-sheet${showAll ? ' tall' : ''}`} role="dialog" aria-modal="true" aria-labelledby="currency-title" onMouseDown={(e) => e.stopPropagation()}>
      <div className="sheet-handle"/><div className="sheet-title"><h2 id="currency-title">Валюта</h2><button type="button" className="icon-button" data-dialog-initial-focus onClick={onClose} aria-label="Закрыть">×</button></div>
      {showAll && <input className="search" type="search" placeholder="Код или название" aria-label="Поиск валюты" value={query} onChange={(e) => setQuery(e.target.value)} />}
      <div className="currency-list">{(showAll ? filtered : familiar).map(row)}</div>
      {!showAll && <button type="button" className="sheet-cancel currency-more" onClick={() => setAll(true)}>Другая валюта…</button>}
      {showAll && !filtered.length && <p className="sheet-empty" role="status">По запросу «{query}» валют не найдено.</p>}
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
    setValidation('')
    setDraft(isoToLocalInput(date.toISOString()))
  }
  const valid = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(draft)
  return <div className="sheet-backdrop" onMouseDown={onClose}>
    <form ref={dialogRef as React.Ref<HTMLFormElement>} className="bottom-sheet editor" role="dialog" aria-modal="true" aria-labelledby="date-title" noValidate onSubmit={(event) => { event.preventDefault(); if (!draft) { setValidation('Выберите дату и время.'); return } onPick(draft) }} onMouseDown={(event) => event.stopPropagation()}>
      <div className="sheet-handle"/>
      <div className="sheet-title"><h2 id="date-title">Когда</h2><button type="button" className="icon-button" data-dialog-initial-focus onClick={onClose} aria-label="Закрыть">×</button></div>
      <p className="date-preview" aria-live="polite">{valid ? formatEntryDate(draft) : 'Дата не выбрана'}</p>
      <div className="date-presets"><button type="button" onClick={() => shift(0)}>Сейчас</button><button type="button" onClick={() => shift(1)}>Вчера</button><button type="button" onClick={() => shift(2)}>Позавчера</button></div>
      <label className="date-field">Дата и время <b className="weekday-badge">{formatShortWeekday(draft)}</b><input type="datetime-local" aria-invalid={Boolean(validation)} value={draft} onChange={(event) => { setValidation(''); setDraft(event.target.value) }}/></label>
      {validation && <p className="form-error" role="alert">{validation}</p>}
      <button className="primary">Готово</button>
    </form>
  </div>
}

// Календарь для фильтра истории: первый тап — начало, второй — конец; один день — два тапа по одной дате.
// Нативный <input type="date"> в iOS Safari закрывался сразу после открытия, поэтому даты выбираются в шите.
function CalendarSheet({ from, to, onClose, onPick }: { from: string; to: string; onClose: () => void; onPick: (from: string, to: string) => void }) {
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

const HISTORY_PERIOD_ORDER: HistoryPeriod[] = ['all', 'today', 'this-week', 'this-month', 'range']

// Период истории: пять вариантов в одном списке; «Выбрать даты» открывает календарь с диапазоном.
function PeriodSheet({ value, onClose, onSelect }: { value: HistoryPeriod; onClose: () => void; onSelect: (period: HistoryPeriod) => void }) {
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

const Keypad = memo(function Keypad({ onKey, disabled = false }: { onKey: (key: string) => void; disabled?: boolean }) {
  const press = (key: string) => { tap(); onKey(key) }
  return <div className="keypad" aria-label="Клавиатура суммы">{['1','2','3','4','5','6','7','8','9',',','0','⌫'].map((key) => <button
    key={key}
    type="button"
    disabled={disabled}
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
    <div className="sheet-handle"/><div className="sheet-title"><h2 id="category-sheet-title">Другие категории</h2><button type="button" className="icon-button" data-dialog-initial-focus onClick={onClose} aria-label="Закрыть">×</button></div>
    <div className="category-grid">{categories.map((category) => <button type="button" key={category.id} aria-pressed={category.id === selectedId} className={category.id === selectedId ? 'selected' : undefined} onClick={() => onPick(category)}><i style={{ backgroundColor: category.color ?? '#a9afa5' }}/><span>{category.name}</span></button>)}</div>
    {!categories.length && <p className="sheet-empty" role="status">Других категорий пока нет. Их можно добавить в настройках.</p>}
  </section></div>
}

// Нижняя часть экрана ввода для соседней записи: во время свайпа она проявляется поверх живой, чтобы категория,
// теги, заметка и кнопка сохранения менялись вместе с движением пальца, а не скачком при подмене. Слой чисто декоративный.
const SETTLE_MS = 80
type LowerPreviewState = { key: string; categoryId: string | null; tagIds: string[]; note: string; saveLabel: string; canSave: boolean }

// Подпись кнопки сохранения сама сообщает, чего не хватает: суммы, категории или изменений.
function saveButtonLabel({ amount, currency, categoryId, editing, dirty, currencies }: { amount: string; currency: string; categoryId: string | null; editing: boolean; dirty: boolean; currencies: Currency[] }) {
  const ready = Boolean(amount) && Number(amount) > 0
  if (!ready) return { label: 'Введите сумму', canSave: false }
  if (!categoryId) return { label: 'Выберите категорию', canSave: false }
  if (editing && !dirty) return { label: 'Сохранить', canSave: false }
  const decimals = currencies.find((item) => item.code === currency)?.decimals ?? 2
  return { label: `Сохранить ${cachedNumberFormat('ru-RU', { maximumFractionDigits: decimals }).format(Number(amount))} ${currency}`, canSave: true }
}

const GridIcon = () => <i className="grid-icon" aria-hidden="true"><svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><rect x="1.5" y="1.5" width="5" height="5" rx="1.5"/><rect x="9.5" y="1.5" width="5" height="5" rx="1.5"/><rect x="1.5" y="9.5" width="5" height="5" rx="1.5"/><rect x="9.5" y="9.5" width="5" height="5" rx="1.5"/></svg></i>

// Ряд плиток категорий: основные — плитками, остальные — за плиткой «Ещё N», которая показывает выбранную из них.
function CategoryTiles({ main, additional, selectedId, disabled = false, inert = false, onPick, onMore }: { main: Category[]; additional: Category[]; selectedId: string | null; disabled?: boolean; inert?: boolean; onPick?: (category: Category) => void; onMore?: () => void }) {
  const other = selectedId && !main.some((item) => item.id === selectedId) ? additional.find((item) => item.id === selectedId) ?? null : null
  const tabIndex = inert ? -1 : undefined
  return <div className="categories"><div className="main-categories">
    {main.map((category) => <button type="button" key={category.id} disabled={disabled} tabIndex={tabIndex} aria-pressed={category.id === selectedId} className={category.id === selectedId ? 'selected' : undefined} onClick={() => onPick?.(category)}><i style={{ backgroundColor: category.color ?? '#a9afa5' }}/><span>{category.name}</span></button>)}
    {additional.length > 0 && <button type="button" disabled={disabled} tabIndex={tabIndex} aria-pressed={Boolean(other)} className={other ? 'selected' : undefined} onClick={onMore}>{other ? <i style={{ backgroundColor: other.color ?? '#a9afa5' }}/> : <GridIcon/>}<span>{other ? other.name : `Ещё ${additional.length}`}</span></button>}
  </div></div>
}

function EntryLowerPreview({ main, additional, tags, state }: { main: Category[]; additional: Category[]; tags: Tag[]; state: LowerPreviewState }) {
  return <>
    <CategoryTiles main={main} additional={additional} selectedId={state.categoryId} inert/>
    <ExtrasRow tags={tags} selected={state.tagIds} note={state.note} inert onChange={() => {}} onNote={() => {}}/>
    <div className="entry-save"><button type="button" className="primary" tabIndex={-1} disabled={!state.canSave}>{state.saveLabel}</button>{state.key !== 'blank' && <button type="button" className="sheet-cancel ghost" tabIndex={-1} disabled aria-hidden>Отменить</button>}</div>
  </>
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
  const [noteSheet, setNoteSheet] = useState(false)
  const [saving, setSaving] = useState(false)
  const { toast, notify, dismiss } = useToast()
  const { confirm, confirmation } = useConfirm()
  const swipe = useRef<{ x: number; y: number; lastX: number; active: boolean; touchId: number | null } | null>(null)
  const suppressTouchPointerUp = useRef(false)
  const entryRef = useRef<HTMLElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const actionsRef = useRef<HTMLDivElement>(null)
  const lowerLiveRef = useRef<HTMLDivElement>(null)
  const lowerPreviewRef = useRef<HTMLDivElement>(null)
  // Содержимое превью замораживается на момент жеста: после подмены соседи меняются, а слой должен ещё
  // прикрывать живой, пока тот дотягивает свой переход к новой записи.
  const [swipePreview, setSwipePreview] = useState<LowerPreviewState | null>(null)
  const previewTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(previewTimer.current), [])
  const lastFade = useRef(0)
  // Превью непрозрачное и лежит поверх живого слоя: где содержимое совпадает, картинка не меняется вовсе,
  // а различия (выбранная категория, теги, заметка) проявляются пропорционально сдвигу.
  const styleCrossfade = (fade: number, duration: number) => {
    lastFade.current = fade
    const node = lowerPreviewRef.current
    if (!node) return
    node.style.transition = duration && !prefersReducedMotion() ? `opacity ${duration}ms cubic-bezier(.25,.8,.3,1)` : 'none'
    node.style.opacity = String(fade)
  }
  useLayoutEffect(() => {
    // Слой мог смонтироваться уже после первого сдвига — догоняем текущее значение без перехода.
    const node = lowerPreviewRef.current
    if (node && swipePreview) { node.style.transition = 'none'; node.style.opacity = String(lastFade.current) }
  }, [swipePreview])
  // Единственное, что существует только у сохранённой записи, — кнопка удаления сверху; она проявляется одним движением.
  const setActionsPresence = (presence: number, duration: number) => styleEntryActions(actionsRef.current, presence, duration)
  const offset = useRef(0)
  const swapped = useRef(false)
  const committing = useRef(false)
  const swapTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // Черновик несохранённого нового расхода, чтобы свайп по истории не стирал набранное.
  const draft = useRef(EMPTY_FORM)
  const synced = useRef<{ id: string; form: typeof EMPTY_FORM }>({ id: '', form: EMPTY_FORM })
  const formRef = useRef(form)
  formRef.current = form

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
    // При свайпе новое состояние уже достигнуто анимацией; при удалении и открытии из истории кнопка мягко гаснет или проявляется сама.
    setActionsPresence(currentId ? 1 : 0, didSwap ? 0 : 180)
    clearTimeout(previewTimer.current)
    if (didSwap) {
      // Живой слой получает новую запись следующим рендером; на этот кадр его переходы выключены, чтобы под превью
      // не тянулась анимация от старого состояния, иначе следующий быстрый свайп покажет её.
      const live = lowerLiveRef.current
      live?.classList.add('settling')
      previewTimer.current = setTimeout(() => { styleCrossfade(0, 0); setSwipePreview(null); live?.classList.remove('settling') }, SETTLE_MS)
    } else {
      styleCrossfade(0, 0)
      setSwipePreview(null)
    }
  }, [currentId])

  const blankForm = () => ({ ...EMPTY_FORM, currency: getWorkspacePreference(userId, workspaceId, 'last-currency') || 'RSD' })
  useLayoutEffect(() => {
    const base = current ? inputFromExpense(current, bootstrap.currencies) : formHasContent(draft.current) ? draft.current : blankForm()
    // Свежую версию записи подхватываем, только пока пользователь не начал править её сам.
    const sameRecord = synced.current.id === (currentId || '')
    if (sameRecord && JSON.stringify(form) !== JSON.stringify(synced.current.form)) return
    synced.current = { id: currentId || '', form: base }
    setForm(base)
  }, [currentId, current?.version]) // eslint-disable-line react-hooks/exhaustive-deps

  const [limitHit, setLimitHit] = useState(0)
  const key = useCallback((value: string) => {
    const decimalsFor = (currency: string) => bootstrap.currencies.find((item) => item.code === currency)?.decimals ?? 2
    const latest = formRef.current
    if (applyKeypad(latest.amount, value, decimalsFor(latest.currency)) === latest.amount) {
      // Отклонённая цифра (лимит разрядов или десятичных): без этого клавиатура молчит и кажется сломанной.
      if (value !== '⌫') { tap([10, 40, 10]); setLimitHit((count) => count + 1) }
      return
    }
    setForm((previous) => ({ ...previous, amount: applyKeypad(previous.amount, value, decimalsFor(previous.currency)) }))
  }, [bootstrap.currencies])

  const buildExpense = (submittedForm = form, submittedCurrent = current): Expense => {
    const now = new Date().toISOString()
    return {
      id: submittedCurrent?.id || crypto.randomUUID(), amountMinor: amountToMinor(submittedForm.amount, submittedForm.currency, bootstrap.currencies), currency: submittedForm.currency,
      categoryId: submittedForm.categoryId, note: submittedForm.note.trim() || null, occurredAt: submittedForm.occurredAt ? localInputToIso(submittedForm.occurredAt) : now, tagIds: [...submittedForm.tagIds].sort(),
      createdAt: submittedCurrent?.createdAt || now, updatedAt: now, version: submittedCurrent ? submittedCurrent.version + 1 : 1, deletedAt: null, pending: !navigator.onLine,
    }
  }

  const submitExpense = async () => {
    const submittedForm = { ...form }
    const submittedCurrent = current
    if (!submittedForm.amount || Number(submittedForm.amount) <= 0) { notify('Сначала введите сумму'); return }
    if (!submittedForm.categoryId) { notify('Выберите категорию'); return }
    setSaving(true); setCategorySheet(false)
    const expense = buildExpense(submittedForm, submittedCurrent)
    const previousExpense = bootstrap.expenses.find((item) => item.id === expense.id)
    setBootstrap((data) => ({ ...data, expenses: [expense, ...data.expenses.filter((item) => item.id !== expense.id)] }))
    try {
      const result = await submitExpenseOperation(userId, workspaceId, submittedCurrent ? 'updateExpense' : 'createExpense', expense)
      if (result?.expense) setBootstrap((data) => ({ ...data, expenses: data.expenses.map((item) => item.id === expense.id ? result.expense! : item) }))
      else if (!result) setBootstrap((data) => ({ ...data, expenses: data.expenses.map((item) => item.id === expense.id ? { ...item, pending:true } : item) }))
      notify(result?.status === 'conflict' ? 'Изменение конфликтует с сервером. Откройте «Не отправлено» вверху.' : submittedCurrent ? 'Изменения сохранены' : 'Расход добавлен')
      if (!submittedCurrent && !currentId && JSON.stringify(formRef.current) === JSON.stringify(submittedForm)) {
        const next = { ...EMPTY_FORM, currency: submittedForm.currency }
        draft.current = next
        synced.current = { id: '', form: next }
        setForm(next)
      } else if (submittedCurrent && currentId === submittedCurrent.id) {
        synced.current = { id: submittedCurrent.id, form: submittedForm }
      }
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

  // Плитка категории только выбирает — и для нового расхода, и для правки. Сохраняет одна кнопка внизу.
  const chooseCategory = (category: Category) => {
    tap(6)
    setForm((value) => ({ ...value, categoryId: category.id }))
    setCategorySheet(false)
  }

  const restore = async (deleted: Expense) => {
    // Сервер при обновлении сам снимает deleted_at, поэтому возврат — это обычная правка поверх версии после удаления.
    const restored: Expense = { ...deleted, deletedAt: null, updatedAt: new Date().toISOString(), version: deleted.version + 1, pending: !navigator.onLine }
    setBootstrap((data) => ({ ...data, expenses: data.expenses.map((item) => item.id === restored.id ? restored : item) }))
    try {
      const result = await submitExpenseOperation(userId, workspaceId, 'updateExpense', restored)
      if (result?.expense) setBootstrap((data) => ({ ...data, expenses: data.expenses.map((item) => item.id === restored.id ? result.expense! : item) }))
      notify(result?.status === 'conflict' ? 'Возврат конфликтует с сервером. Откройте «Не отправлено» вверху.' : 'Расход возвращён')
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
      if (result?.status === 'conflict') notify('Удаление конфликтует с сервером. Откройте «Не отправлено» вверху.')
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
    // Ширину читаем до записи стилей: чтение после записи заставляет браузер синхронно пересчитывать раскладку на каждом движении пальца.
    const span = node.clientWidth + CARD_GAP
    const easing = 'cubic-bezier(.25,.8,.3,1)'
    node.style.transition = duration ? `transform ${duration}ms ${easing}` : 'none'
    node.style.transform = dx ? `translateX(${dx}px)` : ''
    offset.current = dx

    const sourcePresence = current ? 1 : 0
    const direction = dx ? swipeDirection(dx) : null
    const targetPresence = !direction || !canMove(direction)
      ? sourcePresence
      : direction === 'older' || Boolean(newerNeighbour) ? 1 : 0
    const progress = Math.min(Math.abs(dx) / span, 1)
    setActionsPresence(sourcePresence + (targetPresence - sourcePresence) * progress, duration)
    const previewDirection = direction && canMove(direction) ? direction : null
    styleCrossfade(previewDirection ? progress : 0, duration)
    // Превью остаётся смонтированным при откате в ноль: его прозрачность уже уходит в 0, а размонтирование оборвало бы переход.
    const target = previewDirection ? previewFor(previewDirection) : null
    if (target) setSwipePreview((previous) => previous?.key === target.key ? previous : target)
  }

  const move = async (direction: 'older' | 'newer') => {
    if (!canMove(direction)) return
    const discarded = dirty
    if (dirty) {
      slide(0, prefersReducedMotion() ? 0 : 180)
      if (!await confirm({
        title: 'Перейти к другому расходу?',
        message: 'Несохранённые изменения будут потеряны. Сохраните их кнопкой ниже или подтвердите переход.',
        confirmLabel: 'Отбросить и перейти',
        danger: true,
      })) return
      draft.current = { ...EMPTY_FORM, currency: form.currency }
    }
    const target = direction === 'older' ? olderNeighbour : newerNeighbour ?? null
    if (!current && !discarded) draft.current = form
    const span = (trackRef.current?.clientWidth ?? 320) + CARD_GAP
    const destination = direction === 'older' ? span : -span
    const reduced = prefersReducedMotion()
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
    if (committing.current || saving || categorySheet || currencySheet || dateSheet || noteSheet) return false
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
    if (Math.abs(dx) > SWIPE_COMMIT && canMove(swipeDirection(dx))) void move(swipeDirection(dx))
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

  // Ряд «Дополнительно» листается сам по горизонтали: жест внутри него не должен переключать расходы.
  const insideTagStrip = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest('.tag-strip'))
  const swipeStart = (event: React.PointerEvent) => {
    if (event.pointerType === 'touch' && usesNativeTouch()) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (insideTagStrip(event.target)) return
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

  // Слушатели ставятся один раз на всё время жизни экрана: перевешивать четыре touch-обработчика на каждый
  // рендер (а рендеры идут и во время жеста) — лишняя работа посреди свайпа. Актуальные замыкания берём из рефа.
  const touchHandlers = useRef({ swipeStartAt, swipeMoveTo, swipeEndAt, swipeCancelAt })
  touchHandlers.current = { swipeStartAt, swipeMoveTo, swipeEndAt, swipeCancelAt }
  useEffect(() => {
    const node = entryRef.current
    if (!node || !usesNativeTouch()) return
    const findTouch = (touches: TouchList, identifier: number) => Array.from(touches).find((touch) => touch.identifier === identifier)
    const touchStart = (event: TouchEvent) => {
      suppressTouchPointerUp.current = false
      if (event.touches.length !== 1 || insideTagStrip(event.target)) { swipe.current = null; return }
      const touch = event.touches[0]
      if (touch) touchHandlers.current.swipeStartAt(touch.clientX, touch.clientY, touch.identifier)
    }
    const touchMove = (event: TouchEvent) => {
      const start = swipe.current
      if (!start || start.touchId === null) return
      const touch = findTouch(event.touches, start.touchId)
      if (touch && touchHandlers.current.swipeMoveTo(touch.clientX, touch.clientY)) {
        suppressTouchPointerUp.current = true
        event.preventDefault()
      }
    }
    const touchEnd = (event: TouchEvent) => {
      const start = swipe.current
      if (!start || start.touchId === null) return
      const touch = findTouch(event.changedTouches, start.touchId)
      if (touch) touchHandlers.current.swipeEndAt(touch.clientX)
      setTimeout(() => { suppressTouchPointerUp.current = false }, 0)
    }
    const touchCancel = () => {
      touchHandlers.current.swipeCancelAt()
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
  }, [])

  const occurredLabel = formatEntryDate(form.occurredAt) || formatEntryDate(isoToLocalInput(new Date().toISOString()))
  const faceOf = (expense: Expense): CardFace => {
    const data = inputFromExpense(expense, bootstrap.currencies)
    return { kind: 'edit', title: 'Редактирование', date: formatEntryDate(data.occurredAt), amount: data.amount, currency: data.currency }
  }
  const blankFace = (amount: string, currency: string): CardFace => ({ kind: 'new', title: 'Новый расход', date: formatEntryDate(isoToLocalInput(new Date().toISOString())), amount, currency })
  const liveFace: CardFace = current
    ? { kind: 'edit', title: 'Редактирование', date: occurredLabel, amount: form.amount, currency: form.currency }
    : { ...blankFace(form.amount, form.currency), date: occurredLabel }
  const olderFace = olderNeighbour ? faceOf(olderNeighbour) : null
  const newerFace = newerNeighbour ? faceOf(newerNeighbour)
    : currentIndex === 0 ? blankFace(draft.current.amount, draft.current.amount ? draft.current.currency : getWorkspacePreference(userId, workspaceId, 'last-currency') || 'RSD')
    : null
  const main = bootstrap.categories.filter((item) => !item.archivedAt && item.placement === 'main').sort((a,b) => a.sortOrder-b.sortOrder)
  const additional = bootstrap.categories.filter((item) => !item.archivedAt && item.placement === 'additional').sort((a,b) => a.sortOrder-b.sortOrder)
  const selectedCategoryId = form.categoryId || null
  const dirty = current ? JSON.stringify(form) !== JSON.stringify(inputFromExpense(current, bootstrap.currencies)) : formHasContent(form)
  const save = saveButtonLabel({ amount: form.amount, currency: form.currency, categoryId: selectedCategoryId, editing: Boolean(current), dirty, currencies: bootstrap.currencies })
  const usedCurrencies = useMemo(() => [...new Set(['RSD', ...bootstrap.expenses.filter((item) => !item.deletedAt).map((item) => item.currency)])], [bootstrap.expenses])
  const cancelEdit = () => {
    if (!current || saving) return
    const original = inputFromExpense(current, bootstrap.currencies)
    synced.current = { id: current.id, form: original }
    setForm(original)
  }
  useEffect(() => { onDraftDirtyChange(dirty) }, [dirty, onDraftDirtyChange])
  useEffect(() => () => onDraftDirtyChange(false), [onDraftDirtyChange])
  const previewFor = (direction: 'older' | 'newer'): LowerPreviewState | null => {
    const neighbour = direction === 'older' ? olderNeighbour : newerNeighbour
    if (direction === 'older' && !neighbour) return null
    if (neighbour) return { key: neighbour.id, categoryId: neighbour.categoryId, tagIds: neighbour.tagIds ?? [], note: neighbour.note ?? '', saveLabel: 'Сохранить', canSave: false }
    const blank = draft.current
    const blankSave = saveButtonLabel({ amount: blank.amount, currency: blank.currency, categoryId: blank.categoryId || null, editing: false, dirty: true, currencies: bootstrap.currencies })
    return { key: 'blank', categoryId: blank.categoryId || null, tagIds: blank.tagIds, note: blank.note, saveLabel: blankSave.label, canSave: blankSave.canSave }
  }
  const physicalKey = (event: KeyboardEvent) => {
    if (saving) return
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
  const publishTag = (tag: Tag) => setBootstrap((data) => ({ ...data, tags: [tag, ...(data.tags ?? []).filter((item) => item.id !== tag.id)] }))
  return <section ref={entryRef} className={`entry-view${current ? ' editing' : ''}${saving ? ' saving' : ''}`} aria-label="Ввод суммы" onPointerDown={swipeStart} onPointerMove={swipeMove} onPointerUpCapture={swipeEnd} onPointerCancel={swipeCancel}>
    <div className="swipe-area">
      <div className="entry-track" ref={trackRef}>
        {olderFace && <div className="entry-card aside older" aria-hidden="true"><EntryCard face={olderFace}/></div>}
        <div className="entry-card"><EntryCard face={liveFace} disabled={saving} limitHit={limitHit} onDate={() => setDateSheet(true)} onCurrency={() => setCurrencySheet(true)}/></div>
        {newerFace && <div className="entry-card aside newer" aria-hidden="true"><EntryCard face={newerFace}/></div>}
      </div>
    </div>
    <div ref={actionsRef} className="entry-actions" style={ENTRY_ACTIONS_HIDDEN} inert={!current} aria-hidden={!current}>
      <button type="button" className="icon-danger entry-delete" disabled={saving || !current} onClick={() => void remove()} aria-label="Удалить расход"><TrashIcon/></button>
    </div>
    <Keypad onKey={key} disabled={saving}/>
    <div className="entry-lower">
    <div ref={lowerLiveRef} className="entry-lower-live">
    <CategoryTiles main={main} additional={additional} selectedId={selectedCategoryId} disabled={saving} onPick={chooseCategory} onMore={() => setCategorySheet(true)}/>
    <ExtrasRow tags={bootstrap.tags ?? []} selected={form.tagIds} note={form.note} disabled={saving} online={navigator.onLine} onChange={(tagIds) => setForm((value) => ({ ...value, tagIds }))} onNote={() => setNoteSheet(true)} onCreate={(name) => createTagOrReuse(workspaceId, name, TAG_COLORS[(bootstrap.tags ?? []).length % TAG_COLORS.length] ?? null, publishTag)}/>
    <div className="entry-save"><button type="button" className="primary" disabled={!save.canSave || saving} onClick={() => void submitExpense()}>{saving ? 'Сохраняем…' : save.label}</button>{current && <button type="button" className={`sheet-cancel${dirty && !saving ? '' : ' ghost'}`} disabled={!dirty || saving} aria-hidden={!dirty || saving} tabIndex={dirty && !saving ? undefined : -1} onClick={cancelEdit}>Отменить</button>}</div>
    </div>
    {swipePreview && <div ref={lowerPreviewRef} className="entry-lower-preview" aria-hidden="true" inert><EntryLowerPreview main={main} additional={additional} tags={bootstrap.tags ?? []} state={swipePreview}/></div>}
    </div>
    {dateSheet && <DateSheet value={form.occurredAt} onClose={() => setDateSheet(false)} onPick={(value) => { setForm({ ...form, occurredAt: value }); setDateSheet(false) }}/>}
    {categorySheet && <CategorySheet categories={additional} selectedId={selectedCategoryId ?? undefined} onClose={() => setCategorySheet(false)} onPick={chooseCategory}/>}
    {noteSheet && <NoteSheet value={form.note} onClose={() => setNoteSheet(false)} onSave={(note) => { setForm({ ...form, note }); setNoteSheet(false) }}/>}
    {currencySheet && <CurrencySheet
      currencies={bootstrap.currencies}
      used={usedCurrencies}
      selected={form.currency}
      onClose={() => setCurrencySheet(false)}
      onSelect={(currency) => {
        setForm({...form,currency})
        setWorkspacePreference(userId, workspaceId, 'last-currency', currency)
        setCurrencySheet(false)
      }}
    />}
    {toast && <Toast toast={toast} onDismiss={dismiss}/>}
    {confirmation}
  </section>
}

const ROW_ACTION_WIDTH = 84
const LONG_PRESS_MS = 450
const ROW_DRAG_START = 8

// Строка истории: тап открывает запись, долгое нажатие включает выбор нескольких, свайп влево открывает удаление.
// Заголовок — всегда категория; второй строкой — то, что человек написал сам, и теги текстом: «Maxi · #вдвоём».
// Строк в истории сотни, и все они живут в дереве постоянно. Мемоизация с колбэками, принимающими запись,
// даёт перерисовку только тех строк, чьё состояние (выбор, открытый свайп) действительно изменилось.
const HistoryRow = memo(function HistoryRow({ expense, category, tags, currencies, checked, selecting, open, disabled, onOpen, onToggle, onEdit, onDelete, onVoided }: {
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

const SearchIcon = () => <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>

type HistoryInbox = { count: number; onOpen: () => void }
type HistoryReminder = { onSave: () => void }
const LockIcon = () => <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/></svg>

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

export function AnalyticsView({ userId, workspaceId, bootstrap, theme, online }: { userId: string; workspaceId: string; bootstrap: Bootstrap; theme: Theme; online: boolean }) {
  const [target, setTarget] = useState(getWorkspacePreference(userId, workspaceId, 'analytics-currency') || 'RSD')
  const [period, setPeriod] = useState<AnalyticsPeriod>('week')
  const [weekOffset, setWeekOffset] = useState(0)
  const [monthOffset, setMonthOffset] = useState(0)
  // Фокус на категории: тап по строке легенды сужает всё выше до неё и раскрывает её записи, второй тап возвращает всё.
  // Отдельного селекта нет — легенда и есть список категорий. Фокус живёт только до перезахода: сохранённый фильтр удивлял бы.
  const [focusedCategoryId,setFocusedCategoryId]=useState<string|null>(null)
  const [currencySheet, setCurrencySheet] = useState(false)
  const [allDetails,setAllDetails]=useState(false)
  const [rateInfo,setRateInfo]=useState(false)
  const [remote,setRemote]=useState<{key:string;data:AnalyticsData;previousTotalMinor:number|null}|null>(null)
  const [analyticsOffline,setAnalyticsOffline]=useState(!online)
  const [analyticsLoading,setAnalyticsLoading]=useState(online)
  const [analyticsError,setAnalyticsError]=useState<string|null>(null)
  const [retryEpoch,setRetryEpoch]=useState(0)
  const today=localDateKey(new Date())
  const selectedWeek=weekDateRange(today,weekOffset)
  const selectedMonth=monthDateRange(today,monthOffset)
  const categoryId=focusedCategoryId&&bootstrap.categories.some((category)=>category.id===focusedCategoryId)?focusedCategoryId:null
  const selectedRange=period==='week'?selectedWeek:selectedMonth
  const from=selectedRange.from
  // График обрывается на сегодняшнем дне: ещё не наступившие дни — не нули.
  const analyticsTo=selectedRange.to>today?today:selectedRange.to
  const periodDays=Math.round((new Date(`${analyticsTo}T12:00:00Z`).getTime()-new Date(`${from}T12:00:00Z`).getTime())/86400000)+1
  // Сравнение с прошлым периодом — за те же дни, пока текущий период не закончился; и для недели, и для месяца.
  const partial=analyticsTo<selectedRange.to
  const previousRange=period==='week'?weekDateRange(today,weekOffset-1):monthDateRange(today,monthOffset-1)
  const previousSameDays=shiftDateKey(previousRange.from,periodDays-1)
  const previousTo=partial&&previousSameDays<previousRange.to?previousSameDays:previousRange.to
  const expenseRevision=bootstrap.expenses.map((expense)=>`${expense.id}:${expense.version}:${expense.updatedAt}:${expense.deletedAt||''}:${expense.voidedAt||''}:${expense.amountMinor}:${expense.currency}:${expense.categoryId}:${expense.occurredAt}`).join('|')
  const requestKey=`${expenseRevision}:${from}:${analyticsTo}:${target}:${period}:${categoryId??'all'}`
  const fallback=useMemo(()=>fallbackAnalytics(bootstrap,target,from,analyticsTo,categoryId),[bootstrap,target,from,analyticsTo,categoryId])
  const previousFallback=useMemo(()=>fallbackAnalytics(bootstrap,target,previousRange.from,previousTo,categoryId),[bootstrap,target,previousRange.from,previousTo,categoryId])
  // Ответы сервера запоминаются по ключу периода: возврат к уже виденной неделе не ждёт сети. Пока ответа нет,
  // показан локальный расчёт по тем же курсам дня, так что число не меняется дважды.
  const cache=useRef(new Map<string,{data:AnalyticsData;previousTotalMinor:number|null}>())
  useEffect(()=>{
    let active=true;const controller=new AbortController()
    setAnalyticsError(null)
    if(!online){setAnalyticsOffline(true);setAnalyticsLoading(false);setRemote(null);return()=>controller.abort()}
    const cached=cache.current.get(requestKey)
    if(cached){setRemote({key:requestKey,...cached});setAnalyticsOffline(false);setAnalyticsLoading(false);return()=>controller.abort()}
    setAnalyticsLoading(true)
    Promise.all([getAnalytics(workspaceId,from,analyticsTo,target,categoryId??undefined,controller.signal),getAnalytics(workspaceId,previousRange.from,previousTo,target,categoryId??undefined,controller.signal)]).then(([result,previous])=>{
      if(!active)return
      const entry={data:result,previousTotalMinor:previous.totalMinor}
      cache.current.set(requestKey,entry)
      if(cache.current.size>40)cache.current.delete(cache.current.keys().next().value!)
      setRemote({key:requestKey,...entry});setAnalyticsOffline(false);setAnalyticsLoading(false)
    }).catch((reason)=>{if(active&&!controller.signal.aborted){setRemote(null);setAnalyticsOffline(true);setAnalyticsError(reason instanceof ApiError?reason.message:'Сервер аналитики недоступен');setAnalyticsLoading(false)}})
    return()=>{active=false;controller.abort()}
  },[workspaceId,from,analyticsTo,target,categoryId,previousRange.from,previousTo,requestKey,online,retryEpoch])
  // Индикатор загрузки появляется только если сервер думает дольше 300 мс, и не трогает раскладку.
  const [slowLoading,setSlowLoading]=useState(false)
  useEffect(()=>{if(!analyticsLoading){setSlowLoading(false);return}const timer=setTimeout(()=>setSlowLoading(true),300);return()=>clearTimeout(timer)},[analyticsLoading])
  const data=remote?.key===requestKey?remote.data:fallback
  const previousTotalMinor=remote?.key===requestKey?remote.previousTotalMinor:previousFallback.totalMinor
  const decimals=bootstrap.currencies.find((currency)=>currency.code===target)?.decimals??2
  const divisor=10**decimals
  const days=Array.from({length:periodDays},(_,index)=>shiftDateKey(from,index))
  const dailyMap=new Map(data.daily.map((point)=>[point.date,point.amountMinor/divisor]))
  const byDay=days.map((date)=>dailyMap.get(date)||0)
  const byCategory=data.categories.filter((item)=>item.amountMinor>0).map((item)=>({...item,value:item.amountMinor/divisor}))
  useEffect(()=>{setAllDetails(false)},[period,from,categoryId])
  const categoryDetails=useMemo(()=>categoryId?bootstrap.expenses.filter((expense)=>!expense.deletedAt&&!expense.voidedAt&&expense.categoryId===categoryId).map((expense)=>({expense,date:localDateKey(expense.occurredAt)})).filter((item)=>item.date>=from&&item.date<=analyticsTo).sort((left,right)=>right.expense.occurredAt.localeCompare(left.expense.occurredAt)):[],[bootstrap.expenses,categoryId,from,analyticsTo])
  const detailCaption=(expense:Expense)=>{if(expense.note)return ` · ${expense.note}`;const names=expenseTagNames(expense,bootstrap.tags??[]);return names.length?` · ${names.map((name)=>`#${name}`).join(' ')}`:''}
  const detailDate=(date:string)=>new Date(`${date}T12:00:00Z`).toLocaleDateString('ru-RU',{timeZone:'UTC',day:'numeric',month:'short'}).replace('.','')
  const serverWeekdays=new Map(data.weekdays.map((point)=>[point.weekday,point.amountMinor/divisor]))
  const weekdayCounts=countCalendarWeekdays(from,analyticsTo)
  const weekdays=[1,2,3,4,5,6,0].map((day)=>Math.round((serverWeekdays.get(day)||0)/(weekdayCounts[day]||1)))
  const total=data.totalMinor/divisor
  const previousTotal=(previousTotalMinor??0)/divisor
  const elapsedDays=Math.max(1,periodDays)
  const shownTotal=useTweenedNumber(total)
  const shownPerDay=useTweenedNumber(total/elapsedDays)
  const weekRange=formatWeekRange(selectedWeek.from,selectedWeek.to)
  const monthLabel=new Date(`${selectedMonth.from}T12:00:00Z`).toLocaleDateString('ru-RU',{timeZone:'UTC',month:'long',year:'numeric'})
  const focusedName=categoryId?bootstrap.categories.find((category)=>category.id===categoryId)?.name:null
  // О пересчёте валют говорим только когда он есть: в периоде встретились расходы не в валюте аналитики.
  const hasForeign=bootstrap.expenses.some((expense)=>{if(expense.deletedAt||expense.voidedAt||expense.currency===target)return false;const date=localDateKey(expense.occurredAt);return date>=from&&date<=analyticsTo})
  const focus=(id:string)=>{tap(4);setAllDetails(false);setRateInfo(false);setFocusedCategoryId((current)=>current===id?null:id)}
  const chartColor=theme==='dark'?'#b1cfa3':CHART_COLOR
  const chartText=theme==='dark'?'#b3b3ae':'#73776f'
  const chartGrid=theme==='dark'?'rgba(255,255,255,.06)':'rgba(32,37,31,.06)'
  const statusLine=analyticsOffline?<>{analyticsError?'Не удалось обновить. ':''}Показаны сохранённые данные на {new Date(bootstrap.serverTime).toLocaleString('ru-RU')}{online&&<button type="button" onClick={()=>setRetryEpoch((value)=>value+1)}>Повторить</button>}</>:data.missingCurrencies.length?`Нет курса: ${data.missingCurrencies.join(', ')} — эти расходы не посчитаны`:null
  return <section className="page analytics"><div className={`analytics-progress${slowLoading?' on':''}`} aria-hidden="true"/><header className="page-header analytics-title"><div>{focusedName&&<p className="eyebrow">{focusedName}</p>}<h1>{cachedNumberFormat('ru-RU',{maximumFractionDigits:0}).format(shownTotal)}{hasForeign&&<button type="button" className="rate-info" aria-label="Как посчитана сумма" aria-expanded={rateInfo} onClick={()=>setRateInfo((value)=>!value)}>i</button>}</h1><p className="analytics-comparison">{formatAnalyticsAmount(shownPerDay,target)} в день · {data.expenseCount} {pluralRu(data.expenseCount,['операция','операции','операций'])}</p><p className="analytics-comparison">{comparisonLabel(total,previousTotal,partial,period)}</p></div><button className="currency-choice" onClick={()=>setCurrencySheet(true)}>{target}<ChevronIcon/></button></header>
    {rateInfo&&hasForeign&&<p className="rate-caption" role="note">Расходы в других валютах пересчитаны в {target} по курсу на день покупки.</p>}
    <div className="analytics-period" role="group" aria-label="Период аналитики"><button type="button" aria-pressed={period==='week'} className={period==='week'?'selected':''} onClick={()=>setPeriod('week')}>Неделя</button><button type="button" aria-pressed={period==='month'} className={period==='month'?'selected':''} onClick={()=>setPeriod('month')}>Месяц</button></div>
    {period==='week'&&<div className="week-navigator"><button type="button" onClick={()=>setWeekOffset((value)=>value-1)} aria-label="Предыдущая неделя">‹</button><div><b>{weekOffset===0?'Текущая неделя':weekOffset===-1?'Прошлая неделя':'Выбранная неделя'}</b><span>{weekRange}</span></div><button type="button" onClick={()=>setWeekOffset((value)=>Math.min(0,value+1))} disabled={weekOffset===0} aria-label="Следующая неделя">›</button></div>}
    {period==='month'&&<div className="week-navigator"><button type="button" onClick={()=>setMonthOffset((value)=>value-1)} aria-label="Предыдущий месяц">‹</button><div><b>{monthOffset===0?'Текущий месяц':monthOffset===-1?'Прошлый месяц':'Выбранный месяц'}</b><span>{monthLabel}</span></div><button type="button" onClick={()=>setMonthOffset((value)=>Math.min(0,value+1))} disabled={monthOffset===0} aria-label="Следующий месяц">›</button></div>}
    {statusLine&&<div className={`rate-caption${analyticsOffline?' cached':''}`} role="status">{statusLine}</div>}
    <div className="chart-card"><div><h2>Динамика</h2><p>{period==='week'?'Понедельник — воскресенье':'По дням выбранного месяца'}</p></div>{data.convertedCount?<div className="line-chart"><Suspense fallback={<ChartSkeleton/>}><AnalyticsChart kind="line" labels={days.map((d)=>new Date(`${d}T12:00`).toLocaleDateString('ru-RU',period==='week'?{weekday:'short'}:{day:'numeric',month:'short'}))} values={byDay} color={chartColor} fillColor={theme==='dark'?'rgba(177,207,163,.14)':'rgba(117,141,105,.12)'} pointRadius={period==='week'?3:0} target={target} textColor={chartText} gridColor={chartGrid} maxTicksLimit={period==='week'?7:6}/></Suspense></div>:<AnalyticsEmpty>{data.expenseCount?'Нет курса для выбранной валюты':'В этом периоде ещё нет расходов'}</AnalyticsEmpty>}</div>
    <div className={`chart-card${byCategory.length?' split':''}`}><div><h2>Категории</h2><p>{categoryId?'Тап по строке возвращает все категории':period==='week'?'За выбранную неделю · тап по строке покажет записи':'За выбранный месяц · тап по строке покажет записи'}</p></div>{byCategory.length?<><div className="donut-wrap"><Suspense fallback={<ChartSkeleton/>}><AnalyticsChart kind="doughnut" labels={byCategory.map((x)=>x.name)} values={byCategory.map((x)=>x.value)} colors={byCategory.map((x)=>x.color||'#a9afa5')} target={target}/></Suspense><span>{formatCompactNumber(total)}</span></div><div className="legend">{byCategory.map((x)=>{const focused=categoryId===x.categoryId;const rows=focused?categoryDetails:[];const shown=allDetails?rows:rows.slice(0,LEGEND_DETAIL_LIMIT);return <div key={x.categoryId} className={`legend-item${focused?' open':''}`}><button type="button" className="legend-row" aria-expanded={focused} onClick={()=>focus(x.categoryId)}><i style={{background:x.color||'#a9afa5'}}/><span>{x.name}</span><span className="legend-value"><b>{formatAnalyticsAmount(x.value,target)}</b><small className={focused?'ghost':undefined} aria-hidden={focused||undefined}>{Math.round(x.value/total*100)||0}%</small></span>{focused?<span className="legend-close" aria-hidden="true">×</span>:<ChevronIcon/>}</button>{focused&&<div className="legend-details">{rows.length?<>{shown.map(({expense,date})=><div key={expense.id} className="legend-detail"><span><b>{detailDate(date)}</b>{detailCaption(expense)}</span><span className="legend-value"><b>{money(expense.amountMinor,expense.currency,bootstrap.currencies)}</b>{expense.currency!==target&&<small>≈ {formatAnalyticsAmount(convertExpense(expense,target,bootstrap.currencies,bootstrap.rates),target)}</small>}</span></div>)}{rows.length>shown.length&&<button type="button" className="legend-more" onClick={()=>setAllDetails(true)}>Показать все · {rows.length}</button>}</>:<p className="legend-empty">На этом устройстве нет записей этой категории за период.</p>}</div>}</div>})}{categoryId&&<button type="button" className="legend-all" onClick={()=>focus(categoryId)}>Все категории</button>}</div></>:<AnalyticsEmpty>Категории появятся после первого расхода</AnalyticsEmpty>}</div>
    {period==='month'&&<div className="chart-card"><div><h2>По дням недели</h2><p>Средние траты за календарный день</p></div>{data.convertedCount?<div className="bar-chart"><Suspense fallback={<ChartSkeleton/>}><AnalyticsChart kind="bar" labels={['Пн','Вт','Ср','Чт','Пт','Сб','Вс']} values={weekdays} color={chartColor} target={target} textColor={chartText} gridColor={chartGrid}/></Suspense></div>:<AnalyticsEmpty>Недостаточно данных для сравнения</AnalyticsEmpty>}</div>}
    {currencySheet && <CurrencySheet currencies={bootstrap.currencies} used={[...new Set(bootstrap.expenses.filter((item)=>!item.deletedAt).map((item)=>item.currency))]} selected={target} onClose={()=>setCurrencySheet(false)} onSelect={(code)=>{setTarget(code);setWorkspacePreference(userId, workspaceId, 'analytics-currency', code);setCurrencySheet(false)}}/>}
  </section>
}

const LEGEND_DETAIL_LIMIT=8

function AnalyticsEmpty({children}:{children:string}) {
  return <div className="analytics-empty"><span>⌁</span><p>{children}</p></div>
}

function ChartSkeleton() {
  return <div className="chart-skeleton" role="status" aria-label="Загружаем график"><i/><i/><i/><i/><i/></div>
}

function formatAnalyticsAmount(value:number,currency:string) {
  return `${cachedNumberFormat('ru-RU',{maximumFractionDigits:0}).format(value)} ${currency}`
}

function formatCompactNumber(value:number) {
  return cachedNumberFormat('ru-RU',{notation:'compact',maximumFractionDigits:1}).format(value)
}

// Число в шапке аналитики доезжает до нового значения за четверть секунды, а не прыгает. Первое значение — сразу.
function useTweenedNumber(value:number,duration=250) {
  const [shown,setShown]=useState(value)
  const shownRef=useRef(value)
  useEffect(()=>{
    const from=shownRef.current
    if(from===value)return
    if(prefersReducedMotion()||!Number.isFinite(from)||!Number.isFinite(value)||typeof requestAnimationFrame!=='function'){shownRef.current=value;setShown(value);return}
    const started=performance.now()
    let frame=0
    const tick=(now:number)=>{
      const progress=Math.min(1,(now-started)/duration)
      const eased=1-Math.pow(1-progress,3)
      const next=progress<1?from+(value-from)*eased:value
      shownRef.current=next;setShown(next)
      if(progress<1)frame=requestAnimationFrame(tick)
    }
    frame=requestAnimationFrame(tick)
    return()=>cancelAnimationFrame(frame)
  },[value,duration])
  return shown
}

function comparisonLabel(total:number,previous:number,partial:boolean,period:AnalyticsPeriod) {
  const words=period==='week'
    ?{sameDays:'за те же дни прошлой недели',whole:'на прошлой неделе',levelSame:'На уровне тех же дней прошлой недели',levelWhole:'На уровне прошлой недели',noneSame:'За те же дни прошлой недели расходов не было',noneWhole:'На прошлой неделе расходов не было'}
    :{sameDays:'за те же дни прошлого месяца',whole:'в прошлом месяце',levelSame:'На уровне тех же дней прошлого месяца',levelWhole:'На уровне прошлого месяца',noneSame:'За те же дни прошлого месяца расходов не было',noneWhole:'В прошлом месяце расходов не было'}
  const comparison=partial?words.sameDays:words.whole
  if(previous===0)return total===0?`Как и ${comparison}`:partial?words.noneSame:words.noneWhole
  const difference=Math.round(Math.abs(total-previous)/previous*100)
  if(difference===0)return partial?words.levelSame:words.levelWhole
  return `На ${difference}% ${total>previous?'больше':'меньше'}, чем ${comparison}`
}

export function fallbackAnalytics(bootstrap:Bootstrap,target:string,from:string,to:string,categoryId:string|null):AnalyticsData {
  const decimals=bootstrap.currencies.find((currency)=>currency.code===target)?.decimals??2
  const categories=new Map(bootstrap.categories.map((category)=>[category.id,category]))
  const periodExpenses=bootstrap.expenses.filter((expense)=>!expense.deletedAt&&!expense.voidedAt&&(!categoryId||expense.categoryId===categoryId)).map((expense)=>({expense,date:localDateKey(expense.occurredAt)})).filter((item)=>item.date>=from&&item.date<=to)
  const canConvert=(expense:Expense)=>hasRate(bootstrap.rates,expense.currency,target,localDateKey(expense.occurredAt))
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

// Ссылка приглашения или подключения: на телефоне главное действие — «Поделиться», сам URL человеку читать не нужно
// и он показывается только если ни копирование, ни системное меню недоступны.
function AccessLinkSheet({ link, onClose, onRevoke }: { link: { title: string; url: string; expiresAt?: string; hint?: string; revoke?: () => Promise<void> }; onClose: () => void; onRevoke: (reason: unknown) => void }) {
  const dialogRef = useDialog(onClose)
  const { confirm, confirmation } = useConfirm()
  const [feedback, setFeedback] = useState('')
  const [feedbackError, setFeedbackError] = useState(false)
  const [busy, setBusy] = useState(false)
  const canShare = typeof navigator.share === 'function'
  const copy = async () => {
    try { await copyText(link.url); setFeedbackError(false); setFeedback('Ссылка скопирована') }
    catch (reason) { setFeedbackError(true); setFeedback(reason instanceof Error ? reason.message : 'Не удалось скопировать ссылку') }
  }
  const share = async () => {
    try {
      if (canShare) { await navigator.share({ title: link.title, url: link.url }); setFeedbackError(false); setFeedback('Меню «Поделиться» открыто') }
      else await copy()
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') return
      setFeedbackError(true); setFeedback('Не удалось поделиться ссылкой')
    }
  }
  const revoke = async () => {
    if (!link.revoke || busy) return
    if (!await confirm({ title: 'Отозвать ссылку?', message: 'Ссылка сразу перестанет работать.', confirmLabel: 'Отозвать', danger: true })) return
    setBusy(true)
    try { await link.revoke() }
    catch (reason) { onRevoke(reason); setBusy(false) }
  }
  return <div className="sheet-backdrop" onMouseDown={onClose}><section ref={dialogRef} className="bottom-sheet access-sheet" role="dialog" aria-modal="true" aria-labelledby="access-link-title" onMouseDown={(event) => event.stopPropagation()}>
    <div className="sheet-handle"/><div className="sheet-title"><h2 id="access-link-title">{link.title}</h2><button type="button" className="icon-button" data-dialog-initial-focus onClick={onClose} aria-label="Закрыть">×</button></div>
    {link.hint && <p className="sheet-copy">{link.hint}</p>}
    <div className="qr"><QRCodeSVG value={link.url} size={160}/></div>
    {link.expiresAt && <p className="sheet-copy centered">{formatLinkLifetime(link.expiresAt)}</p>}
    {feedbackError && <code className="access-link">{link.url}</code>}
    {feedback && <p className="inline-feedback" role={feedbackError ? 'alert' : 'status'}>{feedback}</p>}
    {canShare
      ? <><button type="button" className="primary" onClick={() => void share()}>Поделиться</button><button type="button" className="sheet-cancel" onClick={() => void copy()}>Скопировать</button></>
      : <button type="button" className="primary" onClick={() => void copy()}>Скопировать</button>}
    {link.revoke && <button type="button" className="danger-link" disabled={busy} onClick={() => void revoke()}>{busy ? 'Отзываем…' : 'Отозвать'}</button>}
  </section>{confirmation}</div>
}

// «Ссылка действует 3 дня» вместо даты с секундами.
function formatLinkLifetime(expiresAt: string) {
  const hours = Math.round((Date.parse(expiresAt) - Date.now()) / 3_600_000)
  if (hours >= 47) { const days = Math.round(hours / 24); return `Ссылка действует ${days} ${pluralRu(days, ['день', 'дня', 'дней'])}` }
  if (hours >= 1) return `Ссылка действует ${hours} ${pluralRu(hours, ['час', 'часа', 'часов'])}`
  return 'Ссылка действует меньше часа'
}

function formatRelativeTime(iso: string) {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  if (minutes < 1) return 'только что'
  if (minutes < 60) return `${minutes} ${pluralRu(minutes, ['минуту', 'минуты', 'минут'])} назад`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} ${pluralRu(hours, ['час', 'часа', 'часов'])} назад`
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
}

// Строка настроек: слева понятие, справа значение и стрелка. Всё, что требует экрана, открывается шитом.
function SettingsRow({ label, value, tone, disabled = false, onClick }: { label: string; value?: string; tone?: 'warn' | 'danger'; disabled?: boolean; onClick?: () => void }) {
  const className = `settings-row${tone ? ` ${tone}` : ''}`
  if (!onClick) return <div className={className}><span>{label}</span>{value !== undefined && <span className="settings-row-value"><span>{value}</span></span>}</div>
  return <button type="button" className={className} disabled={disabled} onClick={() => { tap(4); onClick() }}><span>{label}</span><span className="settings-row-value">{value !== undefined && <span>{value}</span>}{tone !== 'danger' && <ChevronIcon/>}</span></button>
}

// Шит со списком (участники, устройства, категории, теги): заголовок, содержимое, при необходимости — не закрывается, пока идёт запрос.
function ListSheet({ title, onClose, dismissible = true, children }: { title: string; onClose: () => void; dismissible?: boolean; children: React.ReactNode }) {
  const dialogRef = useDialog(onClose, dismissible)
  const titleId = useId()
  return <div className="sheet-backdrop" onMouseDown={() => { if (dismissible) onClose() }}><section ref={dialogRef} className="bottom-sheet list-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(event) => event.stopPropagation()}>
    <div className="sheet-handle"/><div className="sheet-title"><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" data-dialog-initial-focus disabled={!dismissible} onClick={onClose} aria-label="Закрыть">×</button></div>
    {children}
  </section></div>
}

// Одно поле с кнопкой «Сохранить»: имена и названия правятся одинаково, без сохранения «после выхода из поля».
function TextSheet({ title, value, placeholder, maxLength = 80, onClose, onSave }: { title: string; value: string; placeholder?: string; maxLength?: number; onClose: () => void; onSave: (value: string) => Promise<void> }) {
  const [draft, setDraft] = useState(value)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dialogRef = useDialog(onClose, !busy)
  const titleId = useId()
  const submit = async () => {
    const trimmed = draft.trim()
    if (!trimmed) { setError('Поле не может быть пустым.'); return }
    if (trimmed === value) { onClose(); return }
    setBusy(true); setError('')
    try { await onSave(trimmed); onClose() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось сохранить') }
    finally { setBusy(false) }
  }
  return <div className="sheet-backdrop" onMouseDown={() => { if (!busy) onClose() }}>
    <form ref={dialogRef as React.Ref<HTMLFormElement>} className="bottom-sheet editor" role="dialog" aria-modal="true" aria-labelledby={titleId} noValidate onSubmit={(event) => { event.preventDefault(); void submit() }} onMouseDown={(event) => event.stopPropagation()}>
      <div className="sheet-handle"/>
      <div className="sheet-title"><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" disabled={busy} onClick={onClose} aria-label="Закрыть">×</button></div>
      <label>{title}<input data-dialog-initial-focus maxLength={maxLength} placeholder={placeholder} aria-invalid={Boolean(error)} value={draft} disabled={busy} onChange={(event) => { setError(''); setDraft(event.target.value) }}/></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>
    </form>
  </div>
}

type AccessSheet = 'members' | 'devices' | 'workspace-name' | 'display-name' | null

// Две группы строк — «Пространство» и «Профиль»; списки участников и устройств живут в шитах, на первом уровне только счётчик.
function AccessSettings({ user, workspace, pendingCount, online, onSession, onNotice, onBusyChange, children }: {
  user: AuthenticatedSession
  workspace: WorkspaceSummary
  pendingCount: number
  online: boolean
  onSession: (session: SessionState) => Promise<void>
  onNotice: (message: string, urgent?: boolean) => void
  onBusyChange: (busy: boolean) => void
  children?: React.ReactNode
}) {
  const [members, setMembers] = useState<import('./types').Participant[]>([])
  const [devices, setDevices] = useState<import('./types').DeviceSession[]>([])
  const [invitations, setInvitations] = useState<import('./types').InvitationMetadata[]>([])
  const [link, setLink] = useState<{ title: string; url: string; expiresAt?: string; hint?: string; revoke?: () => Promise<void> } | null>(null)
  const [recovery, setRecovery] = useState<RecoveryPrepareResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [sheet, setSheet] = useState<AccessSheet>(null)
  const { confirm, confirmation } = useConfirm()
  const owner = workspace.role === 'owner'

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
      setLoadError('Список обновится, когда появится сеть.')
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
      setLoading(false); setLoadError(reason instanceof ApiError || reason instanceof Error ? reason.message : 'Не удалось загрузить список.')
    }
  }, [online, workspace.id, workspace.role])

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
        title: 'Приглашение', url: result.url, expiresAt: result.invitation.expiresAt, hint: `Отправьте ссылку человеку, которого зовёте в «${workspace.name}».`,
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
      setLink({ title: 'Открыть на другом устройстве', url: result.url, expiresAt: result.deviceLink.expiresAt, hint: 'Откройте ссылку или QR на другом телефоне или компьютере — там появится этот же профиль.' })
    } catch (reason) { showError(reason, 'Не удалось создать ссылку') }
    finally { setBusyAction(null) }
  }

  const rotateRecovery = async () => {
    if (busyAction) return
    if (user.user.recoveryConfigured && !await confirm({ title: 'Заменить ссылку доступа?', message: 'Старая ссылка перестанет работать, как только вы подтвердите новую. Сначала убедитесь, что сможете сохранить новую.', confirmLabel: 'Заменить', danger: true })) return
    setBusyAction('recovery')
    try { setRecovery(await prepareInitialOrManualRecovery()) }
    catch (reason) { showError(reason, 'Не удалось подготовить ссылку доступа') }
    finally { setBusyAction(null) }
  }

  const completeRotation = async (): Promise<void> => {
    if (!recovery) return
    const outcome = await completeRotationSafely({ prepared: recovery, targetUserId: user.user.id })
    if (outcome.status !== 'completed') {
      if (outcome.status === 'rotation-stale') throw new Error('Параллельно была сохранена другая ссылка. Используйте последнюю подтверждённую.')
      throw new Error('Не удалось подтвердить новую ссылку. Не удаляйте предыдущую, пока не повторите.')
    }
    await onSession(outcome.session)
    onNotice('Ссылка доступа сохранена')
  }

  const runAction = async (key: string, action: () => Promise<void>, fallback: string, success?: string) => {
    if (busyAction) return
    setBusyAction(key)
    try { await action(); if (success) onNotice(success) }
    catch (reason) { showError(reason, fallback) }
    finally { setBusyAction(null) }
  }

  const saveWorkspaceName = async (name: string) => {
    await renameWorkspace(workspace.id, name, workspace.version)
    await onSession(await getSession())
  }
  const saveDisplayName = async (name: string) => {
    await updateProfile(name)
    await onSession(await getSession())
  }

  const otherDevices = devices.filter((item) => !item.current)
  const busy = Boolean(busyAction)
  const listState = loading
    ? <p className="management-state" role="status">Загружаем…</p>
    : loadError ? <p className="management-state" role="status"><span>{loadError}</span>{online && <button type="button" onClick={() => void refresh()}>Повторить</button>}</p> : null
  return <>
    <div className="settings-list" role="group" aria-labelledby="settings-space"><h2 id="settings-space">Пространство</h2><div className="settings-rows">
      <SettingsRow label="Название пространства" value={workspace.name} onClick={owner ? () => setSheet('workspace-name') : undefined} disabled={!online}/>
      <SettingsRow label="Участники" value={loading ? '…' : owner ? `${members.length} · пригласить` : String(members.length)} onClick={() => setSheet('members')}/>
      {children}
    </div></div>
    <div className="settings-list" role="group" aria-labelledby="settings-profile"><h2 id="settings-profile">Профиль</h2><div className="settings-rows">
      <SettingsRow label="Ваше имя" value={user.user.displayName} onClick={() => setSheet('display-name')} disabled={!online}/>
      <SettingsRow label="Ссылка доступа" value={busyAction === 'recovery' ? 'Готовим…' : user.user.recoveryConfigured ? 'сохранена' : 'не сохранена'} tone={user.user.recoveryConfigured ? undefined : 'warn'} onClick={() => void rotateRecovery()} disabled={!online || busy}/>
      <SettingsRow label="Другие устройства" value={loading ? '…' : otherDevices.length ? String(otherDevices.length) : 'нет'} onClick={() => setSheet('devices')}/>
    </div></div>
    {sheet === 'workspace-name' && <TextSheet title="Название пространства" value={workspace.name} placeholder="Например, Дом или Поездка" onClose={() => setSheet(null)} onSave={saveWorkspaceName}/>}
    {sheet === 'display-name' && <TextSheet title="Ваше имя" value={user.user.displayName} onClose={() => setSheet(null)} onSave={saveDisplayName}/>}
    {sheet === 'members' && <ListSheet title="Участники" dismissible={!busy} onClose={() => setSheet(null)}>
      {listState}
      {members.map((member) => <div className="management-row" key={member.userId}>
        <span>{member.displayName}<small>{member.role === 'owner' ? 'Владелец' : 'Участник'}{member.isCurrentUser ? ' · это вы' : ''}</small></span>
        {owner && !member.isCurrentUser && <span>
          <button type="button" disabled={!online || busy} onClick={() => void (async () => {
            if (!await confirm({ title: 'Передать владение?', message: `${member.displayName} станет владельцем пространства, а вы — участником.`, confirmLabel: 'Передать', danger: true })) return
            await runAction(`transfer-${member.userId}`, async () => { await transferOwnership(workspace.id, member.userId, workspace.version); await onSession(await getSession()) }, 'Не удалось передать владение', 'Владение передано')
          })()}>Передать</button>
          <button type="button" disabled={!online || busy} onClick={() => void (async () => {
            if (!await confirm({ title: 'Удалить участника?', message: 'Доступ к пространству прекратится, но уже скачанные на его устройства данные стереть удалённо нельзя.', confirmLabel: 'Удалить', danger: true })) return
            await runAction(`remove-${member.userId}`, async () => { await removeMember(workspace.id, member.userId); await refresh() }, 'Не удалось удалить участника', 'Участник удалён')
          })()}>Удалить</button>
        </span>}
      </div>)}
      {owner && invitations.map((item) => <div className="management-row" key={item.id}><span>Приглашение<small>{formatLinkLifetime(item.expiresAt).replace('Ссылка действует', 'действует ещё')}</small></span><button type="button" disabled={!online || busy} onClick={() => void (async () => { if (!await confirm({ title: 'Отозвать приглашение?', message: 'Ссылка сразу перестанет работать.', confirmLabel: 'Отозвать', danger: true })) return; await runAction(`invite-${item.id}`, async () => { await revokeInvitation(workspace.id, item.id); await refresh() }, 'Не удалось отозвать приглашение', 'Приглашение отозвано') })()}>{busyAction === `invite-${item.id}` ? 'Отзываем…' : 'Отозвать'}</button></div>)}
      {owner
        ? <button type="button" className="primary sheet-action" disabled={!online || busy} onClick={() => void invite()}>{busyAction === 'invite' ? 'Создаём приглашение…' : 'Пригласить человека'}</button>
        : <button type="button" className="danger-link sheet-action" disabled={!online || busy} onClick={() => {
          const warning = pendingCount ? `Неотправленные изменения (${pendingCount}) пропадут вместе с данными пространства на этом телефоне.` : 'Пространство исчезнет с этого телефона. Вернуться в него можно только по новому приглашению.'
          void (async () => {
            if (!await confirm({ title: 'Выйти из пространства?', message: warning, confirmLabel: 'Выйти', danger: true })) return
            await runAction('leave', async () => { await leaveWorkspace(workspace.id); await clearWorkspaceOfflineData(user.user.id, workspace.id); await onSession(await getSession()) }, 'Не удалось выйти из пространства')
          })()
        }}>Выйти из пространства</button>}
    </ListSheet>}
    {sheet === 'devices' && <ListSheet title="Другие устройства" dismissible={!busy} onClose={() => setSheet(null)}>
      {listState}
      {otherDevices.map((deviceItem) => <div className="management-row" key={deviceItem.id}>
        <span>{deviceItem.label}<small>Был в сети {formatRelativeTime(deviceItem.lastSeenAt)}</small></span>
        <button type="button" disabled={!online || busy} onClick={() => void (async () => { if (!await confirm({ title: 'Отключить устройство?', message: `На устройстве «${deviceItem.label}» придётся войти заново.`, confirmLabel: 'Отключить', danger: true })) return; await runAction(`device-${deviceItem.id}`, async () => { await revokeSession(deviceItem.id); await refresh() }, 'Не удалось отключить устройство', 'Устройство отключено') })()}>{busyAction === `device-${deviceItem.id}` ? 'Отключаем…' : 'Отключить'}</button>
      </div>)}
      {!loading && !loadError && !otherDevices.length && <p className="sheet-copy">Пока этот профиль открыт только здесь.</p>}
      <button type="button" className="primary sheet-action" disabled={!online || busy} onClick={() => void device()}>{busyAction === 'device' ? 'Готовим ссылку…' : 'Открыть на другом устройстве'}</button>
    </ListSheet>}
    {link && <AccessLinkSheet link={link} onClose={() => setLink(null)} onRevoke={(reason) => showError(reason, 'Не удалось отозвать ссылку')}/>}
    {recovery && <RecoverySave key={recovery.completionToken} prepared={recovery} mode={user.user.recoveryConfigured ? 'rotation' : 'initial'} close={() => setRecovery(null)} complete={completeRotation}/>}
    {confirmation}
  </>
}

const bybitRegions: Array<{id:BybitRegion;label:string}> = [
  {id:'global',label:'Global / Serbia'}, {id:'eu',label:'European Union'}, {id:'kz',label:'Kazakhstan'},
  {id:'ge',label:'Georgia'}, {id:'ae',label:'UAE'}, {id:'tr',label:'Turkey'}, {id:'nl',label:'Netherlands'}, {id:'id',label:'Indonesia'},
]

// Карта Bybit в шите: одна строка состояния, одна кнопка «Обновить», «Отключить» — текстом внизу.
function BybitSheet({ workspace, workspaceId, status, online, onStatus, onSynced=()=>{}, onClose }: { workspace:WorkspaceSummary;workspaceId:string;status:BybitCardStatus|null;online:boolean;onStatus:(status:BybitCardStatus)=>void;onSynced?:()=>void;onClose:()=>void }) {
  const [editing,setEditing]=useState(false)
  const [apiKey,setApiKey]=useState('')
  const [apiSecret,setApiSecret]=useState('')
  const [region,setRegion]=useState<BybitRegion>('global')
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const [feedback,setFeedback]=useState('')
  const {confirm,confirmation}=useConfirm()
  const manage=workspace.role==='owner'&&status?.canManage!==false
  const connect=async(event:React.FormEvent)=>{
    event.preventDefault();if(!apiKey.trim()||!apiSecret.trim())return setError('Введите API key и secret.')
    setBusy(true);setError('')
    try{
      const next=await connectBybitCard(workspaceId,apiKey.trim(),apiSecret.trim(),region)
      onStatus(next);setApiKey('');setApiSecret('');setEditing(false)
    }catch(reason){setError(reason instanceof ApiError?reason.message:'Не удалось подключить карту')}
    finally{setBusy(false)}
  }
  // Сервер не ходит в Bybit чаще раза в минуту; кнопка обязана сказать об этом, иначе нажатие выглядит сломанным.
  const sync=async()=>{
    setBusy(true);setError('');setFeedback('')
    try{
      const result=await syncBybitCard(workspaceId);onStatus(result);onSynced()
      setFeedback(result.throttled?'Уже актуально: обновлялось меньше минуты назад':result.imported?`Новых операций: ${result.imported}`:'Новых операций нет')
    }catch(reason){setError(reason instanceof ApiError?reason.message:'Не удалось обновить операции')}
    finally{setBusy(false)}
  }
  const disconnect=async()=>{
    if(!await confirm({title:'Отключить карту?',message:'Неразобранные операции пропадут. Уже сохранённые расходы останутся в истории.',confirmLabel:'Отключить',danger:true}))return
    setBusy(true);setError('')
    try{await disconnectBybitCard(workspaceId);onStatus({connected:false,canManage:true,pendingCount:0});setEditing(false)}
    catch(reason){setError(reason instanceof ApiError?reason.message:'Не удалось отключить карту')}
    finally{setBusy(false)}
  }
  const state=status===null?'Проверяем подключение…':status.connected?status.status==='error'?'Подключена · нужно обновить':status.lastSyncedAt?`Подключена · обновлено ${formatRelativeTime(status.lastSyncedAt)}`:'Подключена':'Не подключена'
  return <ListSheet title="Карта Bybit" dismissible={!busy} onClose={onClose}>
    <div className="integration-title"><span className="bybit-mark">B</span><span><b>Bybit Card</b><small>{state}</small></span>{status?.connected&&<i className={status.status==='error'?'error':'active'}/>}</div>
    {status?.connected?<>
      <p className="sheet-copy">Платежи попадают в историю начиная с {new Date(status.enabledAt!).toLocaleDateString('ru-RU',{day:'numeric',month:'long'})}. Более ранние не загружаются.</p>
      {status.lastError&&<p className="form-error" role="alert">{status.lastError}</p>}
      <button type="button" className="primary sheet-action" disabled={!online||busy} onClick={()=>void sync()}>{busy?'Обновляем…':'Обновить'}</button>
      {feedback&&<p className="inline-feedback" role="status">{feedback}</p>}
      {manage&&<button type="button" className="danger-link sheet-action" disabled={!online||busy} onClick={()=>void disconnect()}>Отключить</button>}
    </>:manage?<>
      <p className="sheet-copy">Платежи по карте будут появляться в истории сами — останется выбрать категорию. Загружаются только платежи после подключения. Нужен отдельный ключ только для чтения с разрешением BitCard.</p>
      {!editing?<button type="button" className="primary sheet-action" disabled={!online||status===null} onClick={()=>setEditing(true)}>Подключить</button>:<form className="integration-form" onSubmit={(event)=>void connect(event)}>
        <label>Регион аккаунта<Select label="Регион аккаунта" value={region} disabled={busy} onChange={(value)=>setRegion(value as BybitRegion)} options={bybitRegions.map((item)=>({value:item.id,label:item.label}))}/></label>
        {region==='eu'&&<small className="integration-meta">Для EU Bybit требует ключ, созданный через Connect to Third-Party Applications.</small>}
        <label>API key<input autoComplete="off" value={apiKey} disabled={busy} maxLength={256} onChange={(event)=>setApiKey(event.target.value)}/></label>
        <label>API secret<input type="password" autoComplete="new-password" value={apiSecret} disabled={busy} maxLength={512} onChange={(event)=>setApiSecret(event.target.value)}/></label>
        <button className="primary" disabled={busy||!online}>{busy?'Проверяем ключ…':'Подключить'}</button><button type="button" className="sheet-cancel" disabled={busy} onClick={()=>{setEditing(false);setError('')}}>Отмена</button>
      </form>}
    </>:<p className="sheet-copy">Подключить карту может владелец пространства.</p>}
    {error&&<p className="form-error" role="alert">{error}</p>}
    {confirmation}
  </ListSheet>
}

type ReviewAction={transaction:BybitCardTransaction;expense?:Expense;categoryId?:string;comment:string;tagIds:string[]}

export function BybitReviewView({ workspaceId, categories, currencies, tags=[], onTag=()=>{}, online, onExpense, onExpenseUndo, onStatus, pendingCount=0, active=true }: {workspaceId:string;categories:Category[];currencies:Currency[];tags?:Tag[];onTag?:(tag:Tag)=>void;online:boolean;onExpense:(expense:Expense)=>void;onExpenseUndo:(expenseId:string)=>void;onStatus:(status:Partial<BybitCardStatus>&Pick<BybitCardStatus,'pendingCount'>)=>void;pendingCount?:number;active?:boolean}) {
  const [items,setItems]=useState<BybitCardTransaction[]>([])
  const [comment,setComment]=useState('')
  const [noteSheet,setNoteSheet]=useState(false)
  const [selectedCategoryId,setSelectedCategoryId]=useState<string|null>(null)
  const [categorySheet,setCategorySheet]=useState(false)
  const [selectedTagIds,setSelectedTagIds]=useState<string[]>([])
  const [loading,setLoading]=useState(true)
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const {toast:notice,notify,dismiss}=useToast()
  const {confirm,confirmation}=useConfirm()
  const current=items[0]
  // Ряд категорий повторяет расход: основные плитками, остальные — в шите за «Ещё N».
  const main=categories.filter((item)=>!item.archivedAt&&item.placement==='main').sort((a,b)=>a.sortOrder-b.sortOrder)
  const additional=categories.filter((item)=>!item.archivedAt&&item.placement==='additional').sort((a,b)=>a.sortOrder-b.sortOrder)
  useEffect(()=>{const controller=new AbortController();setLoading(true);listBybitCardTransactions(workspaceId,controller.signal).then((result)=>{setItems(result.transactions);onStatus({pendingCount:result.pendingCount})}).catch((reason)=>{if(!controller.signal.aborted)setError(reason instanceof ApiError?reason.message:'Не удалось загрузить операции')}).finally(()=>{if(!controller.signal.aborted)setLoading(false)});return()=>controller.abort()},[workspaceId]) // eslint-disable-line react-hooks/exhaustive-deps
  // A sync elsewhere (Settings, the server scheduler) can add or settle items while this view is mounted.
  // Re-read the queue when the tab is opened or the known count outgrows what is loaded, merging so the
  // item under review, the local order and the draft note survive; only the server's newest state wins per item.
  const refreshing=useRef(false)
  useEffect(()=>{
    if(loading||busy||!online||!active||refreshing.current)return
    const controller=new AbortController();refreshing.current=true
    listBybitCardTransactions(workspaceId,controller.signal).then((result)=>{
      if(controller.signal.aborted)return
      const fresh=new Map(result.transactions.map((item)=>[item.id,item]))
      setItems((value)=>{const kept=value.filter((item)=>fresh.has(item.id)).map((item)=>fresh.get(item.id)!);const seen=new Set(kept.map((item)=>item.id));return [...kept,...result.transactions.filter((item)=>!seen.has(item.id))]})
      onStatus({pendingCount:result.pendingCount})
    }).catch(()=>{/* the queue already on screen stays usable; the next trigger retries */}).finally(()=>{refreshing.current=false})
    return()=>{controller.abort();refreshing.current=false}
  },[active,pendingCount,workspaceId]) // eslint-disable-line react-hooks/exhaustive-deps
  const resetDraft=()=>{setComment('');setSelectedCategoryId(null);setSelectedTagIds([]);setCategorySheet(false);setNoteSheet(false)}
  const removeCurrent=(transaction:BybitCardTransaction,pendingCount:number)=>{setItems((value)=>value.filter((item)=>item.id!==transaction.id));resetDraft();onStatus({pendingCount})}
  const undo=async(action:ReviewAction)=>{
    if(busy||!online)return;setBusy(true);setError('')
    try{const result=await undoBybitCardTransaction(workspaceId,action.transaction.id,action.expense);if(result.undoneExpenseId)onExpenseUndo(result.undoneExpenseId);setItems((value)=>[result.transaction,...value.filter((item)=>item.id!==result.transaction.id)]);setComment(action.comment);setSelectedCategoryId(action.categoryId??null);setSelectedTagIds(action.tagIds);onStatus({pendingCount:result.pendingCount});tap(6)}
    catch(reason){setError(reason instanceof ApiError?reason.message:'Не удалось отменить последнее действие')}
    finally{setBusy(false)}
  }
  const classify=async(categoryId:string)=>{
    if(!current||busy||!online)return;const transaction=current;const action:ReviewAction={transaction,categoryId,comment,tagIds:selectedTagIds};setSelectedCategoryId(categoryId);setBusy(true);setError('')
    try{const result=await classifyBybitCardTransaction(workspaceId,transaction.id,categoryId,comment,selectedTagIds);action.expense=result.expense;onExpense(result.expense);removeCurrent(transaction,result.pendingCount);notify('Расход добавлен',{label:'Отменить',run:()=>void undo(action)});tap(8)}
    catch(reason){setError(reason instanceof ApiError?reason.message:'Не удалось сохранить расход')}
    finally{setBusy(false)}
  }
  const ignore=async()=>{
    if(!current||busy||!online||!await confirm({title:'Это не расход?',message:'Операция исчезнет из очереди и не попадёт в историю. Сразу после этого её можно вернуть.',confirmLabel:'Это не расход',danger:true}))return
    const transaction=current;const action:ReviewAction={transaction,comment,categoryId:selectedCategoryId??undefined,tagIds:selectedTagIds};setBusy(true);setError('');try{const result=await ignoreBybitCardTransaction(workspaceId,transaction.id);removeCurrent(transaction,result.pendingCount);notify('Операция не записана как расход',{label:'Вернуть',run:()=>void undo(action)})}catch(reason){setError(reason instanceof ApiError?reason.message:'Не удалось пропустить операцию')}finally{setBusy(false)}
  }
  // «Пропустить» просто ставит операцию в конец очереди: отдельного понятия «отложено» нет.
  const skip=()=>{if(!current||busy||items.length<2)return;setItems((value)=>[...value.slice(1),value[0]!]);resetDraft();tap(5)}
  const save=current?saveButtonLabel({amount:String(current.amountMinor/10**(currencies.find((item)=>item.code===current.currency)?.decimals??2)),currency:current.currency,categoryId:selectedCategoryId,editing:false,dirty:true,currencies}):null
  return <><section className="page bybit-review-page" aria-labelledby="bybit-review-title">
    <h1 className="sr-only" id="bybit-review-title">Операции с карты Bybit</h1>
    {loading?<p className="management-state" role="status">Загружаем операции…</p>:current?(()=>{const amountText=amountNumber(current.amountMinor,current.currency,currencies);return <>
      <header className="topline review-topline"><div><p className="eyebrow">В очереди · {items.length}</p><p className="review-date">{new Date(current.occurredAt).toLocaleString('ru-RU',{weekday:'short',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'})}</p></div></header>
      <div className="amount-row"><output className="amount-value" data-size={amountSize(amountText)} aria-label="Сумма">{amountText}</output><span className="review-currency">{current.currency}</span></div>
      <div className="review-scroll">
      {/* Мерчант и предупреждение делят слот постоянной высоты: очередь разбирают пачкой, и
          кнопка сохранения не должна ездить от операции к операции. */}
      <div className="review-operation">
        <article className="review-merchant">
          <span className="bybit-mark">B</span><div><h3>{current.merchantName||'Без названия продавца'}</h3><p>{current.type==='atm'?'Снятие наличных':current.merchantCategory||'Покупка'}{current.merchantCity?` · ${[current.merchantCity,current.merchantCountry].filter(Boolean).join(', ')}`:''}</p></div>
        </article>
        {!current.settled&&<p className="review-pending-note">Ожидает списания · сумма может уточниться после расчёта</p>}
      </div>
      <CategoryTiles main={main} additional={additional} selectedId={selectedCategoryId} disabled={busy} onPick={(category)=>{tap(6);setSelectedCategoryId(category.id);setCategorySheet(false)}} onMore={()=>setCategorySheet(true)}/>
      <ExtrasRow tags={tags} selected={selectedTagIds} note={comment} disabled={busy} online={online} onChange={setSelectedTagIds} onNote={()=>setNoteSheet(true)} onCreate={(name)=>createTagOrReuse(workspaceId,name,TAG_COLORS[tags.length%TAG_COLORS.length]??null,onTag)}/>
      </div>
      <button type="button" className="primary review-save" disabled={busy||!online||!save?.canSave} onClick={()=>{if(selectedCategoryId)void classify(selectedCategoryId)}}>{busy?'Сохраняем…':save?.label}</button>
      <div className="review-secondary"><button type="button" disabled={busy||items.length<2} onClick={skip}>Пропустить</button><button type="button" disabled={busy||!online} onClick={()=>void ignore()}>Это не расход</button></div>
      {categorySheet&&<CategorySheet categories={additional} selectedId={selectedCategoryId??undefined} onClose={()=>setCategorySheet(false)} onPick={(category)=>{setSelectedCategoryId(category.id);setCategorySheet(false)}}/>}
      {noteSheet&&<NoteSheet value={comment} onClose={()=>setNoteSheet(false)} onSave={(note)=>{setComment(note);setNoteSheet(false)}}/>}
    </>})():<div className="review-done"><span>✓</span><h3>Всё разобрано</h3><p>Новые операции появятся после следующего обновления.</p></div>}
    {!online&&<p className="management-state" role="status">Без сети можно только просматривать операции. Категория сохранится после подключения.</p>}
    {error&&<p className="form-error" role="alert">{error}</p>}
  </section>{notice&&<Toast toast={notice} onDismiss={dismiss}/>} {confirmation}</>
}

// Порядок в списке меняется перетаскиванием за ручку ≡ (или стрелками с клавиатуры) — вместо двух стрелок на каждую строку.
// На iOS ручке нужен touch-action: none, иначе Safari отдаёт жест прокрутке и обрывает указатель.
function DragList<T extends { id: string }>({ items, disabled = false, onReorder, render }: { items: T[]; disabled?: boolean; onReorder: (ids: string[]) => void; render: (item: T) => React.ReactNode }) {
  const [order, setOrder] = useState<string[] | null>(null)
  const [drag, setDrag] = useState<{ id: string; pointerY: number } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const grabOffset = useRef(0)
  const shown = order ? order.map((id) => items.find((item) => item.id === id)).filter((item): item is T => Boolean(item)) : items
  const rowOf = (id: string) => Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-drag-id]') ?? []).find((row) => row.dataset.dragId === id) ?? null
  // Поднятая строка следует за пальцем; её место в списке уже поменялось, поэтому сдвиг считается от новой позиции в раскладке.
  useLayoutEffect(() => {
    if (!drag) return
    const row = rowOf(drag.id)
    const list = listRef.current
    if (!row || !list) return
    row.style.transform = `translateY(${drag.pointerY - (list.getBoundingClientRect().top + row.offsetTop + grabOffset.current)}px)`
  }, [drag, order])
  const start = (event: React.PointerEvent<HTMLElement>, id: string) => {
    if (disabled || event.button !== 0) return
    const row = rowOf(id)
    if (!row) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    grabOffset.current = event.clientY - row.getBoundingClientRect().top
    setOrder(items.map((item) => item.id))
    setDrag({ id, pointerY: event.clientY })
  }
  const move = (event: React.PointerEvent) => {
    if (!drag) return
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-drag-id]') ?? []).filter((row) => row.dataset.dragId !== drag.id)
    // Новая позиция — число чужих строк, середину которых палец уже прошёл.
    let index = 0
    for (const row of rows) { const rect = row.getBoundingClientRect(); if (event.clientY > rect.top + rect.height / 2) index += 1 }
    setOrder((current) => {
      if (!current) return current
      const without = current.filter((id) => id !== drag.id)
      const next = [...without.slice(0, index), drag.id, ...without.slice(index)]
      return next.every((id, at) => id === current[at]) ? current : next
    })
    setDrag({ id: drag.id, pointerY: event.clientY })
  }
  const end = (commit: boolean) => {
    if (!drag) return
    const row = rowOf(drag.id)
    if (row) row.style.transform = ''
    const next = order
    setDrag(null); setOrder(null)
    if (commit && next && next.some((id, at) => id !== items[at]?.id)) onReorder(next)
  }
  const keyMove = (event: React.KeyboardEvent, id: string) => {
    const direction = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
    if (!direction || disabled) return
    event.preventDefault()
    const ids = items.map((item) => item.id)
    const index = ids.indexOf(id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= ids.length) return
    ;[ids[index], ids[target]] = [ids[target]!, ids[index]!]
    onReorder(ids)
  }
  return <div ref={listRef} className={`drag-list${drag ? ' dragging' : ''}`}>{shown.map((item) => <div key={item.id} data-drag-id={item.id} className={`drag-row${drag?.id === item.id ? ' lifted' : ''}`}>
    {render(item)}
    {items.length > 1 && <span className="drag-handle" role="button" tabIndex={disabled ? -1 : 0} aria-label="Перетащить, чтобы изменить порядок" aria-disabled={disabled} onPointerDown={(event) => start(event, item.id)} onPointerMove={move} onPointerUp={() => end(true)} onPointerCancel={() => end(false)} onKeyDown={(event) => keyMove(event, item.id)}>≡</span>}
  </div>)}</div>
}

type ThemePreference = 'system' | 'light' | 'dark'
const THEME_OPTIONS: SelectOption[] = [{ value: 'system', label: 'Как в системе' }, { value: 'light', label: 'Светлая' }, { value: 'dark', label: 'Тёмная' }]

// Экспорт CSV живёт в настройках: это действие раз в квартал, а не при каждом просмотре истории.
export function exportHistoryCsv(bootstrap: Bootstrap) {
  const expenses = bootstrap.expenses.filter((item) => !item.deletedAt).sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
  const blob = new Blob(['﻿', buildHistoryCsv(expenses, bootstrap.categories, bootstrap.currencies, bootstrap.tags ?? [])], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `moapp-history-${localDateKey(new Date())}.csv`
  link.hidden = true
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
  return expenses.length
}

type SettingsSheet = 'categories' | 'tags' | 'bybit' | 'theme' | null

// Настройки — плоский список в три группы: «что это за пространство», «кто я», «что на этом телефоне».
// Без сегментов и вложенных заголовков: строка = одно понятие, всё, что требует экрана, открывается шитом.
export function SettingsView({ user, workspace, workspaceId, bootstrap, setBootstrap, pendingCount, refreshPending, onLogout, theme, onThemeChange, onSession, online, bybitStatus=null, onBybitStatus=()=>{}, onBybitSynced=()=>{} }: { user: AuthenticatedSession; workspace:WorkspaceSummary; workspaceId:string; bootstrap:Bootstrap; setBootstrap:React.Dispatch<React.SetStateAction<Bootstrap>>; pendingCount:number; refreshPending:()=>void;onLogout:()=>void;theme:ThemePreference;onThemeChange:(theme:ThemePreference)=>void;onSession:(session:SessionState)=>Promise<void>;online:boolean;bybitStatus?:BybitCardStatus|null;onBybitStatus?:(status:BybitCardStatus)=>void;onBybitSynced?:()=>void }) {
  const [sheet,setSheet]=useState<SettingsSheet>(null)
  const [editing,setEditing]=useState<Category|null>(null)
  const [adding,setAdding]=useState(false)
  const [reordering,setReordering]=useState(false)
  const [editingTag,setEditingTag]=useState<Tag|null>(null)
  const [addingTag,setAddingTag]=useState(false)
  const [accessBusy,setAccessBusy]=useState(false)
  const {toast:notice,notify:setNotice,dismiss:hideNotice}=useToast()
  const accessNotice=useCallback((message:string,urgent=false)=>setNotice(message,undefined,urgent),[setNotice])
  const save=async(category:Category)=>{
    const previous=bootstrap.categories.find((item)=>item.id===category.id)
    const matchesOptimistic=(item:Category)=>item.version===category.version&&item.updatedAt===category.updatedAt&&item.name===category.name&&item.color===category.color&&item.placement===category.placement&&item.sortOrder===category.sortOrder&&item.archivedAt===category.archivedAt
    setBootstrap((b)=>({...b,categories:[category,...b.categories.filter((x)=>x.id!==category.id)]}))
    try{
      const saved=previous?await updateCategory(workspaceId,category.id,category):await createCategory(workspaceId,category)
      setBootstrap((b)=>({...b,categories:b.categories.map((x)=>x.id===category.id&&matchesOptimistic(x)?saved:x)}))
      setEditing(null);setAdding(false);setNotice(category.archivedAt?'Категория скрыта':'Категория сохранена')
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
  const activeCategories=bootstrap.categories.filter((x)=>!x.archivedAt).sort((a,b)=>a.placement.localeCompare(b.placement)||a.sortOrder-b.sortOrder)
  const mainCategories=activeCategories.filter((x)=>x.placement==='main')
  const otherCategories=activeCategories.filter((x)=>x.placement==='additional')
  // Порядок внутри одной группы: сервер принимает полный список активных категорий, поэтому вторая группа идёт как есть.
  const reorderGroup=async(placement:Category['placement'],ids:string[])=>{
    if(!online||reordering)return
    setReordering(true)
    const previousOrder=new Map(activeCategories.map((item)=>[item.id,item.sortOrder]))
    const optimisticOrder=new Map(ids.map((id,order)=>[id,order]))
    const ordered=placement==='main'?[...ids,...otherCategories.map((x)=>x.id)]:[...mainCategories.map((x)=>x.id),...ids]
    setBootstrap((b)=>({...b,categories:b.categories.map((x)=>optimisticOrder.has(x.id)?{...x,sortOrder:optimisticOrder.get(x.id)!}:x)}))
    try{
      const result=await reorderCategories(workspaceId,ordered);const fresh=new Map(result.categories.map((x)=>[x.id,x]))
      setBootstrap((b)=>({...b,categories:b.categories.map((x)=>optimisticOrder.get(x.id)===x.sortOrder?(fresh.get(x.id)||x):x)}))
    }catch(error){
      setBootstrap((b)=>({...b,categories:b.categories.map((x)=>optimisticOrder.get(x.id)===x.sortOrder?{...x,sortOrder:previousOrder.get(x.id)!}:x)}))
      setNotice(error instanceof ApiError?error.message:'Не удалось изменить порядок',undefined,true)
    }
    refreshPending()
    setReordering(false)
  }
  const tags=sortTags(bootstrap.tags??[])
  const saveTag=async(name:string,color:string|null)=>{
    try{
      const saved=editingTag?await updateTag(workspaceId,editingTag.id,{name,color,version:editingTag.version}):await createTag(workspaceId,{name,color})
      setBootstrap((b)=>({...b,tags:[saved,...(b.tags??[]).filter((x)=>x.id!==saved.id)]}))
      setEditingTag(null);setAddingTag(false);setNotice(editingTag?'Тег сохранён':'Тег создан')
    }catch(error){
      setNotice(error instanceof ApiError?error.code==='DUPLICATE'?'Тег с таким названием уже есть':error.message:'Не удалось сохранить тег',undefined,true)
    }
    refreshPending()
  }
  const removeTag=async(tag:Tag)=>{
    try{
      await deleteTag(workspaceId,tag.id,tag.version)
      setBootstrap((b)=>({...b,tags:(b.tags??[]).filter((x)=>x.id!==tag.id),expenses:b.expenses.map((x)=>x.tagIds?.includes(tag.id)?{...x,tagIds:x.tagIds.filter((id)=>id!==tag.id)}:x)}))
      setEditingTag(null);setNotice('Тег удалён')
    }catch(error){setNotice(error instanceof ApiError?error.message:'Не удалось удалить тег',undefined,true)}
  }
  const reorderTagList=async(ids:string[])=>{
    if(!online||reordering)return
    setReordering(true)
    const previous=new Map(tags.map((x)=>[x.id,x.sortOrder]))
    setBootstrap((b)=>({...b,tags:(b.tags??[]).map((x)=>{const at=ids.indexOf(x.id);return at>=0?{...x,sortOrder:at}:x})}))
    try{const result=await reorderTags(workspaceId,ids);setBootstrap((b)=>({...b,tags:result.tags}))}
    catch(error){setBootstrap((b)=>({...b,tags:(b.tags??[]).map((x)=>previous.has(x.id)?{...x,sortOrder:previous.get(x.id)!}:x)}));setNotice(error instanceof ApiError?error.message:'Не удалось изменить порядок тегов',undefined,true)}
    setReordering(false)
  }
  const bybitValue=bybitStatus===null?(online?'…':'нужна сеть'):bybitStatus.connected?(bybitStatus.status==='error'?'нужно обновить':'подключена'):'не подключена'
  const categoryRow=(category:Category)=><><i style={{background:category.color??'#a9afa5'}}/><button type="button" className="category-name" disabled={!online||reordering} onClick={()=>setEditing(category)}>{category.name}</button></>
  return <section className="page settings-page">
    <AccessSettings user={user} workspace={workspace} pendingCount={pendingCount} online={online} onSession={onSession} onNotice={accessNotice} onBusyChange={setAccessBusy}>
      <SettingsRow label="Категории" value={String(activeCategories.length)} onClick={()=>setSheet('categories')}/>
      <SettingsRow label="Теги" value={tags.length?String(tags.length):'нет'} onClick={()=>setSheet('tags')}/>
      <SettingsRow label="Карта Bybit" value={bybitValue} onClick={()=>setSheet('bybit')}/>
    </AccessSettings>
    <div className="settings-list" role="group" aria-labelledby="settings-device"><h2 id="settings-device">Этот телефон</h2><div className="settings-rows">
      <SettingsRow label="Тема" value={THEME_OPTIONS.find((option)=>option.value===theme)?.label} onClick={()=>setSheet('theme')}/>
      <SettingsRow label="Экспорт в CSV" onClick={()=>{try{setNotice(`Экспортировано расходов: ${exportHistoryCsv(bootstrap)}`)}catch{setNotice('Не удалось подготовить файл экспорта',undefined,true)}}}/>
      <SettingsRow label="Выйти" tone="danger" disabled={accessBusy||reordering} onClick={onLogout}/>
    </div></div>
    {sheet==='categories'&&<ListSheet title="Категории" onClose={()=>setSheet(null)}>
      {mainCategories.length>0&&<h3>На главном экране</h3>}
      <DragList items={mainCategories} disabled={!online||reordering} onReorder={(ids)=>void reorderGroup('main',ids)} render={categoryRow}/>
      {otherCategories.length>0&&<h3>{mainCategories.length?'За плиткой «Ещё»':'Категории'}</h3>}
      <DragList items={otherCategories} disabled={!online||reordering} onReorder={(ids)=>void reorderGroup('additional',ids)} render={categoryRow}/>
      {!activeCategories.length&&<p className="sheet-copy">Категорий пока нет.</p>}
      <p className="sheet-copy">{online?'Порядок меняется перетаскиванием за ≡. Скрытые категории остаются у старых расходов.':'Категории меняются только при подключении к сети.'}</p>
      <button type="button" className="primary sheet-action" disabled={!online} onClick={()=>setAdding(true)}>Новая категория</button>
    </ListSheet>}
    {sheet==='tags'&&<ListSheet title="Теги" onClose={()=>setSheet(null)}>
      <DragList items={tags} disabled={!online||reordering} onReorder={(ids)=>void reorderTagList(ids)} render={(tag)=><><i style={{background:tag.color??'#a9afa5'}}/><button type="button" className="category-name" disabled={!online||reordering} onClick={()=>setEditingTag(tag)}>{tag.name}</button></>}/>
      <p className="sheet-copy">{tags.length?'Тег — короткая пометка поверх категории, например «отпуск». Один расход может нести несколько тегов.':'Тегов пока нет. Тег — короткая пометка поверх категории, например «отпуск» или «вдвоём».'}</p>
      <button type="button" className="primary sheet-action" disabled={!online} onClick={()=>setAddingTag(true)}>Новый тег</button>
    </ListSheet>}
    {sheet==='bybit'&&<BybitSheet workspace={workspace} workspaceId={workspaceId} status={bybitStatus} online={online} onStatus={onBybitStatus} onSynced={onBybitSynced} onClose={()=>setSheet(null)}/>}
    {sheet==='theme'&&<SelectSheet title="Тема" value={theme} options={THEME_OPTIONS} searchable={false} onClose={()=>setSheet(null)} onSelect={(value)=>{setSheet(null);onThemeChange(value as ThemePreference)}}/>}
    {(editing||adding)&&<CategoryEditor category={editing} mainCount={mainCategories.length} onClose={()=>{setEditing(null);setAdding(false)}} onSave={save}/>}
    {(editingTag||addingTag)&&<TagEditor tag={editingTag} onClose={()=>{setEditingTag(null);setAddingTag(false)}} onSave={saveTag} onDelete={editingTag?()=>removeTag(editingTag):undefined}/>}
    {notice&&<Toast toast={notice} onDismiss={hideNotice}/>}
  </section>
}

// Редактор категории: вместо «Размещение: Основные / Дополнительные» — переключатель «Показывать на главном экране».
function CategoryEditor({ category, mainCount, onClose, onSave }:{category:Category|null;mainCount:number;onClose:()=>void;onSave:(c:Category)=>Promise<void>}) {
  const now = new Date().toISOString()
  const [draft,setDraft]=useState<Category>(category||{id:crypto.randomUUID(),name:'',color:TAG_COLORS[0]!,placement:'additional',sortOrder:999,createdAt:now,updatedAt:now,archivedAt:null,version:1})
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
  const onMain=draft.placement==='main'
  const othersOnMain=mainCount-(category?.placement==='main'?1:0)
  return <><div className="sheet-backdrop" onMouseDown={()=>{if(!busy)onClose()}}><form ref={dialogRef as React.Ref<HTMLFormElement>} className="bottom-sheet editor" role="dialog" aria-modal="true" aria-labelledby="category-editor-title" noValidate onSubmit={(e)=>{e.preventDefault();void submit(draft)}} onMouseDown={(e)=>e.stopPropagation()}><div className="sheet-handle"/><div className="sheet-title"><h2 id="category-editor-title">{category?'Категория':'Новая категория'}</h2><button type="button" className="icon-button" data-dialog-initial-focus disabled={busy} aria-label="Закрыть" onClick={onClose}>×</button></div><label>Название<input maxLength={40} aria-invalid={Boolean(validation)} value={draft.name} onChange={(e)=>{setValidation('');setDraft({...draft,name:e.target.value})}}/></label>{validation&&<p className="form-error" role="alert">{validation}</p>}<fieldset><legend>Цвет</legend><div className="colors">{TAG_COLORS.map((color,index)=><button aria-label={`Цвет: ${TAG_COLOR_NAMES[index] ?? color}`} aria-pressed={draft.color===color} type="button" key={color} className={draft.color===color?'selected':''} style={{background:color}} onClick={()=>setDraft({...draft,color})}/>)}</div></fieldset><label className="switch-row"><span><b>Показывать на главном экране</b><small>{onMain?`Плиткой рядом с клавиатурой${othersOnMain>=3?' — уже тесно, плиток больше четырёх не помещается':''}`:'Иначе — за плиткой «Ещё»'}</small></span><input type="checkbox" role="switch" checked={onMain} disabled={busy} onChange={(e)=>setDraft({...draft,placement:e.target.checked?'main':'additional'})}/></label><button className="primary" disabled={busy}>{busy?'Сохраняем…':'Сохранить'}</button>{category&&<button type="button" className="danger-link" disabled={busy} onClick={()=>void (async()=>{if(await confirm({title:'Скрыть категорию?',message:'Она пропадёт из выбора, но останется у старых расходов.',confirmLabel:'Скрыть',danger:true}))await submit({...draft,archivedAt:new Date().toISOString()})})()}>Скрыть</button>}</form></div>{confirmation}</>
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

type IssueSummary = { amount: string | null; category: string; when: string; note: string }

function describeExpenseLike(source: Partial<Pick<Expense, 'amountMinor' | 'currency' | 'categoryId' | 'note' | 'occurredAt'>>, bootstrap: Bootstrap): IssueSummary {
  return {
    amount: source.amountMinor !== undefined && source.currency ? money(source.amountMinor, source.currency, bootstrap.currencies) : null,
    category: bootstrap.categories.find((category) => category.id === source.categoryId)?.name ?? 'Категория не найдена',
    when: source.occurredAt ? formatEntryDate(isoToLocalInput(source.occurredAt)) : '',
    note: source.note ?? '',
  }
}

// Удаление несёт только id и версию, поэтому детали берём из локальной копии расхода или серверной версии.
function summarizeOutboxItem(item: WorkspaceOutboxItem, bootstrap: Bootstrap): IssueSummary {
  const payload = item.payload as Partial<Pick<Expense, 'id' | 'amountMinor' | 'currency' | 'categoryId' | 'note' | 'occurredAt'>>
  if (payload.amountMinor !== undefined) return describeExpenseLike(payload, bootstrap)
  const source = bootstrap.expenses.find((expense) => expense.id === payload.id) ?? item.current
  return source ? describeExpenseLike(source, bootstrap) : { amount: null, category: '', when: '', note: '' }
}

function retryLabel(item: WorkspaceOutboxItem) {
  if (item.status !== 'conflict') return 'Отправить ещё раз'
  return item.type === 'deleteExpense' ? 'Удалить всё равно' : 'Сохранить мою версию'
}

const isOutboxIssue = (item: WorkspaceOutboxItem) => item.status === 'conflict' || item.status === 'failed'

function SyncIssuesSheet({ userId, workspaceId, bootstrap, online, onClose, onRetry, onDiscard }: { userId: string; workspaceId: string; bootstrap: Bootstrap; online: boolean; onClose: () => void; onRetry: (operationId: string) => Promise<string | null>; onDiscard: (operationIds?: string[]) => Promise<void> }) {
  const [items,setItems]=useState<WorkspaceOutboxItem[]>([])
  const [loading,setLoading]=useState(true)
  const [busy,setBusy]=useState<string|null>(null)
  const [error,setError]=useState('')
  const [notice,setNotice]=useState('')
  const dialogRef=useDialog(onClose,busy===null)
  const {confirm,confirmation}=useConfirm()
  const reload=useCallback(async()=>{
    try{const all=await readOutbox(userId,workspaceId);setItems(all.filter(isOutboxIssue).sort((left,right)=>left.createdAt.localeCompare(right.createdAt)))}
    catch{setError('Не удалось прочитать очередь отправки.')}
    finally{setLoading(false)}
  },[userId,workspaceId])
  useEffect(()=>{void reload()},[reload])
  const retry=async(item:WorkspaceOutboxItem)=>{
    setBusy(item.operationId);setError('');setNotice('')
    try{const message=await onRetry(item.operationId);if(message)setNotice(message)}
    catch(reason){setError(reason instanceof Error?reason.message:'Не удалось отправить изменение')}
    finally{await reload();setBusy(null)}
  }
  const discardOne=async(item:WorkspaceOutboxItem)=>{
    if(!await confirm({title:'Отменить это изменение?',message:'Ваша версия расхода удалится, останется та, что на сервере.',confirmLabel:'Отменить изменение',danger:true}))return
    setBusy(item.operationId);setError('');setNotice('')
    try{await onDiscard([item.operationId]);setNotice('Изменение отменено, показана версия с сервера.')}
    catch(reason){setError(reason instanceof Error?reason.message:'Не удалось отменить изменение')}
    finally{await reload();setBusy(null)}
  }
  const discardAll=async()=>{
    if(!await confirm({title:'Отменить все проблемные изменения?',message:'Ваши версии этих расходов удалятся, останутся те, что на сервере.',confirmLabel:'Отменить изменения',danger:true}))return
    setBusy('all');setError('');setNotice('')
    try{await onDiscard()}
    catch(reason){setError(reason instanceof Error?reason.message:'Не удалось очистить проблемные изменения');await reload();setBusy(null)}
  }
  return <><div className="sheet-backdrop" onMouseDown={()=>{if(busy===null)onClose()}}><section ref={dialogRef} className="bottom-sheet sync-issues-sheet" role="dialog" aria-modal="true" aria-labelledby="sync-issues-title" onMouseDown={(event)=>event.stopPropagation()}>
    <div className="sheet-handle"/><div className="sheet-title"><h2 id="sync-issues-title">Не отправлено</h2><button type="button" className="icon-button" data-dialog-initial-focus disabled={busy!==null} onClick={onClose} aria-label="Закрыть">×</button></div>
    <p>Эти изменения остались только на этом телефоне: сервер их не принял. Их можно отправить ещё раз или отменить — тогда вернётся версия с сервера.</p>
    {loading&&<p className="management-state" role="status">Проверяем очередь…</p>}
    <div className="sync-issue-list">{items.map((item)=>{
      const summary=summarizeOutboxItem(item,bootstrap)
      const server=item.current&&item.type!=='createExpense'?describeExpenseLike(item.current,bootstrap):null
      const itemBusy=busy===item.operationId
      return <div key={item.operationId} className="sync-issue">
        <div className="sync-issue-head"><b>{outboxActionLabel(item.type)}</b><small>{new Date(item.createdAt).toLocaleString('ru-RU',{dateStyle:'short',timeStyle:'short'})}</small></div>
        {summary.amount&&<div className="sync-issue-expense"><strong>{summary.amount}</strong><span>{summary.category}{summary.when?` · ${summary.when}`:''}{summary.note?` · ${summary.note}`:''}</span></div>}
        <p className="sync-issue-reason">{describeOutboxIssue(item)}</p>
        {server&&<p className="sync-issue-server">На сервере сейчас: {item.current?.deletedAt?'расход удалён':`${server.amount ?? '—'} · ${server.category}${server.when?` · ${server.when}`:''}`}</p>}
        <div className="sync-issue-actions"><button type="button" className="primary" disabled={!online||busy!==null} onClick={()=>void retry(item)}>{itemBusy?'Отправляем…':retryLabel(item)}</button><button type="button" className="sheet-cancel" disabled={!online||busy!==null} onClick={()=>void discardOne(item)}>Отменить</button></div>
      </div>})}</div>
    {!loading&&!items.length&&!error&&<p className="management-state" role="status">Проблемных изменений уже нет.</p>}
    {notice&&<p className="management-state" role="status">{notice}</p>}
    {!online&&<p className="form-error" role="status">Подключитесь к интернету, чтобы отправить или отменить изменения.</p>}
    {error&&<p className="form-error" role="alert">{error}</p>}
    {items.length>1&&<button type="button" className="danger-link" disabled={!online||busy!==null||loading} onClick={()=>void discardAll()}>{busy==='all'?'Обновляем…':'Отменить все'}</button>}
    <button type="button" className="sheet-cancel" disabled={busy!==null} onClick={onClose}>Закрыть</button>
  </section></div>{confirmation}</>
}

export function pagerTabsAt(scrollLeft: number, clientWidth: number, items=tabs): Tab[] {
  if (clientWidth <= 0) return ['entry']
  const position = Math.max(0, Math.min(items.length - 1, scrollLeft / clientWidth))
  const touching = [Math.floor(position), Math.ceil(position)].map((index) => items[index]!.id)
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
  return <div className="sheet-backdrop" onMouseDown={()=>{if(!busy)onClose()}}><form ref={dialogRef as React.Ref<HTMLFormElement>} className="bottom-sheet editor" role="dialog" aria-modal="true" aria-labelledby="create-workspace-title" noValidate onMouseDown={(event)=>event.stopPropagation()} onSubmit={(event)=>{event.preventDefault();submit()}}><div className="sheet-handle"/><div className="sheet-title"><h2 id="create-workspace-title">Создать пространство</h2><button type="button" className="icon-button" data-dialog-initial-focus disabled={busy} aria-label="Закрыть" onClick={onClose}>×</button></div>{!existing&&<label>Как вас называть<input maxLength={80} placeholder="Например, Ваня" aria-invalid={Boolean(validation&&!displayName.trim())} value={displayName} onChange={(event)=>{setValidation('');setDisplayName(event.target.value)}}/></label>}<label>Название пространства<input maxLength={80} placeholder="Например, Дом или Поездка" aria-invalid={Boolean(validation&&!name.trim())} value={name} onChange={(event)=>{setValidation('');setName(event.target.value)}}/></label>{validation&&<p className="form-error" role="alert">{validation}</p>}<button className="primary" disabled={busy}>{busy?'Создаём…':'Создать пространство'}</button><button type="button" className="sheet-cancel" disabled={busy} onClick={onClose}>Отмена</button></form></div>
}

// Очередь операций с карты открывается поверх истории и закрывается обратно в неё: это входящие, а не вкладка.
function ReviewOverlay({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const dialogRef = useDialog(onClose)
  return <div ref={dialogRef as React.Ref<HTMLDivElement>} className="review-overlay" role="dialog" aria-modal="true" aria-labelledby="review-overlay-title">
    <header className="review-overlay-head"><button type="button" className="icon-button" data-dialog-initial-focus onClick={onClose} aria-label="Закрыть">×</button><h2 id="review-overlay-title">Операции с карты</h2><span/></header>
    {children}
  </div>
}

export function WorkspaceSwitcher({ items, active, runtimes, online = navigator.onLine, onSelect, onCreate }: { items: WorkspaceSummary[]; active: string; runtimes: Record<string, import('./types').WorkspaceRuntime>; online?: boolean; onSelect: (id: string) => void; onCreate: () => void }) {
  const close=()=>onSelect(active)
  const dialogRef=useDialog(close)
  return <div className="sheet-backdrop" onMouseDown={close}><section ref={dialogRef} className="bottom-sheet" role="dialog" aria-modal="true" aria-labelledby="workspace-switcher-title" onMouseDown={(event)=>event.stopPropagation()}><div className="sheet-handle"/><div className="sheet-title"><h2 id="workspace-switcher-title">Пространства</h2><button type="button" className="icon-button" onClick={close} aria-label="Закрыть">×</button></div>{items.map((item)=>{const runtime=runtimes[item.id];const disabled=!online&&!runtime?.bootstrap;return <button type="button" data-dialog-initial-focus={item.id===active||undefined} aria-pressed={item.id===active} className="workspace-option" key={item.id} disabled={disabled} onClick={()=>onSelect(item.id)}><span>{item.name}<small>{item.role==='owner'?'Владелец':'Участник'} {runtime?.outbox.total?`· ${runtime.outbox.total} ждут`:''}</small></span>{item.id===active?'✓':disabled?'Нет офлайн-кэша':''}</button>})}<button type="button" className="primary" disabled={!online} onClick={onCreate}>Создать пространство</button></section></div>
}

// Ссылка доступа — единственный способ вернуться к расходам без этого телефона. Одно действие: поделиться или
// скопировать; после удачного сохранения ссылка подтверждается сама, а «сохранено» сообщает тост у родителя.
// Сырой URL показывается только когда ни копирование, ни системное меню не сработали.
export function RecoverySave({ prepared, complete, close, allowLater = true, mode = 'initial' }: { prepared: RecoveryPrepareResponse; complete: () => Promise<void | boolean>; close: () => void; allowLater?: boolean; mode?: 'initial' | 'rotation' | 'public' }) {
  const [busy,setBusy]=useState(false); const [error,setError]=useState(''); const [feedback,setFeedback]=useState(''); const [feedbackError,setFeedbackError]=useState(false); const [savedOnce,setSavedOnce]=useState(false)
  const dialogRef=useDialog(close,allowLater&&!busy)
  const canShare=typeof navigator.share==='function'
  const finish = async () => {
    setBusy(true); setError('')
    try {
      const done = await complete()
      if (done !== false) close()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось подтвердить. Ссылка остаётся на экране — не закрывайте его.')
    } finally { setBusy(false) }
  }
  const copyRecovery=async()=>{
    try{await copyText(prepared.recoveryUrl);setFeedbackError(false);setFeedback('Ссылка скопирована');setSavedOnce(true)}
    catch(reason){setFeedbackError(true);setFeedback(reason instanceof Error?reason.message:'Не удалось скопировать ссылку');return}
    await finish()
  }
  const shareRecovery=async()=>{
    if(!canShare){await copyRecovery();return}
    try{await navigator.share({title:'Ссылка доступа moapp',url:prepared.recoveryUrl});setFeedbackError(false);setFeedback('');setSavedOnce(true)}
    catch(reason){if(!(reason instanceof DOMException&&reason.name==='AbortError')){setFeedbackError(true);setFeedback('Не удалось поделиться ссылкой')}return}
    await finish()
  }
  const warning = mode === 'initial'
    ? 'Это единственный способ вернуться к расходам, если телефон потеряется. Отправьте её себе в Заметки или в менеджер паролей: показать эту ссылку снова будет нельзя — только заменить новой. Любой, у кого она есть, получит полный доступ.'
    : mode === 'public'
      ? 'Сохраните новую ссылку прежде чем продолжить: старая перестанет работать, а все прежние устройства будут отключены.'
      : 'Старая ссылка сразу перестанет работать. Любой, у кого есть новая, получит полный доступ.'
  return <div className="sheet-backdrop" onMouseDown={()=>{if(allowLater&&!busy)close()}}><section ref={dialogRef} className="bottom-sheet access-sheet" role="dialog" aria-modal="true" aria-labelledby="recovery-save-title" onMouseDown={(event)=>event.stopPropagation()}>
    <div className="sheet-handle"/><h2 id="recovery-save-title">Сохраните ссылку доступа</h2><p className="sheet-copy">{warning}</p>
    <div className="qr"><QRCodeSVG value={prepared.recoveryUrl} size={150}/></div>
    {(feedbackError||error)&&<code className="access-link">{prepared.recoveryUrl}</code>}
    {feedback&&<p className="inline-feedback" role={feedbackError?'alert':'status'}>{feedback}</p>}
    {error&&<p className="form-error" role="alert">{error}</p>}
    {canShare
      ? <><button type="button" className="primary" data-dialog-initial-focus disabled={busy} onClick={()=>void shareRecovery()}>{busy?'Подтверждаем…':'Поделиться'}</button><button type="button" className="sheet-cancel" disabled={busy} onClick={()=>void copyRecovery()}>Скопировать</button></>
      : <button type="button" className="primary" data-dialog-initial-focus disabled={busy} onClick={()=>void copyRecovery()}>{busy?'Подтверждаем…':'Скопировать'}</button>}
    {error&&savedOnce&&<button type="button" className="sheet-cancel" disabled={busy} onClick={()=>void finish()}>Повторить</button>}
    {allowLater&&<button type="button" className="sheet-cancel" disabled={busy} onClick={close}>Позже</button>}
  </section></div>
}

function LegacyClaimFlow({ hydrate, cancel }: { hydrate: (session: SessionState) => Promise<void>; cancel: () => void }) {
  const [name,setName]=useState(''); const [pin,setPin]=useState(''); const [busy,setBusy]=useState(false); const [error,setError]=useState(''); const attempt=useRef<string>(generateAttemptToken())
  const claim=async(event: React.FormEvent)=>{event.preventDefault();if(!name.trim()||!pin.trim()){setError(!name.trim()?'Введите ваше имя.':'Введите общий PIN.');return}setBusy(true);setError('');try{await hydrate(await legacyClaim(pin,name.trim(),attempt.current))}catch(reason){setError(reason instanceof ApiError&&reason.code==='CLAIM_IN_PROGRESS'?'Перенос уже выполняется в другой вкладке.':'PIN не подошёл или попытка временно ограничена.')}finally{setBusy(false)}}
  return <main className="empty-state"><div className="brand-mark">m</div><p className="eyebrow">Существующие расходы</p><h1>Перенести данные</h1><p>Укажите имя и действующий общий PIN. Затем нужно будет сохранить ссылку доступа.</p><form noValidate onSubmit={claim}><label>Ваше имя<input aria-invalid={Boolean(error&&!name.trim())} value={name} onChange={(event)=>{setError('');setName(event.target.value)}}/></label><label>Общий PIN<input aria-invalid={Boolean(error&&!pin.trim())} type="password" value={pin} onChange={(event)=>{setError('');setPin(event.target.value)}}/></label>{error&&<p className="form-error" role="alert">{error}</p>}<button className="primary" disabled={busy}>{busy?'Проверяем…':'Продолжить'}</button><button type="button" className="sheet-cancel" disabled={busy} onClick={cancel}>Назад</button></form></main>
}

function RestrictedRecovery({ session, hydrate }: { session: AuthenticatedSession; hydrate: (session: SessionState) => Promise<void> }) {
  const [prepared,setPrepared]=useState<RecoveryPrepareResponse|null>(null); const [publicRecovery,setPublicRecovery]=useState(false); const [error,setError]=useState(''); const started=useRef(false)
  useEffect(()=>{if(started.current)return;started.current=true;void prepareInitialOrManualRecovery().then(setPrepared,(reason)=>setError(reason instanceof ApiError?reason.message:'Не удалось подготовить ссылку доступа'))},[])
  if(prepared)return <RecoverySave key={prepared.completionToken} prepared={prepared} mode={publicRecovery?'public':'initial'} allowLater={false} close={()=>{}} complete={async()=>{
    const outcome=publicRecovery
      ?await completeRecoverySafely({prepared,targetUserId:session.user.id})
      :await completeRotationSafely({prepared,targetUserId:session.user.id})
    if(outcome.status==='completed'){await hydrate(outcome.session);return}
    if(outcome.status==='replacement-active-needs-recovery'){
      setPrepared(await prepareRecovery(outcome.replacementToken));setPublicRecovery(true);return false
    }
    throw new Error(outcome.status==='rotation-stale'?'Параллельно была сохранена другая ссылка доступа.':'Не удалось подтвердить ссылку. Не закрывайте экран и повторите попытку.')
  }}/>
  return <main className="empty-state"><div className="brand-mark">m</div><h1>Сохраните ссылку доступа</h1><p role={error?'alert':'status'}>{error||'Готовим ссылку доступа…'}</p></main>
}

export function CapabilityScreen({ intent, session, knownUserId, finish, close, resolveIdentityConflict }: {
  intent: CapabilityIntent
  session: SessionState | null
  knownUserId: string | null
  finish: (session: SessionState, workspaceId?: string) => Promise<void>
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
          if(knownUserId&&!session?.authenticated){setConflict(true);setError('На этом телефоне уже есть другой профиль. Сначала войдите в него по ссылке доступа или удалите его данные.')}
        }else if(intent.kind==='device'){
          const value=await previewDeviceLink(intent.token)
          if(!active)return
          setTargetUserId(value.targetUserId);setCopy(`Подключить устройство к профилю «${value.displayName}»`)
          if(activeUserId&&activeUserId!==value.targetUserId){setConflict(true);setError('Ссылка от другого профиля. Чтобы продолжить, нужно выйти из текущего — его данные удалятся с этого телефона.')}
        }else{
          const value=await previewRecovery(intent.token)
          if(!active)return
          setTargetUserId(value.targetUserId);setCopy(`Вернуть доступ к профилю «${value.displayName}»`)
          if(activeUserId&&activeUserId!==value.targetUserId){setConflict(true);setError('Ссылка от другого профиля. Чтобы продолжить, нужно выйти из текущего — его данные удалятся с этого телефона.')}
        }
        if(active)setReady(true)
      }catch(reason){
        if(!active)return
        if(reason instanceof ApiError&&reason.code==='IDENTITY_CONFLICT'){
          setConflict(true);setError('Ссылка от другого профиля. Чтобы продолжить, нужно выйти из текущего.')
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
        if(!current?.authenticated){current=await createIdentityWithProbe(name);allowWorkspaceMutations()}
        const accepted=await acceptInvitationWithProbe(intent.token,workspaceTarget)
        await finish(accepted,workspaceTarget)
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
        setConflict(true);setError('Ссылка от другого профиля. Чтобы продолжить, нужно выйти из текущего.')
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
      setError('Ответ сервера потерялся. Сохраните показанную новую ссылку и подтвердите её ещё раз.')
      return false
    }
    if(outcome.status==='rotation-stale')throw new Error('Параллельно была завершена другая замена ссылки. Используйте последнюю подтверждённую ссылку.')
    throw new Error('Не удалось подтвердить ссылку. Не удаляйте показанную и повторите с активного устройства.')
  }

  if(prepared)return <RecoverySave key={prepared.completionToken} prepared={prepared} mode="public" allowLater={false} close={close} complete={completePublicRecovery}/>
  return <><main className="empty-state"><div className="brand-mark">m</div><p className="eyebrow">Безопасная ссылка</p><h1>{intent.kind==='invite'?'Приглашение':intent.kind==='device'?'Новое устройство':'Ссылка доступа'}</h1><p>{error||copy}</p>
    {intent.kind==='invite'&&!session?.authenticated&&!conflict&&<label>Как вас называть<input placeholder="Например, Ваня" aria-invalid={Boolean(error&&!name.trim())} value={name} onChange={(event)=>{setError('');setName(event.target.value)}}/></label>}
    {conflict?<button type="button" className="primary danger" disabled={!online||busy} onClick={()=>void (async()=>{if(!await confirm({title:'Выйти из текущего профиля?',message:'Его данные удалятся с этого телефона.',confirmLabel:'Выйти и продолжить',danger:true}))return;setBusy(true);void resolveIdentityConflict(targetUserId).catch((reason)=>setError(reason instanceof Error?reason.message:'Не удалось выйти')).finally(()=>setBusy(false))})()}>{busy?'Выходим…':'Выйти и продолжить'}</button>:<button type="button" className="primary" disabled={!ready||busy||intent.kind==='invite'&&!session?.authenticated&&!name.trim()} onClick={()=>void proceed()}>{busy?'Проверяем…':intent.kind==='invite'?'Присоединиться':intent.kind==='device'?'Подключить':'Вернуть доступ'}</button>}
    <button className="sheet-cancel" disabled={busy} onClick={close}>Закрыть</button>
  </main>{confirmation}</>
}

export default function App({ capability = null }: { capability?: CapabilityIntent | null }) {
  useInputModality()
  const [state,setState]=useState(()=>createAppState(capability))
  const [pagerState,setPagerState]=useState<{workspaceId:string|null;tab:Tab;mounted:Tab[]}>({workspaceId:null,tab:'entry',mounted:['entry']})
  const [currentId,setCurrentId]=useState<string|null>(null)
  const [createOpen,setCreateOpen]=useState(false)
  const [switchOpen,setSwitchOpen]=useState(false)
  const [issuesOpen,setIssuesOpen]=useState(false)
  const [reviewOpen,setReviewOpen]=useState(false)
  const [bybitRuntime,setBybitRuntime]=useState<{workspaceId:string;status:BybitCardStatus}|null>(null)
  const [initialRecovery,setInitialRecovery]=useState<RecoveryPrepareResponse|null>(null)
  const [error,setError]=useState('')
  const { toast: notice, notify: setNotice, dismiss: hideNotice } = useToast()
  const { confirm, confirmation } = useConfirm()
  const online=useOnlineStatus()
  const [themePreference,setThemePreference]=useState<ThemePreference>(readThemePreference)
  const theme=useResolvedTheme(themePreference)
  const [updateWaiting,setUpdateWaiting]=useState(false)
  const [draftDirty,setDraftDirty]=useState(false)
  const [workspaceReloadEpoch,setWorkspaceReloadEpoch]=useState(0)
  const stateRef=useRef(state); stateRef.current=state
  const tab=pagerState.workspaceId===state.activeWorkspaceId?pagerState.tab:'entry'
  const mountedTabs=pagerState.workspaceId===state.activeWorkspaceId?pagerState.mounted:['entry']
  const reviewConnected=bybitRuntime?.workspaceId===state.activeWorkspaceId&&bybitRuntime.status.connected
  const navigationTabs=tabs
  const setTab=useCallback((next:Tab)=>{
    const workspaceId=stateRef.current.activeWorkspaceId
    // Сначала срочно меняем вкладку (лента поехала), а тяжёлые страницы монтируем в transition — нажатие не ждёт их рендера.
    setPagerState((previous)=>previous.workspaceId===workspaceId?{...previous,tab:next}:{workspaceId,tab:next,mounted:['entry']})
    startTransition(()=>setPagerState((previous)=>previous.workspaceId===workspaceId?{...previous,mounted:[...previous.mounted,...pagerTabsFor(next).filter((item)=>!previous.mounted.includes(item))]}:{workspaceId,tab:next,mounted:pagerTabsFor(next)}))
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
        setError('Нет связи с сервером, а сохранённых на этом телефоне данных нет.')
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
  useEffect(()=>{document.documentElement.dataset.theme=theme},[theme])
  useEffect(()=>{if(themePreference==='system')localStorage.removeItem('moapp:theme');else localStorage.setItem('moapp:theme',themePreference)},[themePreference])
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
    const left=Math.max(0,navigationTabs.findIndex((item)=>item.id===tab))*node.clientWidth
    if(Math.abs(node.scrollLeft-left)<1&&pagerAnimation.current===null)return
    // Тап по вкладке едет так же плавно, как свайп между страницами. Пока лента в пути, обработчик скролла
    // не должен переключать вкладку на промежуточную, иначе анимация развернётся обратно.
    pagerTarget.current=left
    animatePager(node,left)
  },[state.activeWorkspaceId,tab,reviewConnected,Boolean(state.activeWorkspaceId&&state.runtimes[state.activeWorkspaceId]?.bootstrap)])
  useEffect(()=>()=>clearTimeout(pagerTimer.current),[])
  const pagerTarget=useRef<number|null>(null)
  const pagerAnimation=useRef<number|null>(null)
  // Прокрутку к вкладке ведём сами через requestAnimationFrame: нативный smooth scroll в WebKit при новой команде
  // поверх незавершённой делает скачок, а при остановке между точками привязки зависает мимо страницы.
  const stopPagerAnimation=()=>{
    if(pagerAnimation.current!==null){cancelAnimationFrame(pagerAnimation.current);pagerAnimation.current=null}
    const node=pager.current;if(node)node.style.scrollSnapType=''
  }
  const animatePager=(node:HTMLElement,left:number)=>{
    stopPagerAnimation()
    const from=node.scrollLeft,distance=left-from
    if(Math.abs(distance)<1||prefersReducedMotion()){node.scrollLeft=left;return}
    // Привязку отключаем на время анимации: иначе браузер притягивает каждый промежуточный кадр к странице.
    node.style.scrollSnapType='none'
    const duration=Math.min(320,200+Math.abs(distance)/node.clientWidth*40)
    const started=performance.now()
    const frame=(now:number)=>{
      const progress=Math.min(1,(now-started)/duration)
      const eased=1-Math.pow(1-progress,3)
      node.scrollLeft=from+distance*eased
      if(progress<1){pagerAnimation.current=requestAnimationFrame(frame);return}
      pagerAnimation.current=null
      node.style.scrollSnapType=''
      node.scrollLeft=left
    }
    pagerAnimation.current=requestAnimationFrame(frame)
  }

  const session=state.session
  const auth=session?.authenticated?session:null
  const settingsIdentityEpoch=identityEpoch.current
  const workspaceId=state.activeWorkspaceId
  const workspacesKey=auth?.workspaces.map((workspace)=>`${workspace.id}:${workspace.version}`).join('|')??''
  const bybitStatus=bybitRuntime?.workspaceId===workspaceId?bybitRuntime.status:null
  const updateBybitStatus=useCallback((next:Partial<BybitCardStatus>&Pick<BybitCardStatus,'pendingCount'>)=>{
    const id=stateRef.current.activeWorkspaceId;if(!id)return
    setBybitRuntime((current)=>({workspaceId:id,status:{connected:false,canManage:false,...(current?.workspaceId===id?current.status:{}),...next}}))
  },[])

  useEffect(()=>{
    if(!auth||!workspaceId||!online){setBybitRuntime(null);return}
    const controller=new AbortController();const id=workspaceId
    setBybitRuntime((current)=>current?.workspaceId===id?current:null)
    void getBybitCardStatus(id,controller.signal).then((status)=>{
      if(controller.signal.aborted)return
      setBybitRuntime({workspaceId:id,status})
    }).catch(()=>{/* Bybit status is supplemental and must not block the workspace. */})
    return()=>controller.abort()
  },[auth?.currentSessionId,auth?.user.id,online,workspaceId])
  useEffect(()=>{if(!reviewConnected)setReviewOpen(false)},[reviewConnected])
  // История мемоизирована: карточка очереди отдаётся ей стабильным объектом, чтобы не перерисовывать список на каждый рендер приложения.
  const openReview=useCallback(()=>setReviewOpen(true),[])
  const reviewCount=reviewConnected?bybitStatus?.pendingCount??0:0
  const historyInbox=useMemo(()=>reviewCount?{count:reviewCount,onOpen:openReview}:null,[reviewCount,openReview])
  // Ссылку доступа предлагаем спокойной карточкой над историей после первого расхода, а не тремя модалками при первом запуске.
  const recoveryNeeded=Boolean(auth&&!auth.user.recoveryConfigured&&!auth.restrictedToRecovery)
  const hasExpenses=Boolean(workspaceId&&state.runtimes[workspaceId]?.bootstrap?.expenses.some((expense)=>!expense.deletedAt))
  const openRecoverySave=useCallback(async()=>{
    try{setInitialRecovery(await prepareInitialOrManualRecovery())}
    catch(reason){setError(reason instanceof ApiError?reason.message:'Не удалось подготовить ссылку доступа')}
  },[])
  const historyReminder=useMemo(()=>recoveryNeeded&&hasExpenses&&online?{onSave:()=>void openRecoverySave()}:null,[recoveryNeeded,hasExpenses,online,openRecoverySave])

  // A Bybit sync can change expenses server-side (declined operations void their expense); pull the
  // workspace again without the loading state so history and analytics reflect it immediately.
  const reloadWorkspaceData=useCallback(()=>{
    const id=stateRef.current.activeWorkspaceId;const session=stateRef.current.session
    if(!id||!session?.authenticated)return
    const userId=session.user.id,sessionId=session.currentSessionId
    void getBootstrap(id).then((value)=>{
      if(value.offline)return
      updateState((current)=>{
        if(!current.session?.authenticated||current.session.user.id!==userId||current.session.currentSessionId!==sessionId||!current.runtimes[id])return current
        return updateWorkspace(current,id,(runtime)=>({...runtime,bootstrap:value.data,source:'network',offline:false}))
      })
    }).catch(()=>{/* the next regular load refreshes it */})
  },[updateState])
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
    }catch(reason){setError(reason instanceof ApiError||reason instanceof Error?reason.message:'Не удалось создать пространство')}
  }

  const closeIntent=()=>{capabilityRef.current=null;updateState(closeCapability)}
  const finishIntent=async(next:SessionState,targetWorkspaceId?:string)=>{
    const finishedKind=capabilityRef.current?.kind
    capabilityRef.current=null
    let built=await buildState(next,null)
    if(targetWorkspaceId)built=setActiveWorkspace(built,targetWorkspaceId)
    commitState(built)
    if(next.authenticated)coordinator.current?.announce(next.user.id,next.currentSessionId)
    if(finishedKind==='recovery')setNotice('Доступ возвращён. Старая ссылка больше не работает, прежние устройства отключены. Сохраните новую.')
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
      if(!await pending)throw new Error('Не удалось удалить данные профиля')
    }
    coordinator.current?.announce(null,null)
    await hydrate(await getSession())
  }

  const logoutCurrent=async()=>{
    const current=stateRef.current
    if(!current.session?.authenticated)return
    const queued=current.activeWorkspaceId?current.runtimes[current.activeWorkspaceId]?.outbox.total??0:0
    const message=queued?`Данные приложения удалятся с этого телефона, а ${queued} ${pluralRu(queued,['неотправленное изменение пропадёт','неотправленных изменения пропадут','неотправленных изменений пропадут'])}. Вернуться можно по сохранённой ссылке доступа.`:'Данные приложения удалятся с этого телефона. Вернуться можно по сохранённой ссылке доступа.'
    if(!await confirm({title:'Выйти?',message,confirmLabel:'Выйти',danger:true}))return
    stopNetwork();const pending=beginLogout(current);capabilityRef.current=null;commitState(createLoggedOutState());coordinator.current?.announce(null,null)
    try{
      await pending
      if(online&&!await settlePendingLogout(true))throw new Error('Не удалось подтвердить выход на сервере')
      await refresh()
    }catch(reason){setError(reason instanceof Error?reason.message:'Не удалось завершить выход. Повторите после подключения к интернету.')}
  }

  const forgetCurrent=async()=>{
    if(!await confirm({title:'Начать заново?',message:'Данные этого профиля удалятся с телефона, включая расходы, которые не успели отправиться. Если ссылка доступа сохранена, лучше открыть её.',confirmLabel:'Начать заново',danger:true}))return
    const current=stateRef.current
    if(!online||!current.session){setError('Подключитесь к интернету, чтобы начать заново.');return}
    stopNetwork()
    const pending=forgetKnownProfile(online,current.session)
    capabilityRef.current=null;commitState(createLoggedOutState());coordinator.current?.announce(null,null)
    try{
      const forgotten=await pending
      if(!forgotten){setError('Не удалось удалить данные профиля. Подключитесь к интернету и повторите.');return}
      await refresh()
    }catch(reason){setError(reason instanceof Error?reason.message:'Не удалось удалить данные профиля. Повторите попытку.')}
  }

  const logoutUnexpected=async()=>{
    const unexpected=stateRef.current.conflictingSession
    if(!unexpected)return
    await logoutExpected(unexpected.userId,unexpected.sessionId)
    await refresh()
  }

  const confirmDraftDiscard=async()=>!draftDirty||confirm({title:'Отбросить изменения?',message:'Несохранённая сумма, категория, дата и заметка будут потеряны.',confirmLabel:'Отбросить',danger:true})
  const openCreate=async()=>{if(await confirmDraftDiscard()){setSwitchOpen(false);setCreateOpen(true)}}
  const openExpense=async(id:string|null)=>{
    if(id!==currentId&&!await confirmDraftDiscard())return
    setCurrentId(id)
    setDraftDirty(false)
    setTab('entry')
  }
  // История мемоизирована и получает неизменные колбэки; актуальное замыкание берётся из рефа.
  const openExpenseRef=useRef(openExpense);openExpenseRef.current=openExpense
  const editExpense=useCallback((id:string)=>void openExpenseRef.current(id),[])
  const createNewExpense=useCallback(()=>void openExpenseRef.current(null),[])
  const switchWorkspace=async(id:string)=>{
    if(id!==stateRef.current.activeWorkspaceId&&!await confirmDraftDiscard())return
    if(id!==stateRef.current.activeWorkspaceId){updateState((value)=>setActiveWorkspace(value,id));setCurrentId(null);setDraftDirty(false);setReviewOpen(false);setTab('entry')}
    setSwitchOpen(false)
  }
  const retryIssue=async(operationId:string):Promise<string|null>=>{
    const current=stateRef.current
    if(!current.session?.authenticated||!current.activeWorkspaceId)throw new Error('Пространство уже закрыто')
    const userId=current.session.user.id
    const activeWorkspaceId=current.activeWorkspaceId
    const result=await retryOutboxIssue(userId,activeWorkspaceId,operationId)
    await refreshWorkspaceStats(userId,activeWorkspaceId)
    if(!result)return 'Нет связи с сервером: изменение отправится, когда связь появится.'
    if(result.status==='applied'||result.status==='unchanged'){setWorkspaceReloadEpoch((value)=>value+1);return 'Сохранено на сервере.'}
    return null
  }
  const discardIssues=async(operationIds?:string[])=>{
    const current=stateRef.current
    if(!current.session?.authenticated||!current.activeWorkspaceId)throw new Error('Пространство уже закрыто')
    const userId=current.session.user.id
    const sessionId=current.session.currentSessionId
    const activeWorkspaceId=current.activeWorkspaceId
    const data=await discardOutboxIssues(userId,activeWorkspaceId,operationIds)
    updateState((value)=>value.session?.authenticated&&value.session.user.id===userId&&value.session.currentSessionId===sessionId&&value.activeWorkspaceId===activeWorkspaceId&&value.runtimes[activeWorkspaceId]?updateWorkspace(value,activeWorkspaceId,(runtime)=>({...runtime,bootstrap:data,source:'network',offline:false,status:'ready'})):value)
    await refreshWorkspaceStats(userId,activeWorkspaceId)
    setWorkspaceReloadEpoch((value)=>value+1)
    if(operationIds)return
    setIssuesOpen(false)
    setNotice('Проблемные изменения отменены. Загружаем серверную версию.')
  }
  const activateUpdate=()=>{if(draftDirty){setError('Сначала сохраните или очистите черновик расхода.');return}monitor.current?.activateWaiting()}
  const onPagerScroll=()=>{
    const node=pager.current
    // Пока лента едет к выбранной вкладке программно, промежуточные позиции ничего не монтируют: набор уже задан в setTab.
    if(node?.clientWidth&&pagerTarget.current===null){
      const workspaceId=stateRef.current.activeWorkspaceId
      const visible=pagerTabsAt(node.scrollLeft,node.clientWidth,navigationTabs)
      setPagerState((previous)=>{
        if(previous.workspaceId!==workspaceId)return {workspaceId,tab:'entry',mounted:visible}
        // Страницы не размонтируются, пока открыто это пространство: повторное монтирование мигает и заново грузит аналитику.
        const mounted=[...previous.mounted,...visible.filter((item)=>!previous.mounted.includes(item))]
        return mounted.length===previous.mounted.length?previous:{...previous,mounted}
      })
    }
    clearTimeout(pagerTimer.current)
    pagerTimer.current=setTimeout(()=>{const node=pager.current;if(!node?.clientWidth)return;if(pagerTarget.current!==null){// Safari может остановить плавную прокрутку между точками привязки, особенно при быстрых тапах по вкладкам — дожимаем без анимации.
if(Math.abs(node.scrollLeft-pagerTarget.current)>1)node.scrollLeft=pagerTarget.current;pagerTarget.current=null}const item=navigationTabs[Math.max(0,Math.min(navigationTabs.length-1,Math.round(node.scrollLeft/node.clientWidth)))];if(item)setTab(item.id)},90)
  }

  if(state.phase==='checking')return <div className="splash"><div className="brand-mark">m</div>{error&&<p>{error}</p>}</div>
  if(state.capability)return <CapabilityScreen intent={state.capability} session={session} knownUserId={state.knownUserId} finish={finishIntent} close={closeIntent} resolveIdentityConflict={resolveIdentityConflict}/>
  if(state.phase==='legacy-claim')return <LegacyClaimFlow hydrate={(next)=>hydrate(next,true)} cancel={()=>updateState((value)=>({...value,phase:'guest'}))}/>
  if(state.phase==='restricted-recovery'&&auth)return <RestrictedRecovery session={auth} hydrate={async(next)=>{await hydrate(next,true);setNotice('Перенос завершён. Ссылка доступа сохранена, старый PIN больше не нужен.')}}/>
  if(state.phase==='guest'||state.phase==='no-workspaces'||state.phase==='known-user-locked')return <><main className="empty-state"><div className="brand-mark">m</div><p className="eyebrow">Общие расходы</p><h1>{state.phase==='known-user-locked'?'Вход истёк':'Простой общий учёт расходов'}</h1><p>{state.phase==='known-user-locked'?'Откройте ссылку доступа, которую сохраняли, — или начните заново.':'Без регистрации, email и пароля.'}</p>{state.phase==='known-user-locked'?<>{state.conflictingSession&&<button type="button" className="primary" disabled={!online} onClick={()=>void logoutUnexpected().catch((reason)=>setError(reason instanceof Error?reason.message:'Не удалось выйти'))}>Выйти из другого профиля</button>}<button type="button" className={state.conflictingSession?'danger-link':'primary danger'} disabled={!online||!state.session} onClick={()=>void forgetCurrent()}>Начать заново</button>{(!online||!state.session)&&<p className="management-state" role="status">Начать заново можно, когда появится связь с сервером.</p>}</>:<><button type="button" className="primary" disabled={!online} onClick={()=>setCreateOpen(true)}>Создать пространство</button>{state.phase==='guest'&&session&&!session.authenticated&&session.legacyClaimAvailable&&<button type="button" className="sheet-cancel" onClick={()=>updateState(openLegacyClaim)}>Продолжить с существующими расходами</button>}</>}{createOpen&&<CreateWorkspaceSheet existing={Boolean(auth)} onClose={()=>setCreateOpen(false)} onCreate={create}/>} {error&&<p className="form-error" role="alert">{error}</p>}</main>{confirmation}</>

  const runtime=workspaceId?state.runtimes[workspaceId]:undefined
  const bootstrap=runtime?.bootstrap
  const workspace=auth&&workspaceId?auth.workspaces.find((item)=>item.id===workspaceId):undefined
  if(!auth||!workspaceId||!workspace||!bootstrap)return <div className="splash"><div className="brand-mark">m</div><p role={runtime?.status==='error'?'alert':'status'}>{runtime?.status==='error'?'Не удалось открыть пространство':'Загружаем пространство…'}</p>{error&&<><p className="form-error" role="alert">{error}</p><button type="button" className="sheet-cancel" onClick={()=>void refresh(true)}>Повторить</button></>}</div>
  const stats=runtime.outbox
  const serverAvailable=online&&!runtime.offline
  const issueCount=stats.conflicts+stats.failed
  const queuedCount=Math.max(0,stats.total-issueCount)
  return <div className={`app-shell${serverAvailable?'':' offline'}`} key={workspaceId}>
    <header className="workspace-header"><button type="button" className="workspace-name-button" onClick={()=>setSwitchOpen(true)}><span>{workspace.name}</span><ChevronIcon/></button><div className="workspace-header-actions">{updateWaiting&&<button type="button" className="update-button" onClick={activateUpdate}>Обновить</button>}{issueCount?<button type="button" className="sync-status attention" onClick={()=>setIssuesOpen(true)} aria-label={`Не отправлено: ${issueCount}. Открыть список`}><span>Не отправлено · {issueCount}</span><i/></button>:serverAvailable&&stats.total?<div className="sync-status" role="status" aria-live="polite"><span>Отправляем · {stats.total}</span><i/></div>:null}</div></header>
    {!serverAvailable&&<div className="offline-banner" role="status" aria-live="polite"><span><b>Офлайн</b>{queuedCount?` · ${queuedCount} ${pluralRu(queuedCount,['изменение','изменения','изменений'])} ${queuedCount===1?'ждёт':'ждут'} отправки`:' · отправим при подключении'}</span><button type="button" onClick={()=>{void probeServer();setWorkspaceReloadEpoch((value)=>value+1)}}>Повторить</button></div>}
    <main className="pager" ref={pager} onScroll={onPagerScroll} onPointerDown={()=>{stopPagerAnimation();pagerTarget.current=null}} onTouchStart={()=>{stopPagerAnimation();pagerTarget.current=null}}>
      <div className="page-slot" inert={tab!=='entry'} aria-hidden={tab!=='entry'}>{mountedTabs.includes('entry')&&<EntryView userId={auth.user.id} workspaceId={workspaceId} bootstrap={bootstrap} setBootstrap={setWorkspaceData} currentId={currentId} setCurrentId={setCurrentId} refreshPending={refreshPending} onDraftDirtyChange={setDraftDirty} active={tab==='entry'}/>}</div>
      <div className="page-slot" inert={tab!=='history'} aria-hidden={tab!=='history'}>{mountedTabs.includes('history')&&<HistoryView userId={auth.user.id} workspaceId={workspaceId} bootstrap={bootstrap} setBootstrap={setWorkspaceData} edit={editExpense} createNew={createNewExpense} refreshPending={refreshPending} inbox={historyInbox} reminder={historyReminder}/>}</div>
      <div className="page-slot" inert={tab!=='analytics'} aria-hidden={tab!=='analytics'}>{mountedTabs.includes('analytics')&&<AnalyticsView userId={auth.user.id} workspaceId={workspaceId} bootstrap={bootstrap} theme={theme} online={serverAvailable}/>}</div>
      <div className="page-slot" inert={tab!=='settings'} aria-hidden={tab!=='settings'}>{mountedTabs.includes('settings')&&<SettingsView user={auth} workspace={workspace} workspaceId={workspaceId} bootstrap={bootstrap} setBootstrap={setWorkspaceData} pendingCount={stats.total} refreshPending={refreshPending} onLogout={()=>void logoutCurrent()} theme={themePreference} onThemeChange={setThemePreference} onSession={(next)=>hydrate(next,false,settingsIdentityEpoch)} online={serverAvailable} bybitStatus={bybitStatus} onBybitStatus={(status)=>updateBybitStatus(status)} onBybitSynced={reloadWorkspaceData}/>}</div>
    </main>
    <nav className="bottom-nav" aria-label="Основная навигация">{navigationTabs.map((item)=><button type="button" key={item.id} aria-current={tab===item.id?'page':undefined} aria-label={item.id==='history'&&reviewCount?`История: ${reviewCount} операций с карты ждут разбора`:item.label} className={tab===item.id?'active':''} onClick={()=>{if(tab!==item.id)tap(4);setTab(item.id)}}><span><NavIcon tab={item.id}/>{item.id==='history'&&reviewCount>0&&<b className="nav-badge">{reviewCount>99?'99+':reviewCount}</b>}</span><small>{item.label}</small></button>)}</nav>
    {reviewOpen&&reviewConnected&&<ReviewOverlay onClose={()=>setReviewOpen(false)}><BybitReviewView workspaceId={workspaceId} categories={bootstrap.categories} currencies={bootstrap.currencies} tags={bootstrap.tags??[]} onTag={(tag)=>setWorkspaceData((data)=>({...data,tags:[tag,...(data.tags??[]).filter((item)=>item.id!==tag.id)]}))} online={serverAvailable} onStatus={updateBybitStatus} pendingCount={bybitStatus?.pendingCount??0} active onExpense={(expense)=>setWorkspaceData((data)=>({...data,expenses:[expense,...data.expenses.filter((item)=>item.id!==expense.id)]}))} onExpenseUndo={(expenseId)=>setWorkspaceData((data)=>({...data,expenses:data.expenses.filter((item)=>item.id!==expenseId)}))}/></ReviewOverlay>}
    {switchOpen&&<WorkspaceSwitcher items={auth.workspaces} active={workspaceId} runtimes={state.runtimes} online={serverAvailable} onSelect={(id)=>void switchWorkspace(id)} onCreate={()=>void openCreate()}/>} {createOpen&&<CreateWorkspaceSheet existing onClose={()=>setCreateOpen(false)} onCreate={create}/>} {issuesOpen&&<SyncIssuesSheet userId={auth.user.id} workspaceId={workspaceId} bootstrap={bootstrap} online={serverAvailable} onClose={()=>setIssuesOpen(false)} onRetry={retryIssue} onDiscard={discardIssues}/>} {initialRecovery&&<RecoverySave key={initialRecovery.completionToken} prepared={initialRecovery} mode="initial" close={()=>setInitialRecovery(null)} complete={async()=>{
      const outcome=await completeRotationSafely({prepared:initialRecovery,targetUserId:auth.user.id})
      if(outcome.status!=='completed')throw new Error(outcome.status==='rotation-stale'?'Параллельно была сохранена другая ссылка доступа.':'Не удалось подтвердить ссылку. Повторите из настроек.')
      await hydrate(outcome.session,true)
      setNotice('Ссылка доступа сохранена')
    }}/>}
    {error && <Toast toast={{text:error,urgent:true}} onDismiss={()=>setError('')}/>}
    {notice&&<Toast toast={notice} onDismiss={hideNotice}/>} {confirmation}
  </div>
}
