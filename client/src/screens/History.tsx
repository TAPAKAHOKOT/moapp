import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { WorkspaceApiError as ApiError, includeExpense, saveMemberSettings, submitExpenseOperation, submitExpenseOperations } from '../workspace-api'
import { patchSettings } from '../settings'
import type { SettingsPatch } from '../settings'
import type { AccountSettings, BlockLayout, Category, Currency, Expense, Tag } from '../types'
import { appTimeZone, cachedDateTimeFormat, localDateKey, monthDateRange, shiftDateKey, weekdayFromDateKey, workspaceCurrency } from '../utils'
import { HISTORY_PERIOD_LABELS, defaultHistoryPreferences, expenseTagNames, filterHistoryExpenses, historyTotals, parseHistoryPreferences } from '../history'
import type { HistoryPeriod, HistoryPreferences } from '../history'
import { CardMark, CategoryMark, ChevronIcon, EditBlock, HOLD_MS, LockIcon, MultiSelect, SearchIcon, Toast, TrashIcon, prefersReducedMotion, tap, trackEasing, useDialog, useDragOrder, useFlip, useHold, useOverflowHint, useToast } from '../ui'
import { formatAnalyticsAmount, formatDateRange, formatHistoryDate, money, pluralRu } from '../format'
import type { Bootstrap } from '../format'
import { sortTags } from '../tags'
import { categoryLayout, inOrder } from '../screen-order'
import { blockInfo, isShown, reorderBlocks, screenBlocks, toBlockLayout, toggleBlock } from '../screen-blocks'
import type { BlockScreen } from '../screen-blocks'

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

