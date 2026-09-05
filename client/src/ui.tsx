import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { isServerReachable, probeServer, subscribeServerReachability } from './workspace-api'
import type { Currency } from './types'

export type Theme = 'light' | 'dark'

export const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'

export type BackgroundLock = { count: number; inert: boolean; ariaHidden: string | null }

export const backgroundLocks = new Map<HTMLElement, BackgroundLock>()

export function lockDialogBackground(node: HTMLElement) {
  const existing = backgroundLocks.get(node)
  if (existing) { existing.count += 1; return }
  backgroundLocks.set(node, { count: 1, inert: node.inert, ariaHidden: node.getAttribute('aria-hidden') })
  node.inert = true
  node.setAttribute('aria-hidden', 'true')
}

export function unlockDialogBackground(node: HTMLElement) {
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
export function useInputModality() {
  useEffect(() => {
    const root = document.documentElement
    const pointer = () => { root.dataset.input = 'pointer' }
    const keyboard = (event: KeyboardEvent) => { if (event.key === 'Tab' || event.key.startsWith('Arrow') || event.key === 'Enter' || event.key === ' ') root.dataset.input = 'keyboard' }
    window.addEventListener('pointerdown', pointer, true)
    window.addEventListener('keydown', keyboard, true)
    return () => { window.removeEventListener('pointerdown', pointer, true); window.removeEventListener('keydown', keyboard, true) }
  }, [])
}

export function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

// «Онлайн» — это и флаг браузера, и факт, что сервер отвечает: iOS нередко считает сеть доступной, когда запросы падают.
export function useOnlineStatus() {
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

export const SHEET_EXIT_MS = 180

export function useDialog(onClose: () => void, dismissible = true, instanceKey: unknown = null) {
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

export type ConfirmOptions = { title: string; message: string; confirmLabel: string; danger?: boolean }

export function ConfirmSheet({ options, onResult }: { options: ConfirmOptions; onResult: (confirmed: boolean) => void }) {
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

export function useConfirm() {
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

export async function copyText(value: string) {
  if (!navigator.clipboard?.writeText) throw new Error('Копирование недоступно. Выделите ссылку вручную.')
  await navigator.clipboard.writeText(value)
}

export function tap(pattern: number | number[] = 8) {
  navigator.vibrate?.(pattern)
}

export const ChevronIcon = () => <svg className="chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6l5 5 5-5"/></svg>

export const CheckIcon = () => <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5"/></svg>

export type SelectOption = { value: string; label: string; hint?: string }

// Замена нативного <select>: системный список вариантов не стилизуется и выбивается из интерфейса,
// поэтому варианты открываются в той же нижней шторке, что валюта и категории.
export function Select({ label, title = label, value, options, onChange, disabled = false, searchable = options.length > 8, className = 'select-trigger', placeholder }: { label: string; title?: string; value: string; options: SelectOption[]; onChange: (value: string) => void; disabled?: boolean; searchable?: boolean; className?: string; placeholder?: string }) {
  const [open, setOpen] = useState(false)
  const current = options.find((option) => option.value === value)
  // Чип фильтра без значения называет сам фильтр («Категория»), а не «Все категории»: так видно, что включено.
  const text = !value && placeholder ? placeholder : current?.label ?? '—'
  return <>
    <button type="button" className={`${className}${value && className !== 'select-trigger' ? ' active' : ''}`} aria-label={label} aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={() => setOpen(true)}><span>{text}</span><ChevronIcon/></button>
    {open && <SelectSheet title={title} value={value} options={options} searchable={searchable} onClose={() => setOpen(false)} onSelect={(next) => { setOpen(false); if (next !== value) onChange(next) }}/>}
  </>
}

export function SelectSheet({ title, value, options, searchable, onClose, onSelect }: { title: string; value: string; options: SelectOption[]; searchable: boolean; onClose: () => void; onSelect: (value: string) => void }) {
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
export function useOverflowHint(ref: React.RefObject<HTMLElement | null>) {
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
export function MultiSelect({ label, title, placeholder, values, options, onChange, allLabel, count, className = 'filter-chip' }: { label: string; title: string; placeholder: string; values: string[]; options: SelectOption[]; onChange: (values: string[]) => void; allLabel: string; count: (n: number) => string; className?: string }) {
  const [open, setOpen] = useState(false)
  const text = values.length === 0 ? placeholder : values.length === 1 ? options.find((option) => option.value === values[0])?.label ?? placeholder : count(values.length)
  return <>
    <button type="button" className={`${className}${values.length ? ' active' : ''}`} aria-label={label} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><span>{text}</span><ChevronIcon/></button>
    {open && <MultiSelectSheet title={title} values={values} options={options} allLabel={allLabel} onClose={() => setOpen(false)} onChange={onChange}/>}
  </>
}

// Шит выбора нескольких значений: галочки, «Все …» снимает выбор, закрывает «Готово».
export function MultiSelectSheet({ title, values, options, allLabel, onClose, onChange }: { title: string; values: string[]; options: SelectOption[]; allLabel: string; onClose: () => void; onChange: (values: string[]) => void }) {
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

export const TrashIcon = () => <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>

export type ToastState = { text: string; urgent?: boolean; action?: { label: string; run: () => void }; id?: number; leaving?: boolean }

export const TOAST_EXIT_MS = 180

export let toastSequence = 0

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

export function Toast({ toast, onDismiss }: { toast: ToastState; onDismiss: () => void }) {
  const action = toast.action
  const leaving = toast.leaving ? ' leaving' : ''
  if (!action) return <div className={`toast toast-message${leaving}`} role={toast.urgent ? 'alert' : 'status'} aria-live={toast.urgent ? 'assertive' : 'polite'}><span>{toast.text}</span><button type="button" onClick={onDismiss} aria-label="Закрыть уведомление">×</button></div>
  return <div className={`toast toast-undo${leaving}`} role="status" aria-live="polite"><span>{toast.text}</span><button type="button" onClick={() => { onDismiss(); action.run() }}>{action.label}</button></div>
}

export function CurrencySheet({ currencies, used = [], selected, onClose, onSelect }: { currencies: Currency[]; used?: string[]; selected: string; onClose: () => void; onSelect: (code: string) => void }) {
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

export const GridIcon = () => <i className="grid-icon" aria-hidden="true"><svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><rect x="1.5" y="1.5" width="5" height="5" rx="1.5"/><rect x="9.5" y="1.5" width="5" height="5" rx="1.5"/><rect x="1.5" y="9.5" width="5" height="5" rx="1.5"/><rect x="9.5" y="9.5" width="5" height="5" rx="1.5"/></svg></i>

export const SearchIcon = () => <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>

export const LockIcon = () => <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/></svg>

// Шит со списком (участники, устройства, категории, теги): заголовок, содержимое, при необходимости — не закрывается, пока идёт запрос.
export function ListSheet({ title, onClose, dismissible = true, children }: { title: string; onClose: () => void; dismissible?: boolean; children: React.ReactNode }) {
  const dialogRef = useDialog(onClose, dismissible)
  const titleId = useId()
  return <div className="sheet-backdrop" onMouseDown={() => { if (dismissible) onClose() }}><section ref={dialogRef} className="bottom-sheet list-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(event) => event.stopPropagation()}>
    <div className="sheet-handle"/><div className="sheet-title"><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" data-dialog-initial-focus disabled={!dismissible} onClick={onClose} aria-label="Закрыть">×</button></div>
    {children}
  </section></div>
}

// Одно поле с кнопкой «Сохранить»: имена и названия правятся одинаково, без сохранения «после выхода из поля».
export function TextSheet({ title, value, placeholder, maxLength = 80, onClose, onSave }: { title: string; value: string; placeholder?: string; maxLength?: number; onClose: () => void; onSave: (value: string) => Promise<void> }) {
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
