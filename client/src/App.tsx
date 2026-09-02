import { lazy, memo, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import {
  WorkspaceApiError as ApiError, allowWorkspaceMutations, blockWorkspaceMutations, createCategory, discardOutboxIssues, getAnalytics, getBootstrap,
  classifyBybitCardTransaction, connectBybitCard, disconnectBybitCard, getBybitCardStatus, ignoreBybitCardTransaction, listBybitCardTransactions, syncBybitCard, undoBybitCardTransaction,
  createDeviceLink, createInvitation, createTag, deleteTag, reorderTags, updateTag, getSession, isLinkInvalid, legacyClaim, leaveWorkspace, listInvitations, listMembers, listSessions, logoutExpected, prepareInitialOrManualRecovery,
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
import { amountToMinor, applyKeypad, convertExpense, countCalendarWeekdays, isoToLocalInput, localDateKey, localInputToIso, monthDateRange, shiftDateKey, swipeDirection, weekdayFromDateKey, weekDateRange } from './utils'
import { buildHistoryCsv, defaultHistoryPreferences, expenseTagNames, filterHistoryExpenses, parseHistoryPreferences, type HistoryPeriod, type HistoryPreferences } from './history'

const AnalyticsChart = lazy(() => import('./AnalyticsCharts'))

export type Tab = 'entry' | 'history' | 'analytics' | 'review' | 'settings'
type Theme = 'light' | 'dark'
type AnalyticsPeriod = 'week' | 'month'
const CHART_COLOR = '#758d69'
const EMPTY_FORM = { amount: '', currency: 'RSD', note: '', occurredAt: '', tagIds: [] as string[] }

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
  return localInputParts(localInput)?.date.toLocaleDateString('ru-RU', { weekday: 'short', timeZone: 'UTC' }) ?? ''
}

export function formatEntryDate(localInput: string) {
  const parts = localInputParts(localInput)
  if (!parts) return ''
  const calendarDate = parts.date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' })
  return `${formatShortWeekday(localInput)} · ${calendarDate} ${parts.year}, ${parts.hour}:${parts.minute}`
}

export function formatHistoryDate(dateKey: string) {
  const localInput = `${dateKey}T12:00`
  const parts = localInputParts(localInput)
  if (!parts) return ''
  const calendarDate = parts.date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' })
  return `${formatShortWeekday(localInput)} · ${calendarDate} ${parts.year}`
}

const CARD_GAP = 18

type CardFace = { title: string; date: string; amount: string; currency: string }

function EntryCard({ face, onDate, onCurrency, disabled = false, limitHit = 0 }: { face: CardFace; onDate?: () => void; onCurrency?: () => void; disabled?: boolean; limitHit?: number }) {
  const inert = onCurrency ? undefined : -1
  const amountSize = face.amount.replace(/\D/g, '').length > 10 ? 'long' : face.amount.replace(/\D/g, '').length > 7 ? 'medium' : 'normal'
  return <>
    <header className="topline">
      <div>
        <p className="eyebrow">{face.title}</p>
        <button type="button" className="date-chip" onClick={onDate} tabIndex={inert} disabled={disabled}><span>{face.date}</span><ChevronIcon/></button>
      </div>
    </header>
    <div className="amount-row">
      <output key={limitHit} className={`amount-value${face.amount ? '' : ' empty'}${limitHit ? ' limit' : ''}`} data-size={amountSize} aria-label="Сумма">{face.amount || '0'}</output>
      <button type="button" onClick={onCurrency} tabIndex={inert} disabled={disabled}>{face.currency}<ChevronIcon/></button>
    </div>
  </>
}

const ChevronIcon = () => <svg className="chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6l5 5 5-5"/></svg>
const CheckIcon = () => <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5"/></svg>

type SelectOption = { value: string; label: string; hint?: string }

// Замена нативного <select>: системный список вариантов не стилизуется и выбивается из интерфейса,
// поэтому варианты открываются в той же нижней шторке, что валюта и категории.
function Select({ label, title = label, value, options, onChange, disabled = false, searchable = options.length > 8 }: { label: string; title?: string; value: string; options: SelectOption[]; onChange: (value: string) => void; disabled?: boolean; searchable?: boolean }) {
  const [open, setOpen] = useState(false)
  const current = options.find((option) => option.value === value)
  return <>
    <button type="button" className="select-trigger" aria-label={label} aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={() => setOpen(true)}><span>{current?.label ?? '—'}</span><ChevronIcon/></button>
    {open && <SelectSheet title={title} value={value} options={options} searchable={searchable} onClose={() => setOpen(false)} onSelect={(next) => { setOpen(false); if (next !== value) onChange(next) }}/>}
  </>
}

function SelectSheet({ title, value, options, searchable, onClose, onSelect }: { title: string; value: string; options: SelectOption[]; searchable: boolean; onClose: () => void; onSelect: (value: string) => void }) {
  const [query, setQuery] = useState('')
  const dialogRef = useDialog(onClose)
  const titleId = useId()
  const normalized = query.trim().toLowerCase()
  const filtered = normalized ? options.filter((option) => `${option.label} ${option.hint ?? ''}`.toLowerCase().includes(normalized)) : options
  return <div className="sheet-backdrop" onMouseDown={onClose}>
    <section ref={dialogRef} className={`bottom-sheet select-sheet${searchable ? ' tall' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(event) => event.stopPropagation()}>
      <div className="sheet-handle"/><div className="sheet-title"><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" data-dialog-initial-focus onClick={onClose} aria-label="Закрыть">×</button></div>
      {searchable && <input className="search" type="search" placeholder="Поиск" aria-label={`Поиск: ${title}`} value={query} onChange={(event) => setQuery(event.target.value)}/>}
      <div className="select-options" role="listbox" aria-label={title}>{filtered.map((option) => <button type="button" role="option" key={option.value} aria-selected={option.value === value} aria-label={option.hint ? `${option.label}, ${option.hint}` : undefined} className="select-option" onClick={() => onSelect(option.value)}><span><b>{option.label}</b>{option.hint && <small>{option.hint}</small>}</span>{option.value === value && <CheckIcon/>}</button>)}</div>
      {!filtered.length && <p className="sheet-empty" role="status">По запросу «{query}» ничего не найдено.</p>}
    </section>
  </div>
}

const MAX_EXPENSE_TAGS = 20

// Тег — короткая плашка поверх категории. Один расход может нести несколько тегов, любой тег подходит любой категории.
function TagChip({ name, color = null, selected = false, onToggle, disabled = false }: { name: string; color?: string | null; selected?: boolean; onToggle?: () => void; disabled?: boolean }) {
  if (!onToggle) return <span className="tag-chip" style={tagStyle({ color })}>{name}</span>
  return <button type="button" className="tag-chip" style={tagStyle({ color })} aria-pressed={selected} disabled={disabled} onClick={onToggle}>{name}</button>
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

// Одна горизонтальная полоса со всеми тегами: тег включается одним касанием, «+» открывает поиск и создание.
function TagStrip({ tags, selected, onChange, onCreate, disabled = false, online = true }: { tags: Tag[]; selected: string[]; onChange: (ids: string[]) => void; onCreate?: (name: string) => Promise<Tag | null>; disabled?: boolean; online?: boolean }) {
  const [open, setOpen] = useState(false)
  const ordered = sortTags(tags)
  const toggle = (id: string) => {
    tap(4)
    if (selected.includes(id)) onChange(selected.filter((item) => item !== id))
    else if (selected.length < MAX_EXPENSE_TAGS) onChange([...selected, id])
  }
  return <div className="tag-strip" role="group" aria-label="Теги">
    <button type="button" className="tag-add" disabled={disabled} onClick={() => setOpen(true)} aria-label={ordered.length ? 'Найти или создать тег' : 'Добавить тег'}>{ordered.length ? '+' : '＋ Тег'}</button>
    {ordered.map((tag) => <TagChip key={tag.id} name={tag.name} color={tag.color} selected={selected.includes(tag.id)} disabled={disabled} onToggle={() => toggle(tag.id)}/>)}
    {open && <TagSheet tags={tags} selected={selected} online={online} onClose={() => setOpen(false)} onChange={onChange} onCreate={onCreate}/>}
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
const PlusIcon = () => <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>

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

function money(amountMinor: number, currency: string, currencies: Currency[]) {
  const decimals = currencies.find((item) => item.code === currency)?.decimals ?? 2
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency, maximumFractionDigits: decimals }).format(amountMinor / 10 ** decimals)
}

function amountNumber(amountMinor: number, currency: string, currencies: Currency[]) {
  const decimals = currencies.find((item) => item.code === currency)?.decimals ?? 2
  return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(amountMinor / 10 ** decimals)
}

function inputFromExpense(expense: Expense, currencies: Currency[]) {
  const decimals = currencies.find((item) => item.code === expense.currency)?.decimals ?? 2
  return {
    amount: String(expense.amountMinor / 10 ** decimals),
    currency: expense.currency,
    note: expense.note || '',
    occurredAt: isoToLocalInput(expense.occurredAt),
    tagIds: [...(expense.tagIds ?? [])].sort(),
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
    setValidation('')
    setDraft(isoToLocalInput(date.toISOString()))
  }
  const valid = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(draft)
  // Сдвиг относительно уже выбранного момента: «час назад» или «вчера в это же время» одним касанием.
  const nudge = (hours: number) => {
    const base = valid ? new Date(localInputToIso(draft)) : new Date()
    setValidation('')
    setDraft(isoToLocalInput(new Date(base.getTime() + hours * 3_600_000).toISOString()))
    tap(4)
  }
  const setTime = (hour: number) => {
    setValidation('')
    setDraft(`${(valid ? draft : now()).slice(0, 10)}T${String(hour).padStart(2, '0')}:00`)
    tap(4)
  }
  // Две строки по четыре: минусы над такими же плюсами, шаг растёт слева направо.
  const nudges: Array<[number, string]> = [[-1, '−1ч'], [-3, '−3ч'], [-8, '−8ч'], [-24, '−1д'], [1, '+1ч'], [3, '+3ч'], [8, '+8ч'], [24, '+1д']]
  return <div className="sheet-backdrop" onMouseDown={onClose}>
    <form ref={dialogRef as React.Ref<HTMLFormElement>} className="bottom-sheet editor" role="dialog" aria-modal="true" aria-labelledby="date-title" noValidate onSubmit={(event) => { event.preventDefault(); if (!draft) { setValidation('Выберите дату и время.'); return } onPick(draft) }} onMouseDown={(event) => event.stopPropagation()}>
      <div className="sheet-handle"/>
      <div className="sheet-title"><h2 id="date-title">Когда</h2><button type="button" className="icon-button" data-dialog-initial-focus onClick={onClose} aria-label="Закрыть">×</button></div>
      <p className="date-preview" aria-live="polite">{valid ? formatEntryDate(draft) : 'Дата не выбрана'}</p>
      <div className="date-presets"><button type="button" onClick={() => shift(0)}>Сейчас</button><button type="button" onClick={() => shift(1)}>Вчера</button><button type="button" onClick={() => shift(2)}>Позавчера</button></div>
      <div className="date-nudges" role="group" aria-label="Сдвинуть дату и время">{nudges.map(([hours, label]) => <button type="button" key={label} onClick={() => nudge(hours)}>{label}</button>)}</div>
      <div className="date-presets date-times" role="group" aria-label="Время дня"><button type="button" onClick={() => setTime(9)}>Утро · 9:00</button><button type="button" onClick={() => setTime(13)}>День · 13:00</button><button type="button" onClick={() => setTime(19)}>Вечер · 19:00</button></div>
      <label className="date-field">Дата и время <b className="weekday-badge">{formatShortWeekday(draft)}</b><input type="datetime-local" aria-invalid={Boolean(validation)} value={draft} onChange={(event) => { setValidation(''); setDraft(event.target.value) }}/></label>
      {validation && <p className="form-error" role="alert">{validation}</p>}
      <button className="primary">Готово</button>
    </form>
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
  const [editCategoryId, setEditCategoryId] = useState<string | null>(null)
  const { toast, notify, dismiss } = useToast()
  const { confirm, confirmation } = useConfirm()
  const swipe = useRef<{ x: number; y: number; lastX: number; active: boolean; touchId: number | null } | null>(null)
  const suppressTouchPointerUp = useRef(false)
  const entryRef = useRef<HTMLElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const actionsRef = useRef<HTMLDivElement>(null)
  const offset = useRef(0)
  const swapped = useRef(false)
  const committing = useRef(false)
  const swapTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // Черновик несохранённого нового расхода, чтобы свайп по истории не стирал набранную сумму.
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
    // При свайпе новое состояние уже достигнуто анимацией; при удалении и открытии из истории блок мягко гаснет или проявляется сам.
    styleEntryActions(actionsRef.current, currentId ? 1 : 0, didSwap ? 0 : 180)
  }, [currentId])

  useLayoutEffect(() => {
    const base = current ? inputFromExpense(current, bootstrap.currencies) : draft.current.amount ? draft.current : { ...EMPTY_FORM, currency: getWorkspacePreference(userId, workspaceId, 'last-currency') || 'RSD' }
    // Свежую версию записи подхватываем, только пока пользователь не начал править её сам.
    const sameRecord = synced.current.id === (currentId || '')
    if (sameRecord && JSON.stringify(form) !== JSON.stringify(synced.current.form)) return
    synced.current = { id: currentId || '', form: base }
    setForm(base)
    setEditCategoryId(current?.categoryId ?? null)
    // Заметка всегда свёрнута в одну строку: развёрнутое поле у одних расходов и свёрнутое у других меняло высоту при листании.
    setShowNote(false)
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

  const buildExpense = (categoryId: string, submittedForm = form, submittedCurrent = current): Expense => {
    const now = new Date().toISOString()
    return {
      id: submittedCurrent?.id || crypto.randomUUID(), amountMinor: amountToMinor(submittedForm.amount, submittedForm.currency, bootstrap.currencies), currency: submittedForm.currency,
      categoryId, note: submittedForm.note.trim() || null, occurredAt: submittedForm.occurredAt ? localInputToIso(submittedForm.occurredAt) : now, tagIds: [...submittedForm.tagIds].sort(),
      createdAt: submittedCurrent?.createdAt || now, updatedAt: now, version: submittedCurrent ? submittedCurrent.version + 1 : 1, deletedAt: null, pending: !navigator.onLine,
    }
  }

  const submitExpense = async (categoryId: string) => {
    const submittedForm = { ...form }
    const submittedCurrent = current
    if (!submittedForm.amount || Number(submittedForm.amount) <= 0) { notify('Сначала введите сумму'); return }
    setSaving(true); setCategorySheet(false)
    const expense = buildExpense(categoryId, submittedForm, submittedCurrent)
    const previousExpense = bootstrap.expenses.find((item) => item.id === expense.id)
    setBootstrap((data) => ({ ...data, expenses: [expense, ...data.expenses.filter((item) => item.id !== expense.id)] }))
    try {
      const result = await submitExpenseOperation(userId, workspaceId, submittedCurrent ? 'updateExpense' : 'createExpense', expense)
      if (result?.expense) setBootstrap((data) => ({ ...data, expenses: data.expenses.map((item) => item.id === expense.id ? result.expense! : item) }))
      else if (!result) setBootstrap((data) => ({ ...data, expenses: data.expenses.map((item) => item.id === expense.id ? { ...item, pending:true } : item) }))
      notify(result?.status === 'conflict' ? 'Изменение конфликтует с сервером. Откройте «Нужна проверка» вверху.' : submittedCurrent ? 'Изменения сохранены' : 'Расход добавлен')
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

  const chooseCategory = (category: Category) => {
    if (!form.amount || Number(form.amount) <= 0) { notify('Сначала введите сумму'); return }
    tap(6)
    if (current) {
      setEditCategoryId(category.id)
      setCategorySheet(false)
      return
    }
    void submitExpense(category.id)
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
    styleEntryActions(actionsRef.current, sourcePresence + (targetPresence - sourcePresence) * progress, duration)
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
    if (committing.current || saving || categorySheet || currencySheet || dateSheet) return false
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
  const selectedCategoryId = current ? editCategoryId ?? current.categoryId : null
  const currentCategory = selectedCategoryId ? bootstrap.categories.find((item) => item.id === selectedCategoryId) : undefined
  // Категорию из «Другого» показываем на самой кнопке «Другое»: добавлять её в сетку нельзя — та переносится на вторую строку и дёргает раскладку.
  const otherFace = currentCategory && !main.some((item) => item.id === currentCategory.id) ? currentCategory : null
  const dirty = current ? JSON.stringify(form) !== JSON.stringify(inputFromExpense(current, bootstrap.currencies)) || selectedCategoryId !== current.categoryId : Boolean(form.amount || form.note || form.occurredAt)
  const cancelEdit = () => {
    if (!current || saving) return
    const original = inputFromExpense(current, bootstrap.currencies)
    synced.current = { id: current.id, form: original }
    setForm(original)
    setEditCategoryId(current.categoryId)
    setShowNote(false)
  }
  const startNew = async () => {
    if (dirty && !await confirm({
      title: 'Начать новый расход?',
      message: 'Несохранённые изменения текущего расхода будут потеряны.',
      confirmLabel: 'Начать новый',
      danger: true,
    })) return
    const next = { ...EMPTY_FORM, currency: getWorkspacePreference(userId, workspaceId, 'last-currency') || 'RSD' }
    draft.current = next
    synced.current = { id: '', form: next }
    setCurrentId(null)
    setForm(next)
    setEditCategoryId(null)
    setShowNote(false)
    setCategorySheet(false)
    setCurrencySheet(false)
    setDateSheet(false)
    tap(6)
  }
  useEffect(() => { onDraftDirtyChange(dirty) }, [dirty, onDraftDirtyChange])
  useEffect(() => () => onDraftDirtyChange(false), [onDraftDirtyChange])
  const categoryHint = !ready ? 'Сначала введите сумму' : current ? dirty ? 'Проверьте изменения и сохраните' : 'Категория расхода' : 'Выберите категорию, чтобы сохранить'
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
  return <section ref={entryRef} className={`entry-view${current ? ' editing' : ''}${saving ? ' saving' : ''}`} aria-label="Ввод суммы" onPointerDown={swipeStart} onPointerMove={swipeMove} onPointerUpCapture={swipeEnd} onPointerCancel={swipeCancel}>
    <div className="swipe-area">
      <div className="entry-track" ref={trackRef}>
        {olderFace && <div className="entry-card aside older" aria-hidden="true"><EntryCard face={olderFace}/></div>}
        <div className="entry-card"><EntryCard face={liveFace} disabled={saving} limitHit={limitHit} onDate={() => setDateSheet(true)} onCurrency={() => setCurrencySheet(true)}/></div>
        {newerFace && <div className="entry-card aside newer" aria-hidden="true"><EntryCard face={newerFace}/></div>}
      </div>
    </div>
    <div ref={actionsRef} className="entry-actions" style={ENTRY_ACTIONS_HIDDEN} inert={!current} aria-hidden={!current}>
      <button type="button" className="icon-add" disabled={saving || !current} onClick={() => void startNew()} aria-label="Новый расход"><PlusIcon/></button>
      <button type="button" className="icon-danger entry-delete" disabled={saving || !current} onClick={() => void remove()} aria-label="Удалить расход"><TrashIcon/></button>
    </div>
    <Keypad onKey={key} disabled={saving}/>
    <div className={`categories${ready ? '' : ' locked'}${dirty ? ' unsaved' : ''}`}><p>{categoryHint}</p><div className="main-categories">{main.map((category) => <button type="button" disabled={!ready || saving} aria-pressed={category.id === selectedCategoryId} key={category.id} className={category.id === selectedCategoryId ? 'selected' : undefined} onClick={() => chooseCategory(category)}><i style={{backgroundColor:category.color ?? '#a9afa5'}}/><span>{category.name}</span></button>)}<button type="button" disabled={!ready || saving} aria-pressed={Boolean(otherFace)} className={otherFace ? 'selected' : undefined} onClick={() => setCategorySheet(true)}>{otherFace ? <i style={{backgroundColor:otherFace.color ?? '#a9afa5'}}/> : <i className="dots">•••</i>}<span>{otherFace ? otherFace.name : 'Другое'}</span></button></div></div>
    <div className={`edit-actions${current ? '' : ' empty'}`} aria-hidden={!current}>{current && <><button type="button" className="primary" disabled={!ready || !dirty || saving || !selectedCategoryId} onClick={() => selectedCategoryId && void submitExpense(selectedCategoryId)}>{saving ? 'Сохраняем…' : 'Сохранить'}</button><button type="button" className="sheet-cancel" disabled={!dirty || saving} onClick={cancelEdit}>Отменить</button></>}</div>
    <TagStrip tags={bootstrap.tags ?? []} selected={form.tagIds} disabled={saving} online={navigator.onLine} onChange={(tagIds) => setForm((value) => ({ ...value, tagIds }))} onCreate={(name) => createTagOrReuse(workspaceId, name, TAG_COLORS[(bootstrap.tags ?? []).length % TAG_COLORS.length] ?? null, (tag) => setBootstrap((data) => ({ ...data, tags: [tag, ...(data.tags ?? []).filter((item) => item.id !== tag.id)] })))}/>
    <div className="note-block">{!showNote ? <button type="button" className="text-button" disabled={saving} onClick={() => setShowNote(true)}>{form.note ? `✎ ${form.note}` : '＋ Добавить заметку'}</button> : <label>Заметка <span>необязательно</span><input autoFocus maxLength={200} disabled={saving} placeholder="Например, IKEA" value={form.note} onFocus={(event) => { const node = event.currentTarget; requestAnimationFrame(() => node.scrollIntoView({ block: 'center' })) }} onChange={(e) => setForm({...form,note:e.target.value})}/></label>}</div>
    {dateSheet && <DateSheet value={form.occurredAt} onClose={() => setDateSheet(false)} onPick={(value) => { setForm({ ...form, occurredAt: value }); setDateSheet(false) }}/>}
    {categorySheet && <CategorySheet categories={additional} selectedId={selectedCategoryId ?? undefined} onClose={() => setCategorySheet(false)} onPick={chooseCategory}/>}
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
    {confirmation}
  </section>
}

const ROW_ACTION_WIDTH = 84
const LONG_PRESS_MS = 450
const ROW_DRAG_START = 8

// Строка истории: тап открывает запись, долгое нажатие включает выбор нескольких, свайп влево открывает удаление.
function HistoryRow({ expense, category, tags, currencies, checked, selecting, open, disabled, onOpen, onToggle, onEdit, onDelete }: {
  expense: Expense; category?: Category; tags: Tag[]; currencies: Currency[]; checked: boolean; selecting: boolean; open: boolean; disabled: boolean
  onOpen: (id: string | null) => void; onToggle: () => void; onEdit: () => void; onDelete: () => void
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
      if (gesture.current && !gesture.current.dragging) { gesture.current.moved = true; tap(8); onToggle() }
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
    if (selecting) onToggle()
    else onEdit()
  }
  const translate = dragOffset ?? (open ? -ROW_ACTION_WIDTH : 0)
  const tagList = expense.tagIds?.length ? sortTags(tags.filter((tag) => expense.tagIds?.includes(tag.id))) : []
  return <div className={`history-expense${checked ? ' selected' : ''}${open ? ' open' : ''}`} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={(event) => finish(true, event.clientX)} onPointerCancel={() => finish(false)}>
    <div className="history-swipe" style={{ transform: translate ? `translateX(${translate}px)` : undefined, transition: dragOffset === null ? undefined : 'none' }}>
      <label className="expense-check" aria-label={`Выбрать расход ${category?.name || ''}`}><input type="checkbox" tabIndex={selecting ? 0 : -1} checked={checked} onChange={onToggle}/><span/></label>
      <button type="button" className={`history-row${tagList.length ? ' has-tags' : ''}`} aria-pressed={selecting ? checked : undefined} onClick={click}><i style={{backgroundColor:category?.color ?? '#a9afa5'}}/><span><b>{category?.name || 'Архивная категория'}</b><small>{new Date(expense.occurredAt).toLocaleTimeString('ru-RU',{timeZone:'Europe/Belgrade',hour:'2-digit',minute:'2-digit'})}{expense.note ? ` · ${expense.note}`:''}</small>{tagList.length ? <span className="tag-chips">{tagList.map((tag) => <TagChip key={tag.id} name={tag.name} color={tag.color}/>)}</span> : null}</span><strong>{money(expense.amountMinor,expense.currency,currencies)}</strong>{expense.pending && <em aria-label="Ожидает синхронизации">●</em>}</button>
    </div>
    <button type="button" className="history-swipe-delete" tabIndex={open ? 0 : -1} aria-hidden={!open} disabled={disabled} onClick={onDelete}><TrashIcon/><span>Удалить</span></button>
  </div>
}

export function HistoryView({ userId, workspaceId, bootstrap, setBootstrap, edit, createNew, refreshPending }: {
  userId: string
  workspaceId: string
  bootstrap: Bootstrap
  setBootstrap: React.Dispatch<React.SetStateAction<Bootstrap>>
  edit: (id: string) => void
  createNew: () => void
  refreshPending: () => void
}) {
  const [filters, setFilters] = useState<HistoryPreferences>(() => parseHistoryPreferences(
    getWorkspacePreference(userId, workspaceId, 'history-filters'),
    localDateKey(new Date()),
  ))
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [deleting, setDeleting] = useState(false)
  const [openRow, setOpenRow] = useState<string | null>(null)
  const { toast, notify, dismiss } = useToast()
  const categoryMap = new Map(bootstrap.categories.map((category) => [category.id, category]))
  const tags = bootstrap.tags ?? []
  const activeExpenses = bootstrap.expenses.filter((item) => !item.deletedAt)
  const tagOptions = tags
    .filter((tag) => tag.id === filters.tagId || activeExpenses.some((expense) => expense.tagIds?.includes(tag.id)))
    .sort((left, right) => left.name.localeCompare(right.name, 'ru-RU'))
  const categoryOptions = bootstrap.categories
    .filter((category) => category.id === filters.categoryId || activeExpenses.some((expense) => expense.categoryId === category.id))
    .sort((left, right) => left.name.localeCompare(right.name, 'ru-RU'))
  const currencyOptions = bootstrap.currencies
    .filter((currency) => currency.code === filters.currency || activeExpenses.some((expense) => expense.currency === currency.code))
    .sort((left, right) => left.code.localeCompare(right.code))
  const normalizedQuery = filters.query.trim().toLocaleLowerCase('ru-RU')
  const expenses = filterHistoryExpenses(activeExpenses, filters).filter((item) => {
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
      date.toLocaleDateString('ru-RU', { timeZone: 'Europe/Belgrade' }),
    ].filter(Boolean).join(' ').toLocaleLowerCase('ru-RU')
    return !normalizedQuery || searchText.includes(normalizedQuery)
  })
  const grouped = expenses.reduce<Record<string, Expense[]>>((result, item) => { (result[localDateKey(item.occurredAt)] ||= []).push(item); return result }, {})
  const groups = Object.entries(grouped)
  useEffect(() => {
    setWorkspacePreference(userId, workspaceId, 'history-filters', JSON.stringify(filters))
  }, [filters, userId, workspaceId])
  const updateFilters = (patch: Partial<HistoryPreferences>) => {
    setFilters((current) => ({ ...current, ...patch }))
    setSelected(new Set())
  }
  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const filtersActive = Boolean(normalizedQuery || filters.categoryId || filters.tagId || filters.currency || filters.period !== 'all')
  const resetFilters = () => {
    setFilters(defaultHistoryPreferences(localDateKey(new Date())))
    setSelected(new Set())
  }
  const exportExpenses = () => {
    if (!expenses.length) return
    try {
      const blob = new Blob(['\uFEFF', buildHistoryCsv(expenses, bootstrap.categories, bootstrap.currencies, tags)], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `moapp-history-${localDateKey(new Date())}.csv`
      link.hidden = true
      document.body.append(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 0)
      notify(`Экспортировано расходов: ${expenses.length}`)
    } catch {
      notify('Не удалось подготовить файл экспорта', undefined, true)
    }
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
  return <section className="page"><header className="page-header history-title"><div><p className="eyebrow">Все записи</p><h1>История</h1></div><button type="button" className={`icon-danger history-delete${selected.size ? '' : ' off'}`} onClick={removeSelected} disabled={deleting} tabIndex={selected.size ? 0 : -1} aria-hidden={!selected.size} aria-label={`Удалить выбранные расходы: ${selected.size}`}><TrashIcon/></button></header>
    {activeExpenses.length > 0 && <div className="history-controls">
      <input className="search" type="search" placeholder="Сумма, заметка, дата или категория" value={filters.query} onChange={(event) => updateFilters({ query: event.target.value })}/>
      <div className="history-filter-grid">
        <label>Категория<Select label="Категория истории" title="Категория" value={filters.categoryId} onChange={(value) => updateFilters({ categoryId: value })} options={[{ value: '', label: 'Все категории' }, ...categoryOptions.map((category) => ({ value: category.id, label: category.name, ...(category.archivedAt ? { hint: 'архив' } : {}) }))]}/></label>
        <label>Валюта<Select label="Валюта истории" title="Валюта" value={filters.currency} onChange={(value) => updateFilters({ currency: value })} options={[{ value: '', label: 'Все валюты' }, ...currencyOptions.map((currency) => ({ value: currency.code, label: currency.code, hint: currency.name }))]}/></label>
      </div>
      <div className="history-filter-grid">
        <label>Тег<Select label="Тег истории" title="Тег" value={filters.tagId} onChange={(value) => updateFilters({ tagId: value })} options={[{ value: '', label: 'Все теги' }, ...tagOptions.map((tag) => ({ value: tag.id, label: tag.name }))]}/></label>
        <label>Период<Select label="Период истории" title="Период" value={filters.period} onChange={(value) => updateFilters({ period: value as HistoryPeriod })} options={[{ value: 'all', label: 'Все даты' }, { value: 'day', label: 'День' }, { value: 'week', label: 'Неделя' }, { value: 'range', label: 'Интервал' }]}/></label>
      </div>
      {filters.period === 'day' && <label className="history-date-filter">День<input type="date" value={filters.date} onChange={(event) => updateFilters({ date: event.target.value })}/></label>}
      {filters.period === 'week' && <label className="history-date-filter">Любой день нужной недели<input type="date" value={filters.date} onChange={(event) => updateFilters({ date: event.target.value })}/></label>}
      {filters.period === 'range' && <div className="history-filter-grid history-range"><label>С<input type="date" value={filters.from} onChange={(event) => updateFilters({ from: event.target.value })}/></label><label>По<input type="date" value={filters.to} onChange={(event) => updateFilters({ to: event.target.value })}/></label></div>}
      <div className="history-filter-summary"><span>Показано {expenses.length} из {activeExpenses.length}</span><div>{filtersActive && <button type="button" onClick={resetFilters}>Сбросить</button>}<button type="button" className="history-export" disabled={!expenses.length} onClick={exportExpenses}>Экспорт CSV</button></div></div>
    </div>}
    <div className={`history-list${selected.size ? ' selecting' : ''}`}>{groups.map(([date, items]) => <div key={date} className="history-day"><div className="history-date"><span>{formatHistoryDate(date)}</span><b>{items?.length}</b></div>{items?.map((expense) => <HistoryRow key={expense.id} expense={expense} category={categoryMap.get(expense.categoryId)} tags={tags} currencies={bootstrap.currencies} checked={selected.has(expense.id)} selecting={selected.size > 0} open={openRow === expense.id} disabled={deleting} onOpen={setOpenRow} onToggle={() => toggle(expense.id)} onEdit={() => edit(expense.id)} onDelete={() => void removeOne(expense)}/>)}</div>)}</div>
    {!groups.length && <div className="list-empty" role="status"><span>{filtersActive ? 'Ничего не найдено' : 'История пока пуста'}</span><p>{filtersActive ? 'Измените фильтры или сбросьте их.' : 'Добавьте первый расход — он сразу появится здесь.'}</p>{!filtersActive && <button type="button" className="primary history-empty-action" onClick={createNew}>Добавить первый расход</button>}</div>}
    {toast&&<Toast toast={toast} onDismiss={dismiss}/>}
  </section>
}

export function AnalyticsView({ userId, workspaceId, bootstrap, theme, online }: { userId: string; workspaceId: string; bootstrap: Bootstrap; theme: Theme; online: boolean }) {
  const [target, setTarget] = useState(getWorkspacePreference(userId, workspaceId, 'analytics-currency') || 'RSD')
  const [period, setPeriod] = useState<AnalyticsPeriod>('week')
  const [weekOffset, setWeekOffset] = useState(0)
  const [monthOffset, setMonthOffset] = useState(0)
  const [categoryByPeriod, setCategoryByPeriod] = useState<Record<AnalyticsPeriod,string|null>>({
    week:getWorkspacePreference(userId, workspaceId, 'analytics-week-category') || null,
    month:getWorkspacePreference(userId, workspaceId, 'analytics-month-category') || null,
  })
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
  useEffect(()=>{let active=true;const controller=new AbortController();setAnalyticsError(null);if(!online){setAnalyticsOffline(true);setAnalyticsLoading(false);setRemote(null);return()=>controller.abort()}setAnalyticsLoading(true);Promise.all([getAnalytics(workspaceId,from,analyticsTo,target,categoryId??undefined,controller.signal),period==='week'?getAnalytics(workspaceId,previousWeek.from,previousAnalyticsTo,target,categoryId??undefined,controller.signal):Promise.resolve(null)]).then(([result,previous])=>{if(active){setRemote({key:requestKey,data:result,previousTotalMinor:previous?.totalMinor??null});setAnalyticsOffline(false);setAnalyticsLoading(false)}}).catch((reason)=>{if(active&&!controller.signal.aborted){setRemote(null);setAnalyticsOffline(true);setAnalyticsError(reason instanceof ApiError?reason.message:'Сервер аналитики недоступен');setAnalyticsLoading(false)}});return()=>{active=false;controller.abort()}},[workspaceId,from,analyticsTo,target,categoryId,period,previousWeek.from,previousAnalyticsTo,requestKey,online,retryEpoch])
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
  const chartColor=theme==='dark'?'#b1cfa3':CHART_COLOR
  const chartText=theme==='dark'?'#b3b3ae':'#73776f'
  const chartGrid=theme==='dark'?'rgba(255,255,255,.06)':'rgba(32,37,31,.06)'
  return <section className={`page analytics${analyticsLoading?' loading':''}`}><header className="page-header analytics-title"><div><p className="eyebrow">{period==='week'?'Расходы за неделю':'Расходы за месяц'} · {selectedCategoryName}</p><h1 key={`${period}:${categoryId??''}:${target}:${from}`}>{new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}).format(total)} <small>{target}</small></h1>{period==='week'&&<p className="analytics-comparison">{weekComparisonLabel(total,previousTotal,currentWeekPartial)}</p>}</div><button className="currency-choice" onClick={()=>setCurrencySheet(true)}>{target}<ChevronIcon/></button></header>
    <div className="analytics-period" role="group" aria-label="Период аналитики"><button type="button" aria-pressed={period==='week'} className={period==='week'?'selected':''} onClick={()=>setPeriod('week')}>Неделя</button><button type="button" aria-pressed={period==='month'} className={period==='month'?'selected':''} onClick={()=>setPeriod('month')}>Месяц</button></div>
    <label className="analytics-category"><span>Категория</span><Select label="Категория расходов" title="Категория" value={categoryId??''} onChange={(next)=>{const value=next||null;setCategoryByPeriod((current)=>({...current,[period]:value}));setWorkspacePreference(userId,workspaceId,period==='week'?'analytics-week-category':'analytics-month-category',value??'')}} options={[{value:'',label:'Все категории'},...activeCategories.map((category)=>({value:category.id,label:category.name}))]}/></label>
    {period==='week'&&<div className="week-navigator"><button type="button" onClick={()=>setWeekOffset((value)=>value-1)} aria-label="Предыдущая неделя">‹</button><div><b>{weekOffset===0?'Текущая неделя':weekOffset===-1?'Прошлая неделя':'Выбранная неделя'}</b><span>{weekRange}</span></div><button type="button" onClick={()=>setWeekOffset((value)=>Math.min(0,value+1))} disabled={weekOffset===0} aria-label="Следующая неделя">›</button></div>}
    {period==='month'&&<div className="week-navigator"><button type="button" onClick={()=>setMonthOffset((value)=>value-1)} aria-label="Предыдущий месяц">‹</button><div><b>{monthOffset===0?'Текущий месяц':monthOffset===-1?'Прошлый месяц':'Выбранный месяц'}</b><span>{monthLabel}</span></div><button type="button" onClick={()=>setMonthOffset((value)=>Math.min(0,value+1))} disabled={monthOffset===0} aria-label="Следующий месяц">›</button></div>}
    <div className="analytics-stats" key={`${period}:${categoryId??''}:${target}:${from}`}><div><span>Среднее в день</span><strong>{formatAnalyticsAmount(total/elapsedDays,target)}</strong></div><div><span>Операций</span><strong>{data.expenseCount}</strong></div></div>
    <div className={`rate-caption${analyticsOffline?' cached':''}`} role="status">{analyticsLoading?'Обновляем аналитику…':analyticsOffline?<>{analyticsError?'Не удалось обновить. ':''}Показаны сохранённые данные на {new Date(bootstrap.serverTime).toLocaleString('ru-RU')}{online&&<button type="button" onClick={()=>setRetryEpoch((value)=>value+1)}>Повторить</button>}</>:data.rateDate?`Исторические курсы с ${new Date(`${data.rateDate}T12:00:00Z`).toLocaleDateString('ru-RU')}`:data.expenseCount?'Курсы обновляются':'Курсы появятся после первого расхода'}{data.missingCurrencies.length?` · без ${data.missingCurrencies.join(', ')}`:''}</div>
    <div className="chart-card"><div><h2>Динамика</h2><p>{period==='week'?'Понедельник — воскресенье':'По дням выбранного месяца'}</p></div>{data.convertedCount?<div className="line-chart"><Suspense fallback={<ChartSkeleton/>}><AnalyticsChart kind="line" labels={days.map((d)=>new Date(`${d}T12:00`).toLocaleDateString('ru-RU',period==='week'?{weekday:'short'}:{day:'numeric',month:'short'}))} values={byDay} color={chartColor} fillColor={theme==='dark'?'rgba(177,207,163,.14)':'rgba(117,141,105,.12)'} pointRadius={period==='week'?3:0} target={target} textColor={chartText} gridColor={chartGrid} maxTicksLimit={period==='week'?7:6}/></Suspense></div>:<AnalyticsEmpty>{data.expenseCount?'Нет курса для выбранной валюты':'В этом периоде ещё нет расходов'}</AnalyticsEmpty>}</div>
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
  const { confirm, confirmation } = useConfirm()
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
    if (!await confirm({ title: 'Отозвать ссылку?', message: 'Ссылка сразу перестанет работать.', confirmLabel: 'Отозвать', danger: true })) return
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
  </section>{confirmation}</div>
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
  const [workspaceNameState, setWorkspaceNameState] = useState<'idle'|'dirty'|'saving'|'saved'|'error'>('idle')
  const [displayNameState, setDisplayNameState] = useState<'idle'|'dirty'|'saving'|'saved'|'error'>('idle')
  const { confirm, confirmation } = useConfirm()

  useEffect(() => { setWorkspaceName(workspace.name); setWorkspaceNameState('idle') }, [workspace.id, workspace.name])
  useEffect(() => { setName(user.user.displayName); setDisplayNameState('idle') }, [user.user.displayName])
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
      setLoading(false); setLoadError(reason instanceof ApiError || reason instanceof Error ? reason.message : 'Не удалось обновить данные доступа.')
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
    if (!trimmed) { setWorkspaceName(workspace.name); setWorkspaceNameState('error'); return }
    if (busyAction) return
    setBusyAction('workspace-name'); setWorkspaceNameState('saving')
    try {
      await renameWorkspace(workspace.id, trimmed, workspace.version)
      await onSession(await getSession())
      setWorkspaceNameState('saved')
    } catch {
      setWorkspaceName(workspace.name); setWorkspaceNameState('error')
    } finally { setBusyAction(null) }
  }

  const saveDisplayName = async () => {
    const trimmed = name.trim()
    if (trimmed === user.user.displayName) return
    if (!trimmed) { setName(user.user.displayName); setDisplayNameState('error'); return }
    if (busyAction) return
    setBusyAction('display-name'); setDisplayNameState('saving')
    try {
      await updateProfile(trimmed)
      await onSession(await getSession())
      setDisplayNameState('saved')
    } catch {
      setName(user.user.displayName); setDisplayNameState('error')
    } finally { setBusyAction(null) }
  }

  return <>
    <div className="settings-group">
      <h2>Общие настройки пространства</h2>
      <label>Название<input value={workspaceName} maxLength={80} disabled={workspace.role !== 'owner' || !online || busyAction === 'workspace-name'} aria-busy={busyAction === 'workspace-name'} onChange={(event) => {setWorkspaceName(event.target.value);setWorkspaceNameState(event.target.value.trim()===workspace.name?'idle':'dirty')}} onBlur={() => void saveWorkspaceName()}/><span className={`field-state ${workspaceNameState}`}>{workspaceNameState==='dirty'?'Сохранится после выхода из поля':workspaceNameState==='saving'?'Сохраняем…':workspaceNameState==='saved'?'Сохранено':workspaceNameState==='error'?'Не удалось сохранить — возвращено прежнее название':''}</span></label>
      <small>{workspace.role === 'owner' ? 'Вы владелец пространства' : 'Вы участник пространства'}</small>
      <button type="button" className="sheet-cancel" disabled={!online || Boolean(busyAction)} onClick={onCreateWorkspace}>Создать новое пространство</button>
    </div>
    <div className="settings-group">
      <h2>Участники</h2>
      {loading && <p className="management-state" role="status">Загружаем участников…</p>}
      {loadError && <p className="management-state" role="status"><span>{loadError}</span>{online&&<button type="button" onClick={()=>void refresh()}>Повторить</button>}</p>}
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
        {invitations.map((item) => <div className="management-row" key={item.id}><span>Активное приглашение<small>до {new Date(item.expiresAt).toLocaleString('ru-RU')}</small></span><button type="button" disabled={!online || Boolean(busyAction)} onClick={() => void (async()=>{if(!await confirm({title:'Отозвать приглашение?',message:'Ссылка сразу перестанет работать.',confirmLabel:'Отозвать',danger:true}))return;await runAction(`invite-${item.id}`, async () => { await revokeInvitation(workspace.id, item.id); await refresh() }, 'Не удалось отозвать приглашение', 'Приглашение отозвано')})()}>{busyAction===`invite-${item.id}`?'Отзываем…':'Отозвать'}</button></div>)}
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
      <label>Ваше имя<input value={name} maxLength={80} disabled={!online || busyAction === 'display-name'} aria-busy={busyAction === 'display-name'} onChange={(event) => {setName(event.target.value);setDisplayNameState(event.target.value.trim()===user.user.displayName?'idle':'dirty')}} onBlur={() => void saveDisplayName()}/><span className={`field-state ${displayNameState}`}>{displayNameState==='dirty'?'Сохранится после выхода из поля':displayNameState==='saving'?'Сохраняем…':displayNameState==='saved'?'Сохранено':displayNameState==='error'?'Не удалось сохранить — возвращено прежнее имя':''}</span></label>
      <button type="button" className="sheet-cancel" disabled={!online || Boolean(busyAction)} onClick={() => void device()}>{busyAction === 'device' ? 'Готовим ссылку…' : 'Подключить моё устройство'}</button>
      {loading && <p className="management-state" role="status">Загружаем устройства…</p>}
      {!loading && !loadError && !devices.length && <p className="management-state" role="status">Подключённых устройств пока нет.</p>}
      {devices.map((deviceItem) => <div className="management-row" key={deviceItem.id}>
        <span>{deviceItem.label}<small>{deviceItem.current ? 'Это устройство' : `Активность: ${new Date(deviceItem.lastSeenAt).toLocaleString('ru-RU')}`}</small></span>
        {!deviceItem.current && <button type="button" disabled={!online || Boolean(busyAction)} onClick={() => void (async()=>{if(!await confirm({title:'Отключить устройство?',message:`Устройство «${deviceItem.label}» потеряет доступ к профилю.`,confirmLabel:'Отключить',danger:true}))return;await runAction(`device-${deviceItem.id}`, async () => { await revokeSession(deviceItem.id); await refresh() }, 'Не удалось отключить сессию', 'Устройство отключено')})()}>{busyAction===`device-${deviceItem.id}`?'Отключаем…':'Отключить'}</button>}
      </div>)}
      {!user.user.recoveryConfigured && <p className="page-intro device-note">Восстановление пока не настроено. Без сохранённой ссылки доступ нельзя будет вернуть после потери всех устройств.</p>}
      <button type="button" className="primary" disabled={!online || Boolean(busyAction)} onClick={() => void rotateRecovery()}>{busyAction === 'recovery' ? 'Готовим ссылку…' : user.user.recoveryConfigured ? 'Создать новую ссылку восстановления' : 'Настроить восстановление'}</button>
    </div>
    {link && <AccessLinkSheet link={link} onClose={() => setLink(null)} onRevoke={(reason) => showError(reason, 'Не удалось отозвать ссылку')}/>}
    {recovery && <RecoverySave key={recovery.completionToken} prepared={recovery} mode={user.user.recoveryConfigured ? 'rotation' : 'initial'} close={() => setRecovery(null)} complete={completeRotation}/>}
    {confirmation}
  </>
}

const bybitRegions: Array<{id:BybitRegion;label:string}> = [
  {id:'global',label:'Global / Serbia'}, {id:'eu',label:'European Union'}, {id:'kz',label:'Kazakhstan'},
  {id:'ge',label:'Georgia'}, {id:'ae',label:'UAE'}, {id:'tr',label:'Turkey'}, {id:'nl',label:'Netherlands'}, {id:'id',label:'Indonesia'},
]

function BybitConnectionPanel({ workspace, workspaceId, status, online, onStatus }: { workspace:WorkspaceSummary;workspaceId:string;status:BybitCardStatus|null;online:boolean;onStatus:(status:BybitCardStatus)=>void }) {
  const [editing,setEditing]=useState(false)
  const [apiKey,setApiKey]=useState('')
  const [apiSecret,setApiSecret]=useState('')
  const [region,setRegion]=useState<BybitRegion>('global')
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const {confirm,confirmation}=useConfirm()
  const manage=workspace.role==='owner'&&status?.canManage!==false
  const connect=async(event:React.FormEvent)=>{
    event.preventDefault();if(!apiKey.trim()||!apiSecret.trim())return setError('Введите API key и secret.')
    setBusy(true);setError('')
    try{
      const next=await connectBybitCard(workspaceId,apiKey.trim(),apiSecret.trim(),region)
      onStatus(next);setApiKey('');setApiSecret('');setEditing(false)
    }catch(reason){setError(reason instanceof ApiError?reason.message:'Не удалось подключить Bybit Card')}
    finally{setBusy(false)}
  }
  const sync=async()=>{
    setBusy(true);setError('')
    try{onStatus(await syncBybitCard(workspaceId))}catch(reason){setError(reason instanceof ApiError?reason.message:'Не удалось синхронизировать Bybit Card')}
    finally{setBusy(false)}
  }
  const disconnect=async()=>{
    if(!await confirm({title:'Отключить Bybit Card?',message:'Необработанные операции удалятся. Уже созданные расходы останутся в истории.',confirmLabel:'Отключить',danger:true}))return
    setBusy(true);setError('')
    try{await disconnectBybitCard(workspaceId);onStatus({connected:false,canManage:true,pendingCount:0});setEditing(false)}
    catch(reason){setError(reason instanceof ApiError?reason.message:'Не удалось отключить Bybit Card')}
    finally{setBusy(false)}
  }
  return <div className="settings-group bybit-settings"><h2>Bybit Card</h2><div className="integration-card">
    <div className="integration-title"><span className="bybit-mark">B</span><span><b>Bybit Card</b><small>{status===null?'Проверяем подключение…':status.connected?status.status==='error'?'Подключено · нужна синхронизация':'Подключено':'Не подключено'}</small></span>{status?.connected&&<i className={status.status==='error'?'error':'active'}/>}</div>
    {status?.connected?<>
      <p>Новые платежи учитываются только с {new Date(status.enabledAt!).toLocaleString('ru-RU')}. Более ранняя история не импортируется.</p>
      {status.lastSyncedAt&&<small className="integration-meta">Последняя синхронизация: {new Date(status.lastSyncedAt).toLocaleString('ru-RU')}</small>}
      {status.lastError&&<p className="form-error" role="alert">{status.lastError}</p>}
      <button type="button" className="sheet-cancel" disabled={!online||busy} onClick={()=>void sync()}>{busy?'Синхронизируем…':'Синхронизировать сейчас'}</button>
      {manage&&<button type="button" className="danger-link" disabled={!online||busy} onClick={()=>void disconnect()}>Отключить интеграцию</button>}
    </>:manage?<>
      <p>Moapp загрузит только платежи, совершённые после включения интеграции. Нужен отдельный read-only ключ с разрешением BitCard.</p>
      {!editing?<button type="button" className="primary" disabled={!online||status===null} onClick={()=>setEditing(true)}>Подключить Bybit Card</button>:<form className="integration-form" onSubmit={(event)=>void connect(event)}>
        <label>Регион аккаунта<Select label="Регион аккаунта" value={region} disabled={busy} onChange={(value)=>setRegion(value as BybitRegion)} options={bybitRegions.map((item)=>({value:item.id,label:item.label}))}/></label>
        {region==='eu'&&<small className="integration-meta">Для EU Bybit требует ключ, созданный через Connect to Third-Party Applications.</small>}
        <label>API key<input autoComplete="off" value={apiKey} disabled={busy} maxLength={256} onChange={(event)=>setApiKey(event.target.value)}/></label>
        <label>API secret<input type="password" autoComplete="new-password" value={apiSecret} disabled={busy} maxLength={512} onChange={(event)=>setApiSecret(event.target.value)}/></label>
        <button className="primary" disabled={busy||!online}>{busy?'Проверяем ключ…':'Включить интеграцию'}</button><button type="button" className="sheet-cancel" disabled={busy} onClick={()=>{setEditing(false);setError('')}}>Отмена</button>
      </form>}
    </>:<p>Подключить карту может владелец пространства.</p>}
    {error&&<p className="form-error" role="alert">{error}</p>}
  </div>{confirmation}</div>
}

type ReviewAction={transaction:BybitCardTransaction;expense?:Expense;categoryId?:string;comment:string;tagIds:string[]}

export function BybitReviewView({ workspaceId, categories, currencies, tags=[], onTag=()=>{}, online, onExpense, onExpenseUndo, onStatus }: {workspaceId:string;categories:Category[];currencies:Currency[];tags?:Tag[];onTag?:(tag:Tag)=>void;online:boolean;onExpense:(expense:Expense)=>void;onExpenseUndo:(expenseId:string)=>void;onStatus:(status:Partial<BybitCardStatus>&Pick<BybitCardStatus,'pendingCount'>)=>void}) {
  const [items,setItems]=useState<BybitCardTransaction[]>([])
  const [deferred,setDeferred]=useState<BybitCardTransaction[]>([])
  const [comment,setComment]=useState('')
  const [selectedCategoryId,setSelectedCategoryId]=useState<string|null>(null)
  const [selectedTagIds,setSelectedTagIds]=useState<string[]>([])
  const [loading,setLoading]=useState(true)
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const {toast:notice,notify,dismiss}=useToast()
  const {confirm,confirmation}=useConfirm()
  const current=items[0]
  const activeCategories=categories.filter((item)=>!item.archivedAt).sort((a,b)=>(a.placement==='main'?0:1)-(b.placement==='main'?0:1)||a.sortOrder-b.sortOrder)
  useEffect(()=>{const controller=new AbortController();setLoading(true);setDeferred([]);listBybitCardTransactions(workspaceId,controller.signal).then((result)=>{setItems(result.transactions);onStatus({pendingCount:result.pendingCount})}).catch((reason)=>{if(!controller.signal.aborted)setError(reason instanceof ApiError?reason.message:'Не удалось загрузить операции')}).finally(()=>{if(!controller.signal.aborted)setLoading(false)});return()=>controller.abort()},[workspaceId]) // eslint-disable-line react-hooks/exhaustive-deps
  const removeCurrent=(transaction:BybitCardTransaction,pendingCount:number)=>{setItems((value)=>value.filter((item)=>item.id!==transaction.id));setComment('');setSelectedCategoryId(null);setSelectedTagIds([]);onStatus({pendingCount})}
  const undo=async(action:ReviewAction)=>{
    if(busy||!online)return;setBusy(true);setError('')
    try{const result=await undoBybitCardTransaction(workspaceId,action.transaction.id,action.expense);if(result.undoneExpenseId)onExpenseUndo(result.undoneExpenseId);setItems((value)=>[result.transaction,...value.filter((item)=>item.id!==result.transaction.id)]);setDeferred((value)=>value.filter((item)=>item.id!==result.transaction.id));setComment(action.comment);setSelectedCategoryId(action.categoryId??null);setSelectedTagIds(action.tagIds);onStatus({pendingCount:result.pendingCount});tap(6)}
    catch(reason){setError(reason instanceof ApiError?reason.message:'Не удалось отменить последнее действие')}
    finally{setBusy(false)}
  }
  const classify=async(categoryId:string)=>{
    if(!current||busy||!online)return;const transaction=current;const action:ReviewAction={transaction,categoryId,comment,tagIds:selectedTagIds};setSelectedCategoryId(categoryId);setBusy(true);setError('')
    try{const result=await classifyBybitCardTransaction(workspaceId,transaction.id,categoryId,comment,selectedTagIds);action.expense=result.expense;onExpense(result.expense);removeCurrent(transaction,result.pendingCount);notify('Расход добавлен',{label:'Отменить',run:()=>void undo(action)});tap(8)}
    catch(reason){setError(reason instanceof ApiError?reason.message:'Не удалось классифицировать операцию')}
    finally{setBusy(false)}
  }
  const ignore=async()=>{
    if(!current||busy||!online||!await confirm({title:'Не учитывать операцию?',message:'Она исчезнет из очереди и не станет расходом. Это действие можно отменить до выхода из разбора.',confirmLabel:'Не учитывать',danger:true}))return
    const transaction=current;const action:ReviewAction={transaction,comment,categoryId:selectedCategoryId??undefined,tagIds:selectedTagIds};setBusy(true);setError('');try{const result=await ignoreBybitCardTransaction(workspaceId,transaction.id);removeCurrent(transaction,result.pendingCount);notify('Операция не учтена',{label:'Отменить',run:()=>void undo(action)})}catch(reason){setError(reason instanceof ApiError?reason.message:'Не удалось пропустить операцию')}finally{setBusy(false)}
  }
  const skip=()=>{if(!current||busy)return;setItems((value)=>value.slice(1));setDeferred((value)=>[...value,current]);setComment('');setSelectedCategoryId(null);setSelectedTagIds([]);tap(5)}
  const restoreDeferred=()=>{setItems(deferred);setDeferred([]);setComment('');setSelectedCategoryId(null);setSelectedTagIds([])}
  return <><section className="page bybit-review-page" aria-labelledby="bybit-review-title">
    <h1 className="sr-only" id="bybit-review-title">Разбор операций Bybit Card</h1>
    {loading?<p className="management-state" role="status">Загружаем операции…</p>:current?<>
      <header className="topline review-topline"><div><p className="eyebrow">Bybit Card · к разбору {items.length}</p><p className="review-date">{new Date(current.occurredAt).toLocaleString('ru-RU',{weekday:'short',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'})}</p></div>{deferred.length>0&&<span className="review-deferred">Отложено · {deferred.length}</span>}</header>
      <div className="amount-row review-amount-row"><output className="amount-value" aria-label="Сумма">{amountNumber(current.amountMinor,current.currency,currencies)}</output><span className="review-currency">{current.currency}</span></div>
      <article className="review-merchant">
        <span className="bybit-mark">B</span><div><h3>{current.merchantName||'Без названия продавца'}</h3><p>{current.type==='atm'?'Снятие наличных':current.merchantCategory||'Покупка'}{current.merchantCity?` · ${[current.merchantCity,current.merchantCountry].filter(Boolean).join(', ')}`:''}{current.mccCode?` · MCC ${current.mccCode}`:''}</p></div>
      </article>
      <p className="review-hint">Выберите категорию — расход сохранится сразу</p>
      <div className="review-categories">{activeCategories.map((category)=><button type="button" key={category.id} className={selectedCategoryId===category.id?'selected':''} aria-pressed={selectedCategoryId===category.id} disabled={busy||!online} onClick={()=>void classify(category.id)}><i style={{background:category.color??'#a9afa5'}}/><span>{category.name}</span></button>)}</div>
      <div className="review-tags"><span>Теги</span><TagStrip tags={tags} selected={selectedTagIds} disabled={busy} online={online} onChange={setSelectedTagIds} onCreate={(name)=>createTagOrReuse(workspaceId,name,TAG_COLORS[tags.length%TAG_COLORS.length]??null,onTag)}/></div>
      <label className="review-comment">Комментарий <span>необязательно</span><input maxLength={300} disabled={busy} placeholder="Добавить заметку к расходу" value={comment} onChange={(event)=>setComment(event.target.value)}/></label>
      <div className="review-secondary"><button type="button" disabled={busy} onClick={skip}>Пропустить пока</button><button type="button" disabled={busy||!online} onClick={()=>void ignore()}>Не учитывать</button></div>
    </>:<div className="review-done"><span>{deferred.length?'↪':'✓'}</span><h3>{deferred.length?'На сейчас всё':'Всё разобрано'}</h3><p>{deferred.length?`${deferred.length} ${deferred.length===1?'операция отложена':'операции отложены'} только в этой сессии разбора.`:'Новые операции появятся после следующей синхронизации.'}</p>{deferred.length>0&&<button type="button" className="primary" onClick={restoreDeferred}>Вернуться к отложенным · {deferred.length}</button>}</div>}
    {!online&&<p className="management-state" role="status">Без сети можно просматривать и временно откладывать операции. Категория и отмена сохранятся после подключения.</p>}
    {error&&<p className="form-error" role="alert">{error}</p>}
  </section>{notice&&<Toast toast={notice} onDismiss={dismiss}/>} {confirmation}</>
}

export function SettingsView({ user, workspace, workspaceId, bootstrap, setBootstrap, pendingCount, refreshPending, onLogout, theme, onThemeChange, onSession, onCreateWorkspace, online, bybitStatus=null, onBybitStatus=()=>{} }: { user: AuthenticatedSession; workspace:WorkspaceSummary; workspaceId:string; bootstrap:Bootstrap; setBootstrap:React.Dispatch<React.SetStateAction<Bootstrap>>; pendingCount:number; refreshPending:()=>void;onLogout:()=>void;theme:Theme;onThemeChange:(theme:Theme)=>void;onSession:(session:SessionState)=>Promise<void>;onCreateWorkspace:()=>void;online:boolean;bybitStatus?:BybitCardStatus|null;onBybitStatus?:(status:BybitCardStatus)=>void }) {
  const [section,setSection]=useState<'space'|'integrations'|'general'>('space')
  const [editing,setEditing]=useState<Category|null>(null)
  const [adding,setAdding]=useState(false)
  const [moving,setMoving]=useState<string|null>(null)
  const [editingTag,setEditingTag]=useState<Tag|null>(null)
  const [addingTag,setAddingTag]=useState(false)
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
  const tags=sortTags(bootstrap.tags??[])
  const [movingTag,setMovingTag]=useState<string|null>(null)
  const saveTag=async(name:string,color:string|null)=>{
    try{
      const saved=editingTag?await updateTag(workspaceId,editingTag.id,{name,color,version:editingTag.version}):await createTag(workspaceId,{name,color})
      setBootstrap((b)=>({...b,tags:[saved,...(b.tags??[]).filter((x)=>x.id!==saved.id)]}))
      setEditingTag(null);setAddingTag(false);setNotice(editingTag?'Тег переименован':'Тег создан')
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
  const moveTag=async(tag:Tag,direction:-1|1)=>{
    if(!online||movingTag)return
    const index=tags.findIndex((x)=>x.id===tag.id),next=index+direction;if(next<0||next>=tags.length)return
    setMovingTag(tag.id)
    const ordered=[...tags];[ordered[index],ordered[next]]=[ordered[next]!,ordered[index]!]
    const previous=new Map(tags.map((x)=>[x.id,x.sortOrder]))
    setBootstrap((b)=>({...b,tags:(b.tags??[]).map((x)=>{const at=ordered.findIndex((o)=>o.id===x.id);return at>=0?{...x,sortOrder:at}:x})}))
    try{const result=await reorderTags(workspaceId,ordered.map((x)=>x.id));setBootstrap((b)=>({...b,tags:result.tags}))}
    catch(error){setBootstrap((b)=>({...b,tags:(b.tags??[]).map((x)=>previous.has(x.id)?{...x,sortOrder:previous.get(x.id)!}:x)}));setNotice(error instanceof ApiError?error.message:'Не удалось изменить порядок тегов',undefined,true)}
    setMovingTag(null)
  }
  const groups:[Category['placement'],string][]=[['main','Основные'],['additional','Дополнительные']]
  const sections=[
    {id:'space' as const,label:'Пространство',caption:'Участники и доступ'},
    {id:'integrations' as const,label:'Интеграции',caption:bybitStatus?.connected?'Bybit подключён':'Подключения'},
    {id:'general' as const,label:'Общее',caption:'Тема, категории и теги'},
  ]
  return <section className="page settings-page"><header className="page-header settings-title"><div><p className="eyebrow">{workspace.name}</p><h1>Настройки</h1></div></header>
    <nav className="settings-sections" aria-label="Разделы настроек">{sections.map((item)=><button type="button" key={item.id} aria-current={section===item.id?'page':undefined} className={section===item.id?'selected':''} onClick={()=>setSection(item.id)}><b>{item.label}</b><small>{item.caption}</small></button>)}</nav>
    {section==='space'&&<div className="settings-section-panel"><div className="settings-section-copy"><p className="eyebrow">Пространство</p><h2>Люди и доступ</h2><p>Название пространства, участники, устройства и восстановление.</p></div><AccessSettings user={user} workspace={workspace} pendingCount={pendingCount} online={online} onSession={onSession} onCreateWorkspace={onCreateWorkspace} onNotice={accessNotice} onBusyChange={setAccessBusy}/><div className="settings-group"><h2>Локальный профиль</h2><p className="page-intro device-note">Расходы и сессия сохраняются в этом браузере для работы без интернета. Не используйте эту функцию на общем устройстве.</p><button type="button" className="danger-link" disabled={accessBusy||Boolean(moving)} onClick={onLogout}>Выйти и удалить локальные данные</button></div></div>}
    {section==='integrations'&&<div className="settings-section-panel"><div className="settings-section-copy"><p className="eyebrow">Интеграции</p><h2>Подключённые сервисы</h2><p>Автоматический импорт операций из внешних источников.</p></div><BybitConnectionPanel workspace={workspace} workspaceId={workspaceId} status={bybitStatus} online={online} onStatus={onBybitStatus}/></div>}
    {section==='general'&&<div className="settings-section-panel"><div className="settings-section-copy"><p className="eyebrow">Общее</p><h2>Вид и категории</h2><p>Оформление этого устройства и структура быстрых кнопок расходов.</p></div><div className="settings-group"><h2>Оформление</h2><div className="theme-setting"><div><b>Тема</b><small>Сохраняется только на этом устройстве</small></div><div className="theme-toggle" role="group" aria-label="Тема оформления"><button type="button" className={theme==='light'?'selected':''} aria-pressed={theme==='light'} onClick={()=>onThemeChange('light')}>Светлая</button><button type="button" className={theme==='dark'?'selected':''} aria-pressed={theme==='dark'} onClick={()=>onThemeChange('dark')}>Тёмная</button></div></div></div><p className="page-intro">Настройте быстрые кнопки и их порядок. Категории меняются только онлайн; архивные останутся в истории.</p>
      <div className="settings-group"><button type="button" className="primary" disabled={!online} onClick={()=>setAdding(true)}>Новая категория</button></div>
      {groups.map(([placement,title])=>{const items=bootstrap.categories.filter((x)=>x.placement===placement&&!x.archivedAt).sort((a,b)=>a.sortOrder-b.sortOrder);return <div className="settings-group" key={placement}><h2>{title}</h2>{items.map((category,index)=><div className="category-row" key={category.id}><i style={{background:category.color ?? '#a9afa5'}}/><button type="button" className="category-name" disabled={!online||Boolean(moving)} onClick={()=>setEditing(category)}>{category.name}</button><button type="button" disabled={!online||Boolean(moving)||index===0} onClick={()=>void move(category,-1)} aria-label={`Поднять категорию ${category.name}`}>↑</button><button type="button" disabled={!online||Boolean(moving)||index===items.length-1} onClick={()=>void move(category,1)} aria-label={`Опустить категорию ${category.name}`}>↓</button></div>)}{!items.length&&<p className="management-state" role="status">Категорий в этом разделе пока нет.</p>}</div>})}
      <div className="settings-group"><h2>Теги</h2><p className="page-intro">Короткие метки поверх категорий: любой тег можно повесить на любой расход.</p>{tags.length?tags.map((tag,index)=><div className="category-row" key={tag.id}><i style={{background:tag.color??'#a9afa5'}}/><button type="button" className="category-name" disabled={!online||Boolean(movingTag)} onClick={()=>setEditingTag(tag)}>{tag.name}</button><button type="button" disabled={!online||Boolean(movingTag)||index===0} onClick={()=>void moveTag(tag,-1)} aria-label={`Поднять тег ${tag.name}`}>↑</button><button type="button" disabled={!online||Boolean(movingTag)||index===tags.length-1} onClick={()=>void moveTag(tag,1)} aria-label={`Опустить тег ${tag.name}`}>↓</button></div>):<p className="management-state">Тегов пока нет.</p>}<button type="button" className="sheet-cancel" disabled={!online} onClick={()=>setAddingTag(true)}>Новый тег</button></div>
      {(editing||adding)&&<CategoryEditor category={editing} colors={colors} onClose={()=>{setEditing(null);setAdding(false)}} onSave={save}/>}
      {(editingTag||addingTag)&&<TagEditor tag={editingTag} onClose={()=>{setEditingTag(null);setAddingTag(false)}} onSave={saveTag} onDelete={editingTag?()=>removeTag(editingTag):undefined}/>}</div>}
    {notice&&<Toast toast={notice} onDismiss={hideNotice}/>}
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
  return <><div className="sheet-backdrop" onMouseDown={()=>{if(!busy)onClose()}}><form ref={dialogRef as React.Ref<HTMLFormElement>} className="bottom-sheet editor" role="dialog" aria-modal="true" aria-labelledby="category-editor-title" noValidate onSubmit={(e)=>{e.preventDefault();void submit(draft)}} onMouseDown={(e)=>e.stopPropagation()}><div className="sheet-handle"/><div className="sheet-title"><h2 id="category-editor-title">{category?'Изменить':'Новая категория'}</h2><button type="button" className="icon-button" data-dialog-initial-focus disabled={busy} aria-label="Закрыть" onClick={onClose}>×</button></div><label>Название<input maxLength={40} aria-invalid={Boolean(validation)} value={draft.name} onChange={(e)=>{setValidation('');setDraft({...draft,name:e.target.value})}}/></label>{validation&&<p className="form-error" role="alert">{validation}</p>}<fieldset><legend>Цвет</legend><div className="colors">{colors.map((color,index)=><button aria-label={`Цвет: ${colorNames[index] ?? color}`} aria-pressed={draft.color===color} type="button" key={color} className={draft.color===color?'selected':''} style={{background:color}} onClick={()=>setDraft({...draft,color})}/>)}</div></fieldset><label>Размещение<Select label="Размещение" value={draft.placement} onChange={(value)=>setDraft({...draft,placement:value as Category['placement']})} options={[{value:'main',label:'Основные'},{value:'additional',label:'Дополнительные'}]}/></label><button className="primary" disabled={busy}>{busy?'Сохраняем…':'Сохранить'}</button>{category&&<button type="button" className="danger-link" disabled={busy} onClick={()=>void (async()=>{if(await confirm({title:'Архивировать категорию?',message:'Она исчезнет из выбора, но останется у старых расходов.',confirmLabel:'Архивировать',danger:true}))await submit({...draft,archivedAt:new Date().toISOString()})})()}>Архивировать</button>}</form></div>{confirmation}</>
}

const tabs:{id:Tab;label:string}[]=[{id:'entry',label:'Расход'},{id:'history',label:'История'},{id:'analytics',label:'Аналитика'},{id:'review',label:'Разбор'},{id:'settings',label:'Настройки'}]
const tabsWithoutReview=tabs.filter((item)=>item.id!=='review')

function NavIcon({ tab }: { tab: Tab }) {
  if(tab==='entry')return <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 8v8M8 12h8"/></svg>
  if(tab==='history')return <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/></svg>
  if(tab==='analytics')return <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19V13M12 19V5M19 19V9M3.5 19h17"/></svg>
  if(tab==='review')return <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10v16H7zM9.5 8h5M9.5 12h5M9.5 16h3"/><path d="m4 8-2 2 2 2M20 12l2 2-2 2"/></svg>
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
  return <div className="sheet-backdrop" onMouseDown={()=>{if(allowLater&&!busy)close()}}><section ref={dialogRef} className="bottom-sheet access-sheet" role="dialog" aria-modal="true" aria-labelledby="recovery-save-title" onMouseDown={(event)=>event.stopPropagation()}><div className="sheet-handle"/><h2 id="recovery-save-title">Сохраните ссылку восстановления</h2><p>{warning}</p><p>Подтвердить нужно до {new Date(prepared.expiresAt).toLocaleString('ru-RU',{dateStyle:'short',timeStyle:'short'})}.</p><div className="qr"><QRCodeSVG value={prepared.recoveryUrl} size={180}/></div><code className="access-link">{prepared.recoveryUrl}</code>{feedback&&<p className="inline-feedback" role={feedbackError?'alert':'status'}>{feedback}</p>}<button type="button" className="sheet-cancel" data-dialog-initial-focus onClick={()=>void copyRecovery()}>Скопировать</button>{typeof navigator.share==='function'&&<button type="button" className="sheet-cancel" onClick={()=>void shareRecovery()}>Поделиться</button>}<label className="check-line"><input type="checkbox" checked={saved} onChange={(event)=>setSaved(event.target.checked)}/> Я сохранил ссылку</label>{error&&<p className="form-error" role="alert">{error}</p>}<button type="button" className="primary" disabled={!saved||busy} onClick={()=>void finish()}>{busy?'Проверяем…':'Завершить'}</button>{allowLater&&<button type="button" className="sheet-cancel" disabled={busy} onClick={close}>Позже</button>}</section></div>
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
  useInputModality()
  const [state,setState]=useState(()=>createAppState(capability))
  const [pagerState,setPagerState]=useState<{workspaceId:string|null;tab:Tab;mounted:Tab[]}>({workspaceId:null,tab:'entry',mounted:['entry']})
  const [currentId,setCurrentId]=useState<string|null>(null)
  const [createOpen,setCreateOpen]=useState(false)
  const [switchOpen,setSwitchOpen]=useState(false)
  const [issuesOpen,setIssuesOpen]=useState(false)
  const [bybitRuntime,setBybitRuntime]=useState<{workspaceId:string;status:BybitCardStatus}|null>(null)
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
  const reviewConnected=bybitRuntime?.workspaceId===state.activeWorkspaceId&&bybitRuntime.status.connected
  const navigationTabs=reviewConnected?tabs:tabsWithoutReview
  const setTab=useCallback((next:Tab)=>{
    const workspaceId=stateRef.current.activeWorkspaceId
    setPagerState((previous)=>previous.workspaceId===workspaceId?{workspaceId,tab:next,mounted:[...previous.mounted,...pagerTabsFor(next).filter((item)=>!previous.mounted.includes(item))]}:{workspaceId,tab:next,mounted:pagerTabsFor(next)})
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
    const left=Math.max(0,navigationTabs.findIndex((item)=>item.id===tab))*node.clientWidth
    if(Math.abs(node.scrollLeft-left)<1)return
    // Тап по вкладке едет так же плавно, как свайп между страницами. Пока лента в пути, обработчик скролла
    // не должен переключать вкладку на промежуточную, иначе анимация развернётся обратно.
    pagerTarget.current=left
    if(typeof node.scrollTo==='function')node.scrollTo({left,behavior:prefersReducedMotion()?'auto':'smooth'})
    else node.scrollLeft=left
  },[state.activeWorkspaceId,tab,reviewConnected,Boolean(state.activeWorkspaceId&&state.runtimes[state.activeWorkspaceId]?.bootstrap)])
  useEffect(()=>()=>clearTimeout(pagerTimer.current),[])
  const pagerTarget=useRef<number|null>(null)

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
  useEffect(()=>{if(tab==='review'&&!reviewConnected)setTab('settings')},[reviewConnected,setTab,tab])

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

  const confirmDraftDiscard=async()=>!draftDirty||confirm({title:'Отбросить изменения?',message:'Несохранённая сумма, категория, дата и заметка будут потеряны.',confirmLabel:'Отбросить',danger:true})
  const openCreate=async()=>{if(await confirmDraftDiscard()){setSwitchOpen(false);setCreateOpen(true)}}
  const openExpense=async(id:string|null)=>{
    if(id!==currentId&&!await confirmDraftDiscard())return
    setCurrentId(id)
    setDraftDirty(false)
    setTab('entry')
  }
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
    pagerTimer.current=setTimeout(()=>{const node=pager.current;if(!node?.clientWidth)return;if(pagerTarget.current!==null&&Math.abs(node.scrollLeft-pagerTarget.current)>1)return;pagerTarget.current=null;const item=navigationTabs[Math.max(0,Math.min(navigationTabs.length-1,Math.round(node.scrollLeft/node.clientWidth)))];if(item)setTab(item.id)},90)
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
  const serverAvailable=online&&!runtime.offline
  return <div className="app-shell" key={workspaceId}>
    <header className="workspace-header"><button type="button" className="workspace-name-button" onClick={()=>setSwitchOpen(true)}><span>{workspace.name}</span><ChevronIcon/></button><div className="workspace-header-actions">{updateWaiting&&<button type="button" className="update-button" onClick={activateUpdate}>Обновить</button>}{stats.conflicts||stats.failed?<button type="button" className="sync-status attention" onClick={()=>setIssuesOpen(true)} aria-label={`Нужна проверка: ${stats.conflicts+stats.failed}`}><span>Нужна проверка · {stats.conflicts+stats.failed}</span><i/></button>:!serverAvailable?<button type="button" className="sync-status offline" onClick={()=>setWorkspaceReloadEpoch((value)=>value+1)} aria-label="Нет связи с сервером. Повторить подключение"><span>{stats.total?`Нет связи · ${stats.total}`:'Нет связи с сервером'}</span><i/></button>:stats.total?<div className="sync-status" role="status" aria-live="polite"><span>Отправляем · {stats.total}</span><i/></div>:null}</div></header>
    <main className="pager" ref={pager} onScroll={onPagerScroll} onPointerDown={()=>{pagerTarget.current=null}} onTouchStart={()=>{pagerTarget.current=null}}>
      <div className="page-slot" inert={tab!=='entry'} aria-hidden={tab!=='entry'}>{mountedTabs.includes('entry')&&<EntryView userId={auth.user.id} workspaceId={workspaceId} bootstrap={bootstrap} setBootstrap={setWorkspaceData} currentId={currentId} setCurrentId={setCurrentId} refreshPending={refreshPending} onDraftDirtyChange={setDraftDirty} active={tab==='entry'}/>}</div>
      <div className="page-slot" inert={tab!=='history'} aria-hidden={tab!=='history'}>{mountedTabs.includes('history')&&<HistoryView userId={auth.user.id} workspaceId={workspaceId} bootstrap={bootstrap} setBootstrap={setWorkspaceData} edit={(id)=>void openExpense(id)} createNew={()=>void openExpense(null)} refreshPending={refreshPending}/>}</div>
      <div className="page-slot" inert={tab!=='analytics'} aria-hidden={tab!=='analytics'}>{mountedTabs.includes('analytics')&&<AnalyticsView userId={auth.user.id} workspaceId={workspaceId} bootstrap={bootstrap} theme={theme} online={serverAvailable}/>}</div>
      {reviewConnected&&<div className="page-slot review-page-slot" inert={tab!=='review'} aria-hidden={tab!=='review'}>{mountedTabs.includes('review')&&<BybitReviewView workspaceId={workspaceId} categories={bootstrap.categories} currencies={bootstrap.currencies} tags={bootstrap.tags??[]} onTag={(tag)=>setWorkspaceData((data)=>({...data,tags:[tag,...(data.tags??[]).filter((item)=>item.id!==tag.id)]}))} online={serverAvailable} onStatus={updateBybitStatus} onExpense={(expense)=>setWorkspaceData((data)=>({...data,expenses:[expense,...data.expenses.filter((item)=>item.id!==expense.id)]}))} onExpenseUndo={(expenseId)=>setWorkspaceData((data)=>({...data,expenses:data.expenses.filter((item)=>item.id!==expenseId)}))}/>}</div>}
      <div className="page-slot" inert={tab!=='settings'} aria-hidden={tab!=='settings'}>{mountedTabs.includes('settings')&&<SettingsView user={auth} workspace={workspace} workspaceId={workspaceId} bootstrap={bootstrap} setBootstrap={setWorkspaceData} pendingCount={stats.total} refreshPending={refreshPending} onLogout={()=>void logoutCurrent()} theme={theme} onThemeChange={setTheme} onSession={(next)=>hydrate(next,false,settingsIdentityEpoch)} onCreateWorkspace={()=>void openCreate()} online={serverAvailable} bybitStatus={bybitStatus} onBybitStatus={(status)=>updateBybitStatus(status)}/>}</div>
    </main>
    <nav className="bottom-nav" aria-label="Основная навигация">{navigationTabs.map((item)=><button type="button" key={item.id} aria-current={tab===item.id?'page':undefined} aria-label={item.id==='review'&&bybitStatus?.pendingCount?`Разбор: ${bybitStatus.pendingCount}`:item.label} className={tab===item.id?'active':''} onClick={()=>{if(tab!==item.id)tap(4);setTab(item.id)}}><span><NavIcon tab={item.id}/>{item.id==='review'&&Boolean(bybitStatus?.pendingCount)&&<b className="nav-badge">{bybitStatus!.pendingCount>99?'99+':bybitStatus!.pendingCount}</b>}</span><small>{item.label}</small></button>)}</nav>
    {switchOpen&&<WorkspaceSwitcher items={auth.workspaces} active={workspaceId} runtimes={state.runtimes} online={serverAvailable} onSelect={(id)=>void switchWorkspace(id)} onCreate={()=>void openCreate()}/>} {createOpen&&<CreateWorkspaceSheet existing onClose={()=>setCreateOpen(false)} onCreate={create}/>} {issuesOpen&&<SyncIssuesSheet userId={auth.user.id} workspaceId={workspaceId} online={serverAvailable} onClose={()=>setIssuesOpen(false)} onDiscard={discardIssues}/>} {initialRecovery&&<RecoverySave key={initialRecovery.completionToken} prepared={initialRecovery} mode="initial" close={()=>setInitialRecovery(null)} complete={async()=>{
      const outcome=await completeRotationSafely({prepared:initialRecovery,targetUserId:auth.user.id})
      if(outcome.status!=='completed')throw new Error(outcome.status==='rotation-stale'?'Параллельно была завершена другая настройка восстановления.':'Не удалось подтвердить настройку. Повторите из настроек.')
      await hydrate(outcome.session,true)
    }}/>}
    {error && <Toast toast={{text:error,urgent:true}} onDismiss={()=>setError('')}/>}
    {notice&&<Toast toast={notice} onDismiss={hideNotice}/>} {confirmation}
  </div>
}