// «до сентября 2025»: месяц в родительном падеже через формат с днём, из которого день убирается.
function formatMonthYear(dateKey: string) {
  return new Date(`${dateKey}T12:00:00Z`).toLocaleDateString('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }).replace(/^\d+\s/, '').replace(' г.', '')
}

export const ROW_ACTION_WIDTH = 84

export const LONG_PRESS_MS = HOLD_MS

export const ROW_DRAG_START = 8

/** Касание подсвечивает строку, когда палец постоял на месте столько миллисекунд: у пролистывания плашка не мигает. */
export const ROW_PRESS_DELAY_MS = 100

/** Отпущенная строка едет на место 220 мс (переход transform у .history-swipe), и конец пути приходит событием
 *  transitionend. Если события так и не было, строка через секунду точно на месте и перестаёт быть «живой». */
export const ROW_SETTLE_LIMIT_MS = 1000

// Строка стоит на месте, когда у слоя нет сдвига: `none` в браузере, пустая строка там, где стилей не считают (jsdom).
const atRest = (node: Element) => {
  const transform = getComputedStyle(node).transform
  return !transform || transform === 'none' || /^matrix\(1, 0, 0, 1, 0, 0\)$/.test(transform)
}

// Строка истории: тап открывает запись, долгое нажатие включает выбор нескольких, свайп влево открывает удаление.
// Заголовок — всегда категория; второй строкой — то, что человек написал сам, и теги текстом: «Maxi · #вдвоём».
// На сенсорных экранах жест ведут touch-события с preventDefault: Safari обрывает pointer-события, как только
// решает, что палец листает список, и свайп по строке до него не доходил. Мышь остаётся на pointer-событиях.
// Нарисованных строк сотни, и они остаются в дереве, пока открыто пространство. Мемоизация с колбэками,
// принимающими запись, даёт перерисовку только тех строк, чьё состояние (выбор, открытый свайп) действительно изменилось.
type RowGesture = { x: number; y: number; touchId: number | null; dragging: boolean; longPress: ReturnType<typeof setTimeout> | undefined }

type RowPress = { x: number; y: number; touchId: number | null; timer: ReturnType<typeof setTimeout> | undefined }

const usesNativeTouch = () => typeof window !== 'undefined' && 'ontouchstart' in window

export const HistoryRow = memo(function HistoryRow({ expense, category, tags, currencies, checked, selecting, open, disabled, inert = false, onOpen, onToggle, onEdit, onDelete, onVoided }: {
  expense: Expense; category?: Category; tags: Tag[]; currencies: Currency[]; checked: boolean; selecting: boolean; open: boolean; disabled: boolean
  /** Пока экран настраивают, строки видны, но не нажимаются. */
  inert?: boolean
  onOpen: (id: string | null) => void; onToggle: (id: string) => void; onEdit: (id: string) => void; onDelete: (expense: Expense) => void; onVoided?: (expense: Expense) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const gesture = useRef<RowGesture | null>(null)
  // Клик приходит следом за жестом (после pointerup или touchend); после свайпа или долгого нажатия он лишний.
  const suppressClick = useRef(false)
  const [dragOffset, setDragOffset] = useState<number | null>(null)
  const swipeDisabled = disabled || selecting
  const translate = dragOffset ?? (open ? -ROW_ACTION_WIDTH : 0)
  // Кнопка «Удалить», слой и обрезка нужны только «живой» строке: открытой, той, которую тянут, и отпущенной, пока она
  // едет на место. Без них сотни неподвижных строк обходятся Safari заметно дешевле.
  // Закрытие начинается, когда строку отпустили сдвинутой (тап по открытой, протяжка обратно, открылась другая), и
  // кончается, когда слой строки доехал до нуля. Сдвинута ли она была, помнит прошлый рендер: палец и открытие меняют
  // состояние в разных местах, а у строки, отпущенной на нуле (тянули вправо), ехать нечему — она сразу неподвижна.
  const held = open || dragOffset !== null
  const shifted = translate !== 0
  const [closing, setClosing] = useState(false)
  const [last, setLast] = useState({ held, shifted })
  if (last.held !== held || last.shifted !== shifted) {
    setLast({ held, shifted })
    setClosing(!held && last.held && last.shifted)
  }
  useEffect(() => {
    if (!closing) return
    const timer = setTimeout(() => setClosing(false), ROW_SETTLE_LIMIT_MS)
    return () => clearTimeout(timer)
  }, [closing])
  // Конец пути — только у сдвига самого слоя и только на нуле. Переходы потомков (фон строки, галочка) всплывают сюда же,
  // а переход открытия, кончившийся в кадр начала закрытия, приходит, пока слой ещё сдвинут.
  const settled = (event: React.TransitionEvent) => {
    if (event.target === event.currentTarget && event.propertyName === 'transform' && atRest(event.currentTarget)) setClosing(false)
  }
  useEffect(() => () => clearTimeout(gesture.current?.longPress), [])
  // Плашка нажатия. Под пальцем, листающим список, CSS :active мигал на каждой строке, поэтому касание зажигает её классом,
  // только когда палец постоял на месте ROW_PRESS_DELAY_MS, а гасит сдвиг дальше порога, подъём пальца или отмена касания.
  // Мышь и клавиатуру, как и раньше, ведёт :active — в CSS он оставлен только устройствам с мышью.
  const [pressed, setPressed] = useState(false)
  const press = useRef<RowPress | null>(null)
  const unpress = () => {
    const state = press.current
    if (!state) return
    press.current = null
    clearTimeout(state.timer)
    setPressed(false)
  }
  // Касание touch-событиями узнаётся по touchId; касание одними pointer-событиями (touchId null) до конца жеста
  // принадлежит строке, и его подъём и отмена приходят сюда же.
  const pressAt = (x: number, y: number, touchId: number | null) => {
    unpress()
    const state: RowPress = { x, y, touchId, timer: undefined }
    press.current = state
    state.timer = setTimeout(() => { if (press.current === state) setPressed(true) }, ROW_PRESS_DELAY_MS)
  }
  const pressMove = (x: number, y: number) => {
    const state = press.current
    if (state && Math.max(Math.abs(x - state.x), Math.abs(y - state.y)) > ROW_DRAG_START) unpress()
  }
  useEffect(() => () => { clearTimeout(press.current?.timer); press.current = null }, [])
  const begin = (x: number, y: number, touchId: number | null) => {
    if (disabled) return
    clearTimeout(gesture.current?.longPress)
    suppressClick.current = false
    gesture.current = { x, y, touchId, dragging: false, longPress: selecting || open ? undefined : setTimeout(() => {
      // Долгое нажатие без движения — вход в выбор нескольких записей.
      const state = gesture.current
      if (!state || state.dragging) return
      suppressClick.current = true
      tap(8)
      onToggle(expense.id)
    }, LONG_PRESS_MS) }
  }
  // Возвращает true, пока строка едет за пальцем: в этот момент touchmove гасится, чтобы список не прокручивался.
  const move = (x: number, y: number) => {
    const state = gesture.current
    if (!state) return false
    const dx = x - state.x
    const dy = y - state.y
    if (!state.dragging) {
      if (Math.abs(dy) > ROW_DRAG_START && Math.abs(dy) > Math.abs(dx)) { clearTimeout(state.longPress); gesture.current = null; return false }
      if (Math.abs(dx) < ROW_DRAG_START || Math.abs(dx) < Math.abs(dy) * 1.5) return false
      clearTimeout(state.longPress)
      if (swipeDisabled && !open) { gesture.current = null; return false }
      state.dragging = true
      suppressClick.current = true
    }
    const base = open ? -ROW_ACTION_WIDTH : 0
    setDragOffset(Math.max(-ROW_ACTION_WIDTH * 1.15, Math.min(0, base + dx)))
    return true
  }
  const finish = (commit: boolean, x?: number) => {
    const state = gesture.current
    gesture.current = null
    if (!state) return
    clearTimeout(state.longPress)
    if (!state.dragging) return
    setDragOffset(null)
    if (!commit || x === undefined) return
    const dx = x - state.x + (open ? -ROW_ACTION_WIDTH : 0)
    onOpen(dx < -ROW_ACTION_WIDTH / 2 ? expense.id : null)
  }
  const pointerDown = (event: React.PointerEvent) => {
    if (event.pointerType === 'touch' && usesNativeTouch()) return
    if (event.button !== 0) return
    if (event.pointerType === 'touch') pressAt(event.clientX, event.clientY, null)
    begin(event.clientX, event.clientY, null)
  }
  const pointerMove = (event: React.PointerEvent) => {
    if (event.pointerType === 'touch' && usesNativeTouch()) return
    if (event.pointerType === 'touch') pressMove(event.clientX, event.clientY)
    const wasDragging = gesture.current?.dragging
    if (move(event.clientX, event.clientY) && !wasDragging) event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const pointerEnd = (event: React.PointerEvent) => {
    if (event.pointerType === 'touch' && usesNativeTouch()) return
    if (event.pointerType === 'touch') unpress()
    finish(event.type === 'pointerup', event.clientX)
  }
  // Touch-слушатели ставятся один раз на строку; актуальные замыкания берутся из рефа.
  const touch = useRef({ begin, move, finish, pressAt, pressMove, unpress })
  touch.current = { begin, move, finish, pressAt, pressMove, unpress }
  useEffect(() => {
    const node = root.current
    if (!node || !usesNativeTouch()) return
    const find = (touches: TouchList, id: number | null | undefined) => id === null || id === undefined ? undefined : Array.from(touches).find((item) => item.identifier === id)
    const tracked = (touches: TouchList) => find(touches, gesture.current?.touchId)
    const touchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) { clearTimeout(gesture.current?.longPress); gesture.current = null; touch.current.unpress(); return }
      const point = event.touches[0]
      if (!point) return
      touch.current.pressAt(point.clientX, point.clientY, point.identifier)
      touch.current.begin(point.clientX, point.clientY, point.identifier)
    }
    const touchMove = (event: TouchEvent) => {
      // Плашка следит за пальцем и тогда, когда строка его уже отпустила листать список.
      const pressing = find(event.touches, press.current?.touchId)
      if (pressing) touch.current.pressMove(pressing.clientX, pressing.clientY)
      const point = tracked(event.touches)
      if (point && touch.current.move(point.clientX, point.clientY)) event.preventDefault()
    }
    const touchEnd = (event: TouchEvent) => {
      touch.current.unpress()
      const point = tracked(event.changedTouches)
      if (point) touch.current.finish(true, point.clientX)
    }
    const touchCancel = () => { touch.current.unpress(); touch.current.finish(false) }
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
  const click = () => {
    if (suppressClick.current) { suppressClick.current = false; return }
    if (open) { onOpen(null); return }
    if (selecting) onToggle(expense.id)
    else if (expense.voidedAt && onVoided) onVoided(expense)
    else onEdit(expense.id)
  }
  // Теги приходят уже в порядке этого человека.
  const tagList = expense.tagIds?.length ? tags.filter((tag) => expense.tagIds?.includes(tag.id)) : []
  const categoryName = category?.name || 'Скрытая категория'
  const details = [expense.note, tagList.map((tag) => `#${tag.name}`).join(' ')].filter(Boolean).join(' · ')
  // У строки отменённого платежа слои прежние: её полупрозрачная метка категории без своего слоя рисуется чуть иначе.
  return <div ref={root} className={`history-expense${checked ? ' selected' : ''}${open ? ' open' : ''}${dragOffset !== null ? ' dragging' : ''}${closing ? ' closing' : ''}${pressed ? ' pressed' : ''}${expense.voidedAt ? ' voided' : ''}`} inert={inert} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd}>
    <div className="history-swipe" style={{ transform: translate ? `translateX(${translate}px)` : undefined, transition: dragOffset === null ? undefined : 'none', willChange: dragOffset === null ? undefined : 'transform' }} onTransitionEnd={settled}>
      <label className="expense-check" aria-label={`Выбрать расход ${categoryName}`}><input type="checkbox" tabIndex={selecting ? 0 : -1} checked={checked} onChange={() => onToggle(expense.id)}/><span/></label>
      <button type="button" className={`history-row${expense.voidedAt ? ' voided' : ''}`} aria-pressed={selecting ? checked : undefined} onClick={click}><CategoryMark category={category}/><span><b>{categoryName}</b>{details && <small>{details}</small>}</span><strong>{money(expense.amountMinor,expense.currency,currencies)}</strong>{expense.voidedAt && <em className="voided-badge" aria-label="Платёж не прошёл, не учитывается">{expense.voidReason?.kind === 'reversed' ? 'Возврат' : 'Не прошёл'}</em>}</button>
    </div>
    {(held || closing) && <button type="button" className="history-swipe-delete" tabIndex={open ? 0 : -1} aria-hidden={!open} disabled={disabled} onClick={() => onDelete(expense)}><TrashIcon/><span>Удалить</span></button>}
  </div>
})

/** Карточки и панель фильтров над списком раскрываются, сворачиваются и меняют высоту за столько миллисекунд. */
export const CARD_MOTION_MS = 200

const alwaysGlides = () => true

// Плавная высота по ключу. Обёртка над списком держит одно из состояний `view` (null — обёртки нет) и, когда оно сменилось
// на показанном экране, едет по высоте от прежней к новой, а список под ней — следом, без скачка. Так появляются и уходят
// карточки («Сохраните ссылку доступа», «N операций с карты ждут разбора») и так панель фильтров меняет высоту при входе в
// выбор записей и выходе из него.
// - Содержимое меняется сразу; на время пути оно обрезано по обёртке, потом стили снимаются. Обёртка — отдельный блочный
//   контекст: отступ содержимого сверху живёт внутри неё и сворачивается вместе с ним, а в покое всё стоит там же, где
//   стояло бы без обёртки.
// - Высота меняется покадрово через requestAnimationFrame, как и блоки в настройке экрана, но по кривой ленты карточек
//   «Расхода» и сдвига строк (trackEasing), а не по их flipEasing: часы идут с первого кадра, а не с перерисовки, и
//   CSS-переходов нет — на iPhone ускоренный переход терял содержимое слоя на первом кадре. Обёртки, сменившие вид в одной
//   перерисовке, получают одно время кадра и едут одним движением.
// - Прежнюю высоту в момент смены уже не измерить: содержимое новое. Её помнит ResizeObserver — он сообщает размер после
//   раскладки, в которой тот изменился, и сам ничего не раскладывает; посреди пути прежняя высота — та, что поставлена
//   обёртке. Без ResizeObserver (старые браузеры, jsdom) обёртка меряется в момент смены: у уходящей карточки
//   содержимое прежнее, и замер верен, а смена вида панели тогда просто не едет. Новую высоту даёт одно чтение раскладки
//   в момент смены, а не в каждом рендере.
// - Уходящее содержимое досматривается с последними данными и не нажимается; вернувшееся едет обратно с той высоты, где
//   его застали. Какие смены вида едут, решает `glides(было, стало)`; остальные — сразу, как без обёртки.
// - При первом рендере, на вкладке, которую не видно, в фоне и при «уменьшении движения» — сразу в конечном виде.
function GlideSlot({ view, glides = alwaysGlides, className, children }: { view: string | null; glides?: (was: string | null, now: string | null) => boolean; className: string; children: React.ReactNode }) {
  const kept = useRef(children)
  if (view !== null) kept.current = children
  const [present, setPresent] = useState(view !== null)
  if (view !== null && !present) setPresent(true)
  const slot = useRef<HTMLDivElement>(null)
  // height — высота, поставленная обёртке в пути (null — своя); seen — последняя, о которой сообщил ResizeObserver.
  const motion = useRef({ view, frame: 0, height: null as number | null, seen: null as number | null })
  useLayoutEffect(() => {
    const node = slot.current
    const run = motion.current
    if (!present || !node) return
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver((entries) => { const entry = entries[entries.length - 1]; if (entry) run.seen = entry.contentRect.height }) : null
    observer?.observe(node)
    return () => { observer?.disconnect(); run.seen = null; run.height = null }
  }, [present])
  useLayoutEffect(() => {
    const run = motion.current
    if (run.view === view) return
    const was = run.view
    run.view = view
    cancelAnimationFrame(run.frame)
    run.frame = 0
    const node = slot.current
    if (!node) return
    const at = run.height
    run.height = null
    if (!glides(was, view) || prefersReducedMotion() || document.hidden || node.closest('.page-slot')?.hasAttribute('inert')) {
      node.style.height = ''
      node.style.overflow = ''
      if (view === null) setPresent(false)
      return
    }
    const from = at ?? (was === null ? 0 : run.seen ?? node.getBoundingClientRect().height)
    node.style.height = ''
    const to = view === null ? 0 : node.getBoundingClientRect().height
    if (Math.abs(to - from) < 0.5) {
      node.style.overflow = ''
      if (view === null) setPresent(false)
      return
    }
    node.style.overflow = 'hidden'
    node.style.height = `${from}px`
    run.height = from
    let started = 0
    const step = (time: number) => {
      started ||= time
      const progress = Math.min(1, (time - started) / CARD_MOTION_MS)
      if (progress < 1) {
        run.height = from + (to - from) * trackEasing(progress)
        node.style.height = `${run.height}px`
        run.frame = requestAnimationFrame(step)
        return
      }
      run.frame = 0
      // Свёрнутая остаётся нулевой высоты, пока React её не уберёт: иначе на кадр вернулась бы во весь рост.
      if (view === null) { run.height = 0; node.style.height = '0px'; setPresent(false); return }
      run.height = null
      node.style.height = ''
      node.style.overflow = ''
    }
    run.frame = requestAnimationFrame(step)
  }, [view])
  useEffect(() => () => cancelAnimationFrame(motion.current.frame), [])
  if (!present) return null
  return <div ref={slot} className={className} inert={view === null}>{view !== null ? children : kept.current}</div>
}

// Панель фильтров едет по высоте, только когда входят в выбор записей или выходят из него. Прочие её перемены (поиск,
// части итога, «Сбросить», появление с первой записью) и настройка экрана — сразу, как и были.
const selectionGlides = (was: string | null, now: string | null) => (was === 'select') !== (now === 'select') && was !== 'editing' && now !== 'editing'

export type HistoryInbox = { count: number; onOpen: () => void }

export type HistoryReminder = { onSave: () => void; onLater: () => void; compact: boolean }

/** Записи старше окна первичной загрузки: сколько их, с какого дня начинается окно и как их подгрузить. */
export type HistoryOlder = { count: number; since: string; busy: boolean; load: () => void }

// Год записей — это десятки тысяч элементов, и Safari платит за них при любой перестройке ленты вкладок. Поэтому
// строки рисуются порциями: сначала столько, сколько хватит на несколько экранов, остальные — когда до конца
// нарисованного останется пара экранов. Итоги, поиск и фильтры по-прежнему считаются по всем записям.
export const HISTORY_FIRST_ROWS = 120
export const HISTORY_MORE_ROWS = 200

type HistoryDay = { date: string; items: Expense[]; total: string | null }

// Первые `limit` строк по дням (последний день может войти не целиком) и сколько строк и дней осталось за окном.
function firstRows(days: HistoryDay[], total: number, limit: number) {
  if (limit >= total) return { days, restRows: 0, restDays: 0 }
  const shown: HistoryDay[] = []
  let count = 0
  for (const day of days) {
    if (count >= limit) break
    const room = limit - count
    shown.push(day.items.length > room ? { ...day, items: day.items.slice(0, room) } : day)
    count += Math.min(room, day.items.length)
  }
  return { days: shown, restRows: total - count, restDays: days.length - shown.length }
}

// Вкладка не размонтируется, пока открыто пространство, поэтому она не должна перерисовываться от чужих
// изменений состояния приложения — только от своих данных и колбэков (все они стабильны у родителя).
export const HistoryView = memo(function HistoryView({ userId, workspaceId, bootstrap, setBootstrap, edit, createNew, refreshPending, inbox = null, reminder = null, timeZone = appTimeZone(), today = localDateKey(new Date(), timeZone), older = null, blocks, editing = false, onEditScreen = () => {}, onScreensChange = () => {} }: {
  userId: string
  workspaceId: string
  bootstrap: Bootstrap
  setBootstrap: React.Dispatch<React.SetStateAction<Bootstrap>>
  edit: (id: string) => void
  createNew: () => void
  refreshPending: () => void
  inbox?: HistoryInbox | null
  reminder?: HistoryReminder | null
  /** Календарь телефона: дни истории и итоги пересчитываются, когда пояс меняется. */
  timeZone?: string
  /** Сегодняшний день по календарю телефона. Его ведёт приложение: мемоизированный экран сам после полуночи не
   *  перерисуется, и «Сегодня», «Эта неделя» и «Этот месяц» в фильтре остались бы вчерашними. */
  today?: string
  older?: HistoryOlder | null
  /** Какие блоки «Истории» человек оставил на экране. Меняет их он сам в режиме «Настройка экрана» (`editing`): его
   *  открывают значок в шапке и удержание блока над списком или даты дня. */
  blocks?: BlockLayout
  editing?: boolean
  onEditScreen?: (screen: BlockScreen, how?: 'hold' | 'tap') => void
  onScreensChange?: (patch: SettingsPatch<AccountSettings>) => void
}) {
  // Фильтры помнит аккаунт, строка поиска живёт, только пока приложение открыто.
  const [filters, setFilters] = useState<HistoryPreferences>(() => parseHistoryPreferences(bootstrap.settings?.historyFilters, today))
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [deleting, setDeleting] = useState(false)
  const [openRow, setOpenRow] = useState<string | null>(null)
  const [calendar, setCalendar] = useState(false)
  const [periodOpen, setPeriodOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(() => Boolean(filters.query))
  const [showParts, setShowParts] = useState(false)
  const [voided, setVoided] = useState<Expense | null>(null)
  const [including, setIncluding] = useState(false)
  const [rowLimit, setRowLimit] = useState(HISTORY_FIRST_ROWS)
  const { toast, notify, dismiss } = useToast()
  const pageRef = useRef<HTMLElement | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const restRef = useRef<HTMLDivElement>(null)
  // Блоки «Истории» у каждого свои. Без блока фильтров фильтры не действуют: иначе убранный блок молча прятал бы
  // расходы. Сами фильтры не теряются и вернутся вместе с блоком.
  const historyBlocks = useMemo(() => screenBlocks('history', blocks), [blocks])
  const showFilters = isShown(historyBlocks, 'filters')
  const showTotal = isShown(historyBlocks, 'total')
  const showDayTotals = isShown(historyBlocks, 'day-totals')
  // Фильтры и «Итог» стоят над списком в порядке человека; суммы по дням живут у дат.
  const toolbarBlocks = historyBlocks.shown.filter((block) => !block.pinned)
  const toolbarDrag = useDragOrder({ items: toolbarBlocks, onReorder: (ids) => onScreensChange({ historyBlocks: toBlockLayout(reorderBlocks(historyBlocks, ids)) }) })
  const activeFilters = useMemo(() => showFilters ? filters : defaultHistoryPreferences(today), [showFilters, filters, today])
  // Настройка экрана начинается сверху, где стоят блоки; выбор записей, открытый свайп и дальние строки ей не нужны.
  useEffect(() => {
    if (!editing) return
    setSelected(new Set())
    setOpenRow(null)
    setRowLimit(HISTORY_FIRST_ROWS)
    const slot = pageRef.current?.closest<HTMLElement>('.page-slot')
    if (slot) slot.scrollTop = 0
  }, [editing])
  const editBlock = (id: string, withHint = false) => {
    const block = blockInfo('history', id)
    return { name: block.name, hint: withHint ? block.hint : undefined, shown: isShown(historyBlocks, id), flipId: id, onToggle: () => onScreensChange({ historyBlocks: toBlockLayout(toggleBlock(historyBlocks, id)) }) }
  }
  // Всё производное от данных и фильтров считается один раз на их изменение: вкладка остаётся смонтированной,
  // пока открыто пространство, и без мемоизации каждый рендер приложения (например свайп по расходам на экране
  // ввода) заново фильтровал, группировал и форматировал всю историю.
  // Расчёт зависит только от тех частей данных пространства, которые читает. Рядом в них лежат личные настройки, и сама
  // «История» кладёт туда свои фильтры: зависимость от всего bootstrap считала бы год второй раз на каждый фильтр.
  // Теги считаются отдельно: они уходят в каждую строку, и новый массив на каждое сохранение перерисовывал бы весь год.
  const { expenses: allExpenses, categories, currencies, rates } = bootstrap
  const categoryOrder = bootstrap.settings?.categoryOrder
  // Валюта итога, когда фильтр не выбрал одну валюту: валюта аналитики человека, иначе валюта пространства.
  const reportCurrency = bootstrap.settings?.analyticsCurrency || workspaceCurrency(bootstrap)
  const tags = useMemo(() => sortTags(bootstrap.tags ?? [], bootstrap.settings?.tagOrder), [bootstrap.tags, bootstrap.settings?.tagOrder])
  const derived = useMemo(() => {
    const categoryMap = new Map(categories.map((category) => [category.id, category]))
    const activeExpenses = allExpenses.filter((item) => !item.deletedAt)
    // Варианты фильтров идут в том же порядке, что у этого человека на «Расходе», а не по алфавиту; скрытые — в конце.
    const tagOptions = tags.filter((tag) => activeFilters.tagIds.includes(tag.id) || activeExpenses.some((expense) => expense.tagIds?.includes(tag.id)))
    const categoryRank = new Map(inOrder(categoryLayout(categories, categoryOrder)).map((category, index) => [category.id, index]))
    const categoryOptions = categories
      .filter((category) => activeFilters.categoryIds.includes(category.id) || activeExpenses.some((expense) => expense.categoryId === category.id))
      .sort((left, right) => (categoryRank.get(left.id) ?? Infinity) - (categoryRank.get(right.id) ?? Infinity) || left.name.localeCompare(right.name, 'ru-RU'))
    const currencyOptions = currencies
      .filter((currency) => activeFilters.currencies.includes(currency.code) || activeExpenses.some((expense) => expense.currency === currency.code))
      .sort((left, right) => left.code.localeCompare(right.code))
    const normalizedQuery = activeFilters.query.trim().toLocaleLowerCase('ru-RU')
    const expenses = filterHistoryExpenses(activeExpenses, activeFilters, today).filter((item) => {
      // Текст для поиска собирается только при непустом запросе: он дорогой, а без запроса не нужен.
      if (!normalizedQuery) return true
      const dateKey = localDateKey(item.occurredAt, timeZone)
      const date = new Date(item.occurredAt)
      const searchText = [
        categoryMap.get(item.categoryId)?.name,
        ...expenseTagNames(item, tags),
        item.currency,
        item.note,
        money(item.amountMinor, item.currency, currencies),
        String(item.amountMinor / 10 ** (currencies.find((currency) => currency.code === item.currency)?.decimals ?? 2)).replace('.', ','),
        formatHistoryDate(dateKey),
        cachedDateTimeFormat('ru-RU', { timeZone }).format(date),
      ].filter(Boolean).join(' ').toLocaleLowerCase('ru-RU')
      return searchText.includes(normalizedQuery)
    })
    const grouped = expenses.reduce<Record<string, Expense[]>>((result, item) => { (result[localDateKey(item.occurredAt, timeZone)] ||= []).push(item); return result }, {})
    // Итог по показанным записям. В одной валюте — точная сумма; в нескольких — пересчёт в валюту аналитики и разбивка.
    const totalsTarget = (filters.currencies.length === 1 ? filters.currencies[0] : null) || reportCurrency
    const sumLabel = (items: Expense[]) => {
      const totals = historyTotals(items, currencies, rates, totalsTarget)
      if (!items.length) return { label: null as string | null, parts: '', totals }
      const label = totals.byCurrency.length === 1 ? money(totals.byCurrency[0]!.amountMinor, totals.byCurrency[0]!.currency, currencies)
        : totals.converted !== null ? `≈ ${formatAnalyticsAmount(totals.converted, totals.target)}` : null
      const parts = totals.byCurrency.length > 1 ? totals.byCurrency.map((part) => money(part.amountMinor, part.currency, currencies)).join(' + ') : ''
      return { label, parts, totals }
    }
    // Заголовок дня показывает сумму дня, а не число записей: по ней читается ритм трат.
    const groups = Object.entries(grouped).map(([date, items]) => ({ date, items, total: sumLabel(items).label }))
    const { label: totalLabel, parts: totalParts, totals } = sumLabel(expenses)
    return { categoryMap, activeExpenses, tagOptions, categoryOptions, currencyOptions, normalizedQuery, expenses, groups, totals, totalLabel, totalParts }
  }, [allExpenses, categories, currencies, rates, categoryOrder, reportCurrency, tags, activeFilters, filters.currencies, timeZone, today])
  const { categoryMap, activeExpenses, tagOptions, categoryOptions, currencyOptions, normalizedQuery, expenses, groups, totals, totalLabel, totalParts } = derived
  // Без IntersectionObserver (старые браузеры, тесты) рисуется весь список, как раньше.
  const windowed = typeof IntersectionObserver === 'function'
  const shown = useMemo(() => firstRows(groups, expenses.length, windowed ? rowLimit : Infinity), [groups, expenses.length, windowed, rowLimit])
  const hasRest = shown.restRows > 0
  // Ниже нарисованного — пустой отступ под остальные строки и дни по средней высоте уже нарисованных: длина прокрутки,
  // полоса прокрутки и дальность флика прежние, а новые строки встают над отступом, и видимое не сдвигается.
  const rest = useRef({ rows: 0, days: 0, stride: 0 })
  const fitRest = useCallback(() => {
    const list = listRef.current
    const spacer = restRef.current
    if (!list || !spacer) return
    let rows = 0
    let rowsHeight = 0
    for (const day of Array.from(list.children) as HTMLElement[]) {
      rows += day.childElementCount - 1
      rowsHeight += day.offsetHeight - ((day.firstElementChild as HTMLElement | null)?.offsetHeight ?? 0)
    }
    if (!rows) return
    const drawn = spacer.offsetTop - list.offsetTop
    const perDay = (drawn - rowsHeight) / list.childElementCount
    rest.current.stride = drawn / rows
    spacer.style.height = `${Math.max(0, Math.round(rest.current.rows * rowsHeight / rows + rest.current.days * perDay))}px`
  }, [])
  useLayoutEffect(() => {
    rest.current.rows = shown.restRows
    rest.current.days = shown.restDays
    fitRest()
  }, [shown, fitRest])
  // Крупный текст или поворот телефона меняют высоту строк — отступ пересчитывается следом.
  useEffect(() => {
    const list = listRef.current
    if (!hasRest || !list || typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(() => fitRest())
    observer.observe(list)
    return () => observer.disconnect()
  }, [hasRest, fitRest])
  // Отступ ближе двух экранов — дорисовывается следующая порция. После каждой порции наблюдатель ставится заново: если
  // отступ всё ещё рядом, первый же ответ попросит ещё. Если к нему прыгнули полосой прокрутки, порция сразу закрывает
  // всю пустоту до экрана.
  useEffect(() => {
    const spacer = restRef.current
    if (!spacer || typeof IntersectionObserver !== 'function') return
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (!entry?.isIntersecting) return
      const gap = entry.rootBounds ? entry.rootBounds.bottom - entry.boundingClientRect.top : 0
      const stride = rest.current.stride
      setRowLimit((limit) => limit + Math.max(HISTORY_MORE_ROWS, stride > 0 ? Math.ceil(gap / stride) : 0))
    }, { root: spacer.closest('.page-slot'), rootMargin: '100% 0px 200% 0px' })
    observer.observe(spacer)
    return () => observer.disconnect()
  }, [shown])
  // С «Истории» ушли у самого начала — лишние строки снимаются, пока её не видно: при возвращении на вкладку стили
  // страницы пересчитываются целиком, и сто двадцать строк обходятся в разы дешевле года. Лента вкладок в этот момент
  // ещё может ехать, поэтому строки снимаются, когда она постоит.
  useEffect(() => {
    const slot = pageRef.current?.closest<HTMLElement>('.page-slot')
    if (!slot || typeof IntersectionObserver !== 'function') return
    let timer: ReturnType<typeof setTimeout> | undefined
    const trim = () => {
      timer = undefined
      if (slot.hasAttribute('inert') && slot.scrollTop <= slot.clientHeight * 2) setRowLimit(HISTORY_FIRST_ROWS)
    }
    const schedule = () => { clearTimeout(timer); timer = slot.hasAttribute('inert') ? setTimeout(trim, 600) : undefined }
    const postpone = () => { if (timer !== undefined) schedule() }
    const watcher = new MutationObserver(schedule)
    watcher.observe(slot, { attributes: true, attributeFilter: ['inert'] })
    const pager = slot.parentElement
    pager?.addEventListener('scroll', postpone, { passive: true })
    return () => { clearTimeout(timer); watcher.disconnect(); pager?.removeEventListener('scroll', postpone) }
  }, [])
  // Удержание блоков над списком и даты дня открывает настройку; у самих записей удержание — выбор нескольких.
  const holdRef = useHold(!editing && activeExpenses.length > 0 ? () => onEditScreen('history', 'hold') : undefined, (target) => Boolean(target.closest('.history-toolbar, .history-date')))
  const sectionRef = useCallback((node: HTMLElement | null) => { pageRef.current = node; holdRef(node) }, [holdRef])
  // В настройке блоки и всё, что под ними, доезжают до новых мест плавно.
  useFlip(pageRef, editing)
  // Изменённые фильтры уходят в аккаунт; то, с чем экран открылся, заново не отправляется.
  const savedFilters = useRef(JSON.stringify({ ...filters, query: undefined }))
  useEffect(() => {
    const { query: _query, ...historyFilters } = filters
    const serialized = JSON.stringify({ ...filters, query: undefined })
    if (serialized === savedFilters.current) return
    savedFilters.current = serialized
    setBootstrap((data) => ({ ...data, settings: patchSettings(data.settings, { historyFilters }) }))
    saveMemberSettings(userId, workspaceId, { historyFilters })
  }, [filters, setBootstrap, userId, workspaceId])
  const updateFilters = (patch: Partial<HistoryPreferences>) => {
    setFilters((current) => ({ ...current, ...patch }))
    setSelected(new Set())
    setRowLimit(HISTORY_FIRST_ROWS)
  }
  const toggle = useCallback((id: string) => setSelected((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }), [])
  const filtersActive = Boolean(normalizedQuery || activeFilters.categoryIds.length || activeFilters.tagIds.length || activeFilters.currencies.length || activeFilters.period !== 'all')
  const chipStrip = useRef<HTMLDivElement>(null)
  const chipsMore = useOverflowHint(chipStrip)
  // Поле поиска получает фокус, только когда его открыли тапом по лупе. Поле монтируется заново и после выбора записей,
  // и после настройки экрана, и autoFocus тогда сам открывал бы клавиатуру.
  const focusSearch = useRef(false)
  const resetFilters = () => {
    setFilters(defaultHistoryPreferences(today))
    setSelected(new Set())
    setSearchOpen(false)
    setRowLimit(HISTORY_FIRST_ROWS)
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
  // Строка чипов и поиск — блок «Фильтры и поиск», сумма и число записей — блок «Итог». В режиме «Настройка экрана»
  // они стоят на своих местах в рамке с «−», а убранные — пунктирными заготовками.
  const chips = <div className={`history-chips${chipsMore ? ' more' : ''}`}>
    <div className="history-chip-strip" ref={chipStrip}>
    <button type="button" className={`filter-chip${filters.period !== 'all' ? ' active' : ''}`} aria-label="Период истории" aria-haspopup="dialog" aria-expanded={periodOpen} onClick={() => setPeriodOpen(true)}><span>{periodLabel}</span><ChevronIcon/></button>
    <MultiSelect label="Категория истории" title="Категории" placeholder="Категория" allLabel="Все категории" values={filters.categoryIds} onChange={(values) => updateFilters({ categoryIds: values })} count={(n) => `${n} ${pluralRu(n, ['категория', 'категории', 'категорий'])}`} options={categoryOptions.map((category) => ({ value: category.id, label: category.emoji ? `${category.emoji} ${category.name}` : category.name, ...(category.archivedAt ? { hint: 'скрыта' } : {}) }))}/>
    {(currencyOptions.length > 1 || filters.currencies.length > 0) && <MultiSelect label="Валюта истории" title="Валюты" placeholder="Валюта" allLabel="Все валюты" values={filters.currencies} onChange={(values) => updateFilters({ currencies: values })} count={(n) => `${n} ${pluralRu(n, ['валюта', 'валюты', 'валют'])}`} options={currencyOptions.map((currency) => ({ value: currency.code, label: currency.code, hint: currency.name }))}/>}
    {(tagOptions.length > 0 || filters.tagIds.length > 0) && <MultiSelect label="Тег истории" title="Теги" placeholder="Тег" allLabel="Все теги" values={filters.tagIds} onChange={(values) => updateFilters({ tagIds: values })} count={(n) => `${n} ${pluralRu(n, ['тег', 'тега', 'тегов'])}`} options={tagOptions.map((tag) => ({ value: tag.id, label: tag.name }))}/>}
    </div>
    <button type="button" className={`filter-chip chip-icon${searchOpen || filters.query ? ' active' : ''}`} aria-label="Поиск" aria-pressed={searchOpen} onClick={() => { if (searchOpen) updateFilters({ query: '' }); else focusSearch.current = true; setSearchOpen((value) => !value) }}><SearchIcon/></button>
  </div>
  const search = (searchOpen || filters.query) && <input ref={(node) => { if (node && focusSearch.current) { focusSearch.current = false; node.focus() } }} className="search" type="search" placeholder="Поиск" aria-label="Поиск по истории" value={filters.query} onChange={(event) => updateFilters({ query: event.target.value })}/>
  // Без блока «Итог» строка остаётся, только пока фильтр что-то прячет: сколько показано и как сбросить.
  const totalLine = <div className="history-total-line">
    {showTotal && totalLabel && <button type="button" className="history-total" aria-label={`Сумма показанных расходов: ${totalLabel}`} aria-expanded={totalParts ? showParts : undefined} onClick={() => totalParts && setShowParts((value) => !value)}>{totalLabel}</button>}
    <span>{showTotal && totalLabel ? '· ' : ''}{countLabel}</span>
    {filtersActive && <button type="button" className="history-reset" onClick={resetFilters}>Сбросить</button>}
  </div>
  // Панель над списком: в настройке экрана — блоки в рамках, в выборе записей — полоса выбора, иначе — фильтры и итог, если
  // человек их оставил. Вход в выбор и выход из него панель проходит плавно, по высоте (GlideSlot).
  const toolbarView = editing ? 'editing' : !activeExpenses.length ? null : selected.size > 0 ? 'select' : showFilters || showTotal ? 'rest' : null
  return <section ref={sectionRef} className={`page history-page${editing ? ' arranging' : ''}`}>
    <GlideSlot view={toolbarView} glides={selectionGlides} className="history-toolbar-slot">{toolbarView !== null && (editing
      ? <div ref={toolbarDrag.listRef} className="history-toolbar">
        {toolbarDrag.shown.map((block) => <div key={block.id} data-drag-id={block.id} data-flip-id={block.id} className={`arrange-slot${toolbarDrag.lifted === block.id ? ' lifted' : ''}`}>
          <EditBlock {...editBlock(block.id, true)} flipId={undefined} move={toolbarBlocks.length > 1 ? { ...toolbarDrag.handle(block.id), onKeyDown: (event) => toolbarDrag.keyMove(event, block.id) } : undefined}>{block.id === 'filters' ? <>{chips}{search}</> : totalLine}</EditBlock>
        </div>)}
        {historyBlocks.hidden.filter((block) => !block.pinned).map((block) => <EditBlock key={block.id} {...editBlock(block.id, true)}/>)}
      </div>
      : <div className="history-toolbar">
        {selected.size > 0 && <div className="history-selectbar" role="toolbar" aria-label="Выбранные расходы"><span>Выбрано {selected.size}</span><button type="button" className="danger-link" onClick={removeSelected} disabled={deleting} aria-label={`Удалить выбранные расходы: ${selected.size}`}>Удалить</button><button type="button" className="text-button" onClick={() => setSelected(new Set())}>Отмена</button></div>}
        {toolbarBlocks.map((block) => block.id === 'filters'
          ? selected.size === 0 && <Fragment key="filters">{chips}{search}</Fragment>
          : <Fragment key="total">{totalLine}{showParts && totalParts && <p className="history-total-parts">{totalParts}{totals.missing.length ? ` · нет курса: ${totals.missing.join(', ')}` : ''}</p>}</Fragment>)}
        {!showTotal && filtersActive && totalLine}
        {periodOpen && <PeriodSheet value={filters.period} onClose={() => setPeriodOpen(false)} onSelect={(period) => {
          setPeriodOpen(false)
          // Свой период без дат бесполезен, поэтому календарь открывается сразу.
          if (period === 'range') { setCalendar(true); return }
          if (period !== filters.period) updateFilters({ period })
        }}/>}
      </div>)}</GlideSlot>
    <GlideSlot view={reminder && !selected.size ? 'card' : null} className="history-card">{reminder && (reminder.compact
      ? <div className="history-inbox history-reminder compact" inert={editing} data-flip-id="reminder"><span className="reminder-mark"><LockIcon/></span><b>Сохраните ссылку доступа</b><button type="button" className="text-button reminder-save" onClick={reminder.onSave}>Сохранить</button><button type="button" className="text-button reminder-later" onClick={reminder.onLater}>Позже</button></div>
      : <div className="history-inbox history-reminder" inert={editing} data-flip-id="reminder"><span className="reminder-mark"><LockIcon/></span><span><b>Сохраните ссылку доступа</b><small>Иначе без этого телефона расходы не вернуть</small></span><span className="reminder-actions"><button type="button" className="reminder-action" onClick={reminder.onSave}>Сохранить</button><button type="button" className="text-button reminder-later" onClick={reminder.onLater}>Позже</button></span></div>)}</GlideSlot>
    <GlideSlot view={inbox && inbox.count > 0 && !selected.size ? 'card' : null} className="history-card">{inbox && <button type="button" className="history-inbox" inert={editing} data-flip-id="inbox" onClick={inbox.onOpen}><CardMark/><span><b>{inbox.count} {pluralRu(inbox.count, ['операция с карты ждёт', 'операции с карты ждут', 'операций с карты ждут'])} разбора</b><small>Выбрать категории</small></span><ChevronIcon/></button>}</GlideSlot>
    {/* Суммы по дням настраиваются у первого дня: в рамке с «−» или заготовкой на месте суммы. */}
    <div ref={listRef} className={`history-list${selected.size ? ' selecting' : ''}`} data-flip-id="list">{shown.days.map(({ date, items, total }, index) => <div key={date} className="history-day"><div className="history-date"><span>{formatHistoryDate(date)}</span>{editing && index === 0 ? <EditBlock {...editBlock('day-totals')} className="day-totals-block"><b>{total ?? '—'}</b></EditBlock> : showDayTotals && total && <b>{total}</b>}</div>{items.map((expense) => <HistoryRow key={expense.id} expense={expense} category={categoryMap.get(expense.categoryId)} tags={tags} currencies={bootstrap.currencies} checked={selected.has(expense.id)} selecting={selected.size > 0} open={openRow === expense.id} disabled={deleting} inert={editing} onOpen={setOpenRow} onToggle={toggle} onEdit={editRow} onDelete={deleteRow} onVoided={setVoided}/>)}</div>)}</div>
    {hasRest && <div ref={restRef} className="history-rest" aria-hidden="true"/>}
    {older && (activeFilters.period === 'all' || activeFilters.period === 'range') && !selected.size && <div className="history-older" inert={editing} data-flip-id="older"><span>{older.count === 1 ? 'Ещё одна запись' : `Ещё ${older.count} ${pluralRu(older.count, ['запись', 'записи', 'записей'])}`} до {formatMonthYear(older.since)}</span><button type="button" className="text-button" disabled={older.busy} onClick={older.load}>{older.busy ? 'Загружаем…' : 'Показать'}</button></div>}
    {!groups.length && <div className="list-empty" role="status" inert={editing}><span>{filtersActive ? 'Ничего не найдено' : 'История пока пуста'}</span><p>{filtersActive ? 'Измените фильтры или сбросьте их.' : 'Добавьте первый расход — он сразу появится здесь.'}</p>{!filtersActive && <button type="button" className="primary history-empty-action" onClick={createNew}>Добавить первый расход</button>}</div>}
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
