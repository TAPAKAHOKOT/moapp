import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { isServerReachable, probeServer, subscribeServerReachability } from './workspace-api'
import type { Category, Currency } from './types'

export type Theme = 'light' | 'dark'

export const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'

export type BackgroundLock = { count: number; inert: boolean; ariaHidden: string | null }

export const backgroundLocks = new Map<HTMLElement, BackgroundLock>()

export function lockDialogBackground(node: HTMLElement) {
  const existing = backgroundLocks.get(node)
  if (existing) { existing.count += 1; return }
  backgroundLocks.set(node, { count: 1, inert: node.hasAttribute('inert'), ariaHidden: node.getAttribute('aria-hidden') })
  node.setAttribute('inert', '')
  node.setAttribute('aria-hidden', 'true')
}

export function unlockDialogBackground(node: HTMLElement) {
  const lock = backgroundLocks.get(node)
  if (!lock) return
  lock.count -= 1
  if (lock.count > 0) return
  backgroundLocks.delete(node)
  // Пока шторка была открыта, React мог сам поменять эти атрибуты: выбор в шторке «Мои экраны» тем же рендером
  // переключает вкладку и снимает inert со своей страницы. Прежнее значение возвращается, только если там всё ещё то,
  // что поставила шторка, — иначе страница осталась бы ненажимаемой.
  if (node.hasAttribute('inert') && !lock.inert) node.removeAttribute('inert')
  if (node.getAttribute('aria-hidden') === 'true' && lock.ariaHidden !== 'true') {
    if (lock.ariaHidden === null) node.removeAttribute('aria-hidden')
    else node.setAttribute('aria-hidden', lock.ariaHidden)
  }
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

// Вторая кнопка (secondaryLabel) — для развилки «сделать безопасно / всё равно продолжить»: она красная и текстом,
// главная остаётся кнопкой. Без неё диалог отвечает булевым, как раньше.
export type ConfirmOptions = { title: string; message: string; confirmLabel: string; danger?: boolean; secondaryLabel?: string }
export type ConfirmResult = 'confirm' | 'secondary' | false

export function ConfirmSheet({ options, onResult }: { options: ConfirmOptions; onResult: (result: ConfirmResult) => void }) {
  const dialogRef = useDialog(() => onResult(false))
  return <div className="sheet-backdrop" onMouseDown={() => onResult(false)}>
    <section ref={dialogRef} className="bottom-sheet confirm-sheet" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message" onMouseDown={(event) => event.stopPropagation()}>
      <div className="sheet-handle"/>
      <h2 id="confirm-title">{options.title}</h2>
      <p id="confirm-message">{options.message}</p>
      <button type="button" className={`primary${options.danger ? ' danger' : ''}`} onClick={() => onResult('confirm')}>{options.confirmLabel}</button>
      {options.secondaryLabel && <button type="button" className="sheet-cancel danger" onClick={() => onResult('secondary')}>{options.secondaryLabel}</button>}
      <button type="button" className="sheet-cancel" data-dialog-initial-focus onClick={() => onResult(false)}>Отмена</button>
    </section>
  </div>
}

export type Confirm = {
  (options: ConfirmOptions & { secondaryLabel: string }): Promise<ConfirmResult>
  (options: ConfirmOptions): Promise<boolean>
}

export function useConfirm() {
  const [request, setRequest] = useState<ConfirmOptions | null>(null)
  const pending = useRef<((result: ConfirmResult) => void) | null>(null)
  useEffect(() => () => pending.current?.(false), [])
  const confirm = useCallback(((options: ConfirmOptions) => new Promise<ConfirmResult | boolean>((resolve) => {
    pending.current?.(false)
    pending.current = (result) => resolve(options.secondaryLabel ? result : result === 'confirm')
    setRequest(options)
  })) as Confirm, [])
  const settle = useCallback((result: ConfirmResult) => {
    const current = pending.current
    pending.current = null
    setRequest(null)
    current?.(result)
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

/** Значок категории: её эмодзи, а если его не выбрали — полоска или квадратик её цвета, как раньше. */
export function CategoryMark({ category }: { category?: Pick<Category, 'color' | 'emoji'> | null }) {
  if (category?.emoji) return <b className="category-emoji" aria-hidden="true">{category.emoji}</b>
  return <i style={{ backgroundColor: category?.color ?? '#a9afa5' }}/>
}

export const GridIcon = () => <i className="grid-icon" aria-hidden="true"><svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><rect x="1.5" y="1.5" width="5" height="5" rx="1.5"/><rect x="9.5" y="1.5" width="5" height="5" rx="1.5"/><rect x="1.5" y="9.5" width="5" height="5" rx="1.5"/><rect x="9.5" y="9.5" width="5" height="5" rx="1.5"/></svg></i>

// Экран из блоков: значок настройки экрана в шапке.
export const ArrangeIcon = () => <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><path d="M3.5 10h17M12 10v10.5"/></svg>

export const SearchIcon = () => <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>

export const CardIcon = () => <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3 10h18M7 14.5h3"/></svg>

/* Откуда операция: жёлтая «B» — Bybit, тёмная «Т» — выписка Т‑Банка. Без источника — просто карта (сводная очередь). */
export const CardMark = ({ source }: { source?: 'bybit-card' | 'tbank' }) => source === 'tbank'
  ? <span className="card-mark tbank" title="Т‑Банк">Т</span>
  : source === 'bybit-card' ? <span className="card-mark" title="Bybit">B</span>
  : <span className="card-mark any"><CardIcon/></span>

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

// Порядок в списке меняется перетаскиванием за ручку ≡ (или стрелками с клавиатуры) — вместо двух стрелок на каждую строку.
// На iOS ручке нужен touch-action: none, иначе Safari отдаёт жест прокрутке и обрывает указатель.
export function DragList<T extends { id: string }>({ items, disabled = false, className, onReorder, render }: { items: T[]; disabled?: boolean; className?: string; onReorder: (ids: string[]) => void; render: (item: T) => React.ReactNode }) {
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
  return <div ref={listRef} className={`drag-list${className ? ` ${className}` : ''}${drag ? ' dragging' : ''}`}>{shown.map((item) => <div key={item.id} data-drag-id={item.id} className={`drag-row${drag?.id === item.id ? ' lifted' : ''}`}>
    {render(item)}
    {items.length > 1 && <span className="drag-handle" role="button" tabIndex={disabled ? -1 : 0} aria-label="Перетащить, чтобы изменить порядок" aria-disabled={disabled} onPointerDown={(event) => start(event, item.id)} onPointerMove={move} onPointerUp={() => end(true)} onPointerCancel={() => end(false)} onKeyDown={(event) => keyMove(event, item.id)}>≡</span>}
  </div>)}</div>
}

// Знаки «−» и «+» нарисованы: символы шрифта сидят на строке текста и в Safari на iPhone уезжали из центра круга.
export const SignIcon = ({ plus = false }: { plus?: boolean }) => <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d={plus ? 'M2.5 6h7M6 2.5v7' : 'M2.5 6h7'}/></svg>

// «−» убирает с экрана, «+» ставит обратно.
export function LayoutToggle({ shown, label, onToggle }: { shown: boolean; label: string; onToggle: () => void }) {
  return <button type="button" className={`layout-toggle${shown ? ' shown' : ''}`} aria-label={label} onClick={() => { tap(4); onToggle() }}><span aria-hidden="true"><SignIcon plus={!shown}/></span></button>
}

export const HOLD_MS = 450

// Клик, который телефон присылает, когда палец отпускают после удержания, гасится на уровне окна: под пальцем к этому
// моменту уже стоит другой экран, и клик мог бы попасть в его кнопку. Щит снимается вскоре после того, как палец отпущен.
export function shieldNextClick() {
  const swallow = (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); remove() }
  const release = () => { setTimeout(remove, 400) }
  const remove = () => {
    clearTimeout(safety)
    window.removeEventListener('click', swallow, true)
    window.removeEventListener('touchend', release, true)
    window.removeEventListener('pointerup', release, true)
  }
  const safety = setTimeout(remove, 4000)
  window.addEventListener('click', swallow, true)
  window.addEventListener('touchend', release, { capture: true, once: true })
  window.addEventListener('pointerup', release, { capture: true, once: true })
}

// Удержание блока открывает настройку экрана, как на домашнем экране телефона. Палец должен стоять на месте: сдвиг
// больше 8 px — это прокрутка или свайп. Слушатель один на контейнер, а `accept` решает, с чего удержание считается
// (у записей истории своё удержание — выбор).
export function useHold(onHold: (() => void) | undefined, accept: (target: Element) => boolean = () => true) {
  const [node, setNode] = useState<HTMLElement | null>(null)
  const latest = useRef({ onHold, accept })
  latest.current = { onHold, accept }
  useEffect(() => {
    if (!node) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let start: { x: number; y: number } | null = null
    const cancel = () => { clearTimeout(timer); timer = undefined; start = null }
    const begin = (x: number, y: number, target: EventTarget | null) => {
      cancel()
      if (!latest.current.onHold || !(target instanceof Element) || !latest.current.accept(target)) return
      start = { x, y }
      timer = setTimeout(() => {
        timer = undefined
        start = null
        shieldNextClick()
        tap(8)
        latest.current.onHold?.()
      }, HOLD_MS)
    }
    const move = (x: number, y: number) => { if (start && Math.hypot(x - start.x, y - start.y) > 8) cancel() }
    const touchStart = (event: TouchEvent) => { const touch = event.touches[0]; if (event.touches.length !== 1 || !touch) cancel(); else begin(touch.clientX, touch.clientY, event.target) }
    const touchMove = (event: TouchEvent) => { const touch = event.touches[0]; if (touch) move(touch.clientX, touch.clientY) }
    const pointerDown = (event: PointerEvent) => { if (event.pointerType !== 'touch' && event.button === 0) begin(event.clientX, event.clientY, event.target) }
    const pointerMove = (event: PointerEvent) => { if (event.pointerType !== 'touch') move(event.clientX, event.clientY) }
    // Долгое касание в iOS и Android зовёт системное меню; пока идёт удержание, оно не нужно.
    const contextMenu = (event: Event) => { if (start) event.preventDefault() }
    const listeners: [string, EventListener, AddEventListenerOptions?][] = [
      ['touchstart', touchStart as EventListener, { passive: true }], ['touchmove', touchMove as EventListener, { passive: true }],
      ['touchend', cancel, { passive: true }], ['touchcancel', cancel, { passive: true }],
      ['pointerdown', pointerDown as EventListener], ['pointermove', pointerMove as EventListener], ['pointerup', cancel], ['pointercancel', cancel],
      ['contextmenu', contextMenu],
    ]
    for (const [type, listener, options] of listeners) node.addEventListener(type, listener, options)
    return () => { cancel(); for (const [type, listener] of listeners) node.removeEventListener(type, listener) }
  }, [node])
  return setNode
}

/** «−» в углу блока в режиме «Настройка экрана». */
export function RemoveBadge({ name, onRemove }: { name: string; onRemove: () => void }) {
  return <button type="button" className="edit-remove" aria-label={`Убрать «${name}»`} onClick={() => { tap(4); onRemove() }}><span aria-hidden="true"><SignIcon/></span></button>
}

// Блок в режиме «Настройка экрана». Стоящий виден как есть, но не нажимается: вокруг рамка, в углу «−». Убранный
// остаётся на своём месте пунктирной заготовкой «+ Название» — по ней он и возвращается.
export function EditBlock({ name, hint, shown, onToggle, className, children }: { name: string; hint?: string; shown: boolean; onToggle: () => void; className?: string; children?: React.ReactNode }) {
  const classes = (base: string) => className ? `${base} ${className}` : base
  if (!shown) return <button type="button" className={classes('edit-slot')} aria-label={`Вернуть «${name}»`} onClick={() => { tap(4); onToggle() }}>
    <span className="edit-sign" aria-hidden="true"><SignIcon plus/></span>
    <span className="edit-slot-text"><b>{name}</b>{hint && <small>{hint}</small>}</span>
  </button>
  return <div className={classes('edit-block')}>
    <div className="edit-block-body" inert>{children}</div>
    <RemoveBadge name={name} onRemove={onToggle}/>
  </div>
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
