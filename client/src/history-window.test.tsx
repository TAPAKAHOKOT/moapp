// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { HISTORY_FIRST_ROWS, HISTORY_MORE_ROWS, HistoryView, LONG_PRESS_MS, ROW_PRESS_DELAY_MS, ROW_SETTLE_LIMIT_MS } from './screens/History'
import * as workspaceApi from './workspace-api'
import type { Expense, WorkspaceBootstrap } from './types'

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// Записи по нескольку в день, от свежих к старым: так в окно попадают и целые дни, и последний — частично.
function bootstrapWith(count: number): WorkspaceBootstrap {
  const workspace = { id: 'workspace-a', name: 'Дом', role: 'owner' as const, version: 1, joinedAt: '2026-01-01T00:00:00.000Z' }
  const start = Date.parse('2026-09-20T12:00:00.000Z')
  const expenses: Expense[] = Array.from({ length: count }, (_, index) => {
    const at = new Date(start - Math.floor(index / 3) * 86_400_000 - (index % 3) * 3_600_000).toISOString()
    return { id: `e${index}`, amountMinor: 1_000 + index, currency: 'RSD', categoryId: 'products', note: null, occurredAt: at, createdAt: at, updatedAt: at, version: 1, deletedAt: null }
  })
  return {
    workspaceId: workspace.id,
    workspace,
    categories: [{ id: 'products', name: 'Продукты', color: '#758d69', placement: 'main', sortOrder: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null, version: 1 }],
    currencies: [{ code: 'RSD', name: 'Сербский динар', symbol: 'дин.', decimals: 2 }],
    rates: { base: 'RSD', date: '2026-09-20', ratesToRsd: { RSD: 1 } },
    tags: [],
    expenses,
    defaultAnalyticsCurrency: 'RSD',
    serverTime: '2026-09-20T14:00:00.000Z',
  }
}

const props = { userId: 'user-a', workspaceId: 'workspace-a', setBootstrap: vi.fn(), edit: vi.fn(), createNew: vi.fn(), refreshPending: vi.fn() }

// Поддельный IntersectionObserver: тест сам решает, когда отступ под нарисованными строками подошёл к экрану.
class FakeObserver {
  static live = new Set<FakeObserver>()
  targets = new Set<Element>()
  constructor(readonly callback: IntersectionObserverCallback, readonly options: IntersectionObserverInit = {}) {}
  observe(target: Element) { this.targets.add(target); FakeObserver.live.add(this) }
  unobserve(target: Element) { this.targets.delete(target) }
  disconnect() { this.targets.clear(); FakeObserver.live.delete(this) }
  takeRecords() { return [] }
}

function stubObserver() {
  FakeObserver.live.clear()
  vi.stubGlobal('IntersectionObserver', FakeObserver)
}

const reachRest = () => act(() => {
  for (const observer of [...FakeObserver.live]) {
    const entries = [...observer.targets].map((target) => ({ target, isIntersecting: true, intersectionRatio: 1, boundingClientRect: target.getBoundingClientRect(), intersectionRect: target.getBoundingClientRect(), rootBounds: null, time: 0 }))
    observer.callback(entries as unknown as IntersectionObserverEntry[], observer as unknown as IntersectionObserver)
  }
})

const rows = (container: HTMLElement) => container.querySelectorAll('.history-expense').length

describe('history window', () => {
  it('draws the first rows, keeps room for the rest and adds more as the rest comes near', () => {
    stubObserver()
    const { container } = render(<HistoryView {...props} bootstrap={bootstrapWith(400)}/>)

    expect(rows(container)).toBe(HISTORY_FIRST_ROWS)
    expect(container.querySelector('.history-rest')).not.toBeNull()
    // Итог и счётчик считаются по всем записям, а не по нарисованным.
    expect(container.querySelector('.history-total-line')?.textContent).toContain('400 записей')

    reachRest()
    expect(rows(container)).toBe(HISTORY_FIRST_ROWS + HISTORY_MORE_ROWS)
    reachRest()
    expect(rows(container)).toBe(400)
    expect(container.querySelector('.history-rest')).toBeNull()
  })

  it('watches for the rest from the page it scrolls in, two screens ahead', () => {
    stubObserver()
    const { container } = render(<div className="page-slot"><HistoryView {...props} bootstrap={bootstrapWith(300)}/></div>)
    const [observer] = [...FakeObserver.live]
    expect(observer?.options.root).toBe(container.querySelector('.page-slot'))
    expect(observer?.options.rootMargin).toMatch(/ 200% 0px$/)
    expect([...observer!.targets]).toEqual([container.querySelector('.history-rest')])
  })

  it('goes back to the first rows when a filter or the search changes', () => {
    stubObserver()
    const { container } = render(<HistoryView {...props} bootstrap={bootstrapWith(400)}/>)
    reachRest()
    expect(rows(container)).toBe(HISTORY_FIRST_ROWS + HISTORY_MORE_ROWS)

    // Код валюты есть в тексте каждой записи: поиск оставляет все 400, но окно начинается сначала.
    fireEvent.click(screen.getByRole('button', { name: 'Поиск' }))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'rsd' } })
    expect(rows(container)).toBe(HISTORY_FIRST_ROWS)
    expect(container.querySelector('.history-total-line')?.textContent).toContain('400 записей')
  })

  it('draws every row where IntersectionObserver is missing', () => {
    const { container } = render(<HistoryView {...props} bootstrap={bootstrapWith(400)}/>)
    expect(rows(container)).toBe(400)
    expect(container.querySelector('.history-rest')).toBeNull()
  })

  it('keeps the strip of older records after the rest, seen only at the very end', () => {
    stubObserver()
    const { container } = render(<HistoryView {...props} bootstrap={bootstrapWith(300)} older={{ count: 12, since: '2025-09-01', busy: false, load: vi.fn() }}/>)
    const order = [...container.querySelector('.history-page')!.children].map((node) => node.className)
    expect(order.slice(order.indexOf('history-list'))).toEqual(['history-list', 'history-rest', 'history-older'])
  })

  it('drops the extra rows once the tab is left near its top, and keeps them when left deep in the list', async () => {
    stubObserver()
    vi.useFakeTimers()
    const { container } = render(<div className="pager"><div className="page-slot"><HistoryView {...props} bootstrap={bootstrapWith(400)}/></div></div>)
    const slot = container.querySelector<HTMLElement>('.page-slot')!
    reachRest()
    expect(rows(container)).toBe(HISTORY_FIRST_ROWS + HISTORY_MORE_ROWS)

    // Ушли далеко вниз: окно остаётся, чтобы вернуться на то же место.
    Object.defineProperty(slot, 'scrollTop', { configurable: true, value: 5_000 })
    await act(async () => { slot.setAttribute('inert', '') })
    act(() => vi.advanceTimersByTime(2_000))
    expect(rows(container)).toBe(HISTORY_FIRST_ROWS + HISTORY_MORE_ROWS)

    await act(async () => { slot.removeAttribute('inert') })
    Object.defineProperty(slot, 'scrollTop', { configurable: true, value: 0 })
    await act(async () => { slot.setAttribute('inert', '') })
    // Пока лента вкладок едет, строки не снимаются: перерисовка посреди анимации стоила бы кадра.
    act(() => vi.advanceTimersByTime(300))
    fireEvent.scroll(container.querySelector('.pager')!)
    act(() => vi.advanceTimersByTime(300))
    expect(rows(container)).toBe(HISTORY_FIRST_ROWS + HISTORY_MORE_ROWS)
    act(() => vi.advanceTimersByTime(2_000))
    expect(rows(container)).toBe(HISTORY_FIRST_ROWS)
  })
})

describe('history rows at rest', () => {
  // Мышью: строку тянут и отпускают, клик следом за жестом строка гасит сама.
  const drag = (row: Element, from: number, to: number) => {
    fireEvent.pointerDown(row, { pointerType: 'mouse', button: 0, clientX: from, clientY: 20 })
    fireEvent.pointerMove(row, { pointerType: 'mouse', clientX: to, clientY: 20 })
    fireEvent.pointerUp(row, { pointerType: 'mouse', clientX: to, clientY: 20 })
    fireEvent.click(row.querySelector('.history-row')!)
  }
  const tapRow = (row: Element) => {
    fireEvent.pointerDown(row, { pointerType: 'mouse', button: 0, clientX: 150, clientY: 20 })
    fireEvent.pointerUp(row, { pointerType: 'mouse', clientX: 150, clientY: 20 })
    fireEvent.click(row.querySelector('.history-row')!)
  }
  // Конец пути строки: переход transform у самого .history-swipe.
  const slidEnd = (row: Element) => fireEvent.transitionEnd(row.querySelector('.history-swipe')!, { propertyName: 'transform' })
  const deleteOf = (row: Element) => row.querySelector('.history-swipe-delete')
  const deletes = (container: HTMLElement) => container.querySelectorAll('.history-swipe-delete')

  it('draws resting rows without the delete button and with their plain class', () => {
    const { container } = render(<HistoryView {...props} bootstrap={bootstrapWith(5)}/>)
    expect(deletes(container)).toHaveLength(0)
    expect([...container.querySelectorAll('.history-expense')].map((row) => row.className)).toEqual(Array(5).fill('history-expense'))
    // Чекбокс выбора остаётся у каждой строки: его появление анимировано.
    expect(container.querySelectorAll('.history-expense .expense-check')).toHaveLength(5)
  })

  it('keeps the delete button under a row that is dragged, open and sliding back after a tap', () => {
    const { container } = render(<HistoryView {...props} bootstrap={bootstrapWith(5)}/>)
    const [row, other] = container.querySelectorAll('.history-expense')

    fireEvent.pointerDown(row!, { pointerType: 'mouse', button: 0, clientX: 300, clientY: 20 })
    fireEvent.pointerMove(row!, { pointerType: 'mouse', clientX: 220, clientY: 20 })
    expect(row!.classList.contains('dragging')).toBe(true)
    expect(deleteOf(row!)).not.toBeNull()
    fireEvent.pointerUp(row!, { pointerType: 'mouse', clientX: 220, clientY: 20 })
    fireEvent.click(row!.querySelector('.history-row')!)
    expect(row!.className).toBe('history-expense open')
    expect(screen.getByRole('button', { name: 'Удалить' })).toBe(deleteOf(row!))
    // Строка доехала до открытого положения — это не конец закрытия, кнопка на месте.
    slidEnd(row!)
    expect(deleteOf(row!)).not.toBeNull()

    tapRow(row!)
    expect(row!.className).toBe('history-expense closing')
    expect(deleteOf(row!)).not.toBeNull()
    // Переходы потомков (фон строки, галочка) всплывают сюда же, но концом пути не считаются.
    fireEvent.transitionEnd(row!.querySelector('.history-row')!, { propertyName: 'background-color' })
    fireEvent.transitionEnd(row!.querySelector('.history-row')!, { propertyName: 'transform' })
    expect(deleteOf(row!)).not.toBeNull()
    slidEnd(row!)
    expect(deleteOf(row!)).toBeNull()
    expect(row!.className).toBe('history-expense')
    expect(other!.className).toBe('history-expense')
    expect(deletes(container)).toHaveLength(0)
  })

  it('keeps the button while a row dragged back slides home, even when its opening slide ends late', () => {
    const { container } = render(<HistoryView {...props} bootstrap={bootstrapWith(5)}/>)
    const [row] = container.querySelectorAll('.history-expense')
    drag(row!, 300, 200)
    expect(row!.className).toBe('history-expense open')

    // Протяжка открытой строки обратно дальше половины кнопки: строка доезжает до места сама.
    drag(row!, 180, 240)
    expect(row!.className).toBe('history-expense closing')
    const swipe = row!.querySelector<HTMLElement>('.history-swipe')!
    // Переход открытия кончился в тот же кадр, когда началось закрытие: строка ещё сдвинута, путь не пройден.
    swipe.style.transform = 'translateX(-40px)'
    slidEnd(row!)
    expect(deleteOf(row!)).not.toBeNull()
    swipe.style.transform = ''
    slidEnd(row!)
    expect(deleteOf(row!)).toBeNull()
    expect(row!.className).toBe('history-expense')
  })

  it('lets the open row slide home with its button when another row opens', () => {
    const { container } = render(<HistoryView {...props} bootstrap={bootstrapWith(5)}/>)
    const [first, second] = container.querySelectorAll('.history-expense')
    drag(first!, 300, 200)
    drag(second!, 300, 200)
    expect(second!.className).toBe('history-expense open')
    expect(first!.className).toBe('history-expense closing')
    expect(deleteOf(first!)).not.toBeNull()
    slidEnd(first!)
    expect(deleteOf(first!)).toBeNull()
    expect(deletes(container)).toHaveLength(1)
  })

  it('does not wait for a slide when the released row never left its place', () => {
    const { container } = render(<HistoryView {...props} bootstrap={bootstrapWith(5)}/>)
    const [row] = container.querySelectorAll('.history-expense')
    // Вправо закрытая строка не едет: сдвиг остаётся нулевым, и ехать на место нечему.
    fireEvent.pointerDown(row!, { pointerType: 'mouse', button: 0, clientX: 100, clientY: 20 })
    fireEvent.pointerMove(row!, { pointerType: 'mouse', clientX: 160, clientY: 20 })
    expect(row!.classList.contains('dragging')).toBe(true)
    fireEvent.pointerUp(row!, { pointerType: 'mouse', clientX: 160, clientY: 20 })
    expect(row!.className).toBe('history-expense')
    expect(deleteOf(row!)).toBeNull()
  })

  it('lets a row go once it has surely arrived, even if the end of its slide was never reported', () => {
    vi.useFakeTimers()
    const { container } = render(<HistoryView {...props} bootstrap={bootstrapWith(5)}/>)
    const [row] = container.querySelectorAll('.history-expense')
    drag(row!, 300, 200)
    tapRow(row!)
    act(() => vi.advanceTimersByTime(ROW_SETTLE_LIMIT_MS - 1))
    expect(deleteOf(row!)).not.toBeNull()
    act(() => vi.advanceTimersByTime(1))
    expect(deleteOf(row!)).toBeNull()
    expect(row!.className).toBe('history-expense')
  })

  it('keeps the old layers for a row whose payment did not go through', () => {
    const bootstrap = bootstrapWith(3)
    bootstrap.expenses[1] = { ...bootstrap.expenses[1]!, voidedAt: '2026-09-20T12:00:00.000Z', voidReason: null }
    const { container } = render(<HistoryView {...props} bootstrap={bootstrap}/>)
    expect([...container.querySelectorAll('.history-expense')].map((row) => row.className)).toEqual(['history-expense', 'history-expense voided', 'history-expense'])
    expect(deletes(container)).toHaveLength(0)
  })

  it('still deletes a record from its swipe button', async () => {
    const submit = vi.spyOn(workspaceApi, 'submitExpenseOperation').mockResolvedValue(null)
    const { container } = render(<HistoryView {...props} bootstrap={bootstrapWith(5)}/>)
    drag(container.querySelector('.history-expense')!, 300, 200)
    fireEvent.click(screen.getByRole('button', { name: 'Удалить' }))
    await waitFor(() => expect(submit).toHaveBeenCalledWith('user-a', 'workspace-a', 'deleteExpense', expect.objectContaining({ id: 'e0' })))
    expect(await screen.findByText('Расход удалён')).not.toBeNull()
  })
})

describe('history row press', () => {
  // На телефоне жест строки ведут touch-события: строка слушает их, если у окна есть ontouchstart.
  const touch = (node: Element, type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel', x = 150, y = 20) => {
    const point = { identifier: 1, clientX: x, clientY: y }
    const event = new Event(type, { bubbles: true, cancelable: true })
    const lifted = type === 'touchend' || type === 'touchcancel'
    Object.defineProperties(event, { touches: { value: lifted ? [] : [point] }, changedTouches: { value: [point] } })
    act(() => { node.dispatchEvent(event) })
  }
  const later = (ms: number) => act(() => vi.advanceTimersByTime(ms))
  const pressed = (row: Element) => row.classList.contains('pressed')
  const onPhone = (edit = vi.fn()) => {
    vi.stubGlobal('ontouchstart', null)
    vi.useFakeTimers()
    const view = render(<HistoryView {...props} edit={edit} bootstrap={bootstrapWith(5)}/>)
    return { ...view, row: view.container.querySelector('.history-expense')!, edit }
  }

  it('lights a touched row only once the finger has stayed still for a moment', () => {
    const { row } = onPhone()
    touch(row, 'touchstart')
    expect(pressed(row)).toBe(false)
    later(ROW_PRESS_DELAY_MS - 1)
    // Палец дрогнул в пределах порога — это ещё касание, а не прокрутка.
    touch(row, 'touchmove', 155, 26)
    expect(pressed(row)).toBe(false)
    later(1)
    expect(pressed(row)).toBe(true)
    touch(row, 'touchend', 155, 26)
    expect(pressed(row)).toBe(false)
  })

  it('does not light a row the finger scrolls or swipes past', () => {
    const { row } = onPhone()
    touch(row, 'touchstart')
    later(50)
    touch(row, 'touchmove', 150, 32)
    later(200)
    expect(pressed(row)).toBe(false)
    touch(row, 'touchend', 150, 32)

    touch(row, 'touchstart', 300)
    later(50)
    touch(row, 'touchmove', 288)
    later(200)
    expect(pressed(row)).toBe(false)
    touch(row, 'touchend', 288)
  })

  it('drops the light when the finger moves on or the touch is cancelled', () => {
    const { row } = onPhone()
    touch(row, 'touchstart')
    later(ROW_PRESS_DELAY_MS)
    expect(pressed(row)).toBe(true)
    touch(row, 'touchmove', 150, 32)
    expect(pressed(row)).toBe(false)
    touch(row, 'touchend', 150, 32)

    touch(row, 'touchstart')
    later(ROW_PRESS_DELAY_MS)
    expect(pressed(row)).toBe(true)
    touch(row, 'touchcancel')
    expect(pressed(row)).toBe(false)
  })

  it('keeps the tap, the long press and the swipe of a touched row', () => {
    const { row, edit } = onPhone()
    touch(row, 'touchstart')
    later(60)
    touch(row, 'touchend')
    fireEvent.click(row.querySelector('.history-row')!)
    expect(edit).toHaveBeenCalledWith('e0')

    touch(row, 'touchstart')
    later(LONG_PRESS_MS)
    expect(row.classList.contains('selected')).toBe(true)
    expect(pressed(row)).toBe(true)
    touch(row, 'touchend')
    expect(pressed(row)).toBe(false)
    // Клик следом за долгим нажатием гасится, выбор остаётся; следующий тап снимает его.
    fireEvent.click(row.querySelector('.history-row')!)
    expect(row.classList.contains('selected')).toBe(true)
    touch(row, 'touchstart')
    touch(row, 'touchend')
    fireEvent.click(row.querySelector('.history-row')!)
    expect(row.classList.contains('selected')).toBe(false)

    touch(row, 'touchstart', 300)
    touch(row, 'touchmove', 220)
    expect(row.classList.contains('dragging')).toBe(true)
    touch(row, 'touchend', 220)
    expect(row.className).toBe('history-expense open')
  })

  it('leaves the mouse to CSS :active: a mouse press sets no class and listens to nothing outside the row', () => {
    const listen = vi.spyOn(window, 'addEventListener')
    vi.useFakeTimers()
    const { container } = render(<HistoryView {...props} bootstrap={bootstrapWith(5)}/>)
    const row = container.querySelector('.history-expense')!
    listen.mockClear()
    fireEvent.pointerDown(row, { pointerType: 'mouse', button: 0, clientX: 150, clientY: 20 })
    later(ROW_PRESS_DELAY_MS)
    expect(pressed(row)).toBe(false)
    expect(listen.mock.calls.map(([type]) => type)).not.toContain('pointerup')
    fireEvent.pointerUp(row, { pointerType: 'mouse', clientX: 150, clientY: 20 })
    expect(pressed(row)).toBe(false)
  })

  // Браузер без touch-событий (jsdom их объявляет): касание приходит только pointer-событиями.
  const withoutTouchEvents = () => {
    let owner: object | null = window
    while (owner && !Object.prototype.hasOwnProperty.call(owner, 'ontouchstart')) owner = Object.getPrototypeOf(owner)
    if (!owner) return
    const descriptor = Object.getOwnPropertyDescriptor(owner, 'ontouchstart')!
    delete (owner as { ontouchstart?: unknown }).ontouchstart
    onTestFinished(() => { Object.defineProperty(owner, 'ontouchstart', descriptor) })
  }

  it('lights a row touched through pointer events alone the same way as through touch events', () => {
    withoutTouchEvents()
    expect('ontouchstart' in window).toBe(false)
    vi.useFakeTimers()
    const { container } = render(<HistoryView {...props} bootstrap={bootstrapWith(5)}/>)
    const row = container.querySelector('.history-expense')!
    const finger = { pointerType: 'touch', button: 0, clientX: 150, clientY: 20 }
    fireEvent.pointerDown(row, finger)
    later(ROW_PRESS_DELAY_MS - 1)
    expect(pressed(row)).toBe(false)
    later(1)
    expect(pressed(row)).toBe(true)
    fireEvent.pointerUp(row, finger)
    expect(pressed(row)).toBe(false)

    // Браузер забрал палец листать список — pointercancel гасит плашку; сдвиг дальше порога — тоже.
    fireEvent.pointerDown(row, finger)
    later(ROW_PRESS_DELAY_MS)
    fireEvent.pointerCancel(row, finger)
    expect(pressed(row)).toBe(false)
    fireEvent.pointerDown(row, finger)
    later(ROW_PRESS_DELAY_MS)
    fireEvent.pointerMove(row, { ...finger, clientY: 32 })
    expect(pressed(row)).toBe(false)
  })
})

describe('history cards above the list', () => {
  // jsdom ничего не раскладывает: обёртка карточки в покое высотой 76 px, а в движении — какую ей поставили.
  const CARD_HEIGHT = 76
  const measureCards = () => vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const height = this.classList.contains('history-card') ? (this.style.height ? parseFloat(this.style.height) : CARD_HEIGHT) : 0
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: height, width: 0, height, toJSON: () => ({}) } as DOMRect
  })
  const inbox = { count: 3, onOpen: vi.fn() }
  const reminder = { onSave: vi.fn(), onLater: vi.fn(), compact: false }
  const slots = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('.history-card')]
  const height = (slot: HTMLElement) => slot.style.height === '' ? null : parseFloat(slot.style.height)
  const frames = (ms: number) => act(() => vi.advanceTimersByTime(ms))
  const view = (cards: { inbox?: typeof inbox | null; reminder?: typeof reminder | null }) => <HistoryView {...props} bootstrap={bootstrapWith(5)} {...cards}/>

  it('shows the cards that are ready with the screen at once, in their final layout', () => {
    measureCards()
    vi.useFakeTimers()
    const { container } = render(view({ inbox, reminder }))
    const [first, second] = slots(container)
    expect(first!.querySelector('.history-reminder')).not.toBeNull()
    expect(second!.querySelector('.history-inbox:not(.history-reminder)')?.textContent).toContain('3 операции с карты ждут разбора')
    for (const slot of [first!, second!]) {
      expect(slot.getAttribute('style')).toBeNull()
      expect(slot.hasAttribute('inert')).toBe(false)
    }
    // Карточки стоят между панелью фильтров (в своей обёртке) и списком, как и раньше.
    const order = [...container.querySelector('.history-page')!.children].map((node) => node.className)
    expect(order.slice(0, 4)).toEqual(['history-toolbar-slot', 'history-card', 'history-card', 'history-list'])
  })

  it('unfolds a card that comes to a shown screen and folds one that goes away', () => {
    measureCards()
    vi.useFakeTimers()
    const { container, rerender } = render(view({ inbox: null }))
    expect(slots(container)).toHaveLength(0)

    rerender(view({ inbox }))
    const [slot] = slots(container)
    // До первого кадра карточка уже в DOM, но закрыта: высота 0, содержимое обрезано.
    expect(height(slot!)).toBe(0)
    expect(slot!.style.overflow).toBe('hidden')
    frames(100)
    expect(height(slot!)).toBeGreaterThan(CARD_HEIGHT / 2)
    expect(height(slot!)).toBeLessThan(CARD_HEIGHT)
    frames(150)
    expect(slot!.getAttribute('style')).toBe('')
    expect(slot!.textContent).toContain('3 операции с карты ждут разбора')

    rerender(view({ inbox: null }))
    // Уходящая карточка ещё видна и сворачивается, но уже не нажимается.
    expect(slots(container)).toEqual([slot])
    expect(slot!.hasAttribute('inert')).toBe(true)
    expect(slot!.textContent).toContain('3 операции с карты ждут разбора')
    expect(height(slot!)).toBe(CARD_HEIGHT)
    frames(100)
    expect(height(slot!)).toBeGreaterThan(0)
    expect(height(slot!)).toBeLessThan(CARD_HEIGHT / 2)
    frames(150)
    expect(slots(container)).toHaveLength(0)
  })

  it('turns a folding card back from where it is when it returns', () => {
    measureCards()
    vi.useFakeTimers()
    const { container, rerender } = render(view({ reminder }))
    rerender(view({ reminder: null }))
    frames(100)
    const [slot] = slots(container)
    const folded = height(slot!)!
    rerender(view({ reminder }))
    expect(slots(container)).toEqual([slot])
    expect(slot!.hasAttribute('inert')).toBe(false)
    expect(height(slot!)).toBe(folded)
    frames(250)
    expect(slot!.getAttribute('style')).toBe('')
  })

  it('folds the cards away while records are selected', () => {
    measureCards()
    vi.useFakeTimers()
    const { container } = render(view({ inbox, reminder }))
    expect(slots(container)).toHaveLength(2)
    const row = container.querySelector('.history-expense')!
    fireEvent.pointerDown(row, { pointerType: 'mouse', button: 0, clientX: 150, clientY: 20 })
    frames(LONG_PRESS_MS)
    fireEvent.pointerUp(row, { pointerType: 'mouse', clientX: 150, clientY: 20 })
    expect(slots(container).every((slot) => slot.hasAttribute('inert'))).toBe(true)
    frames(250)
    expect(slots(container)).toHaveLength(0)
  })

  it('shows and hides cards at once when motion is reduced', () => {
    measureCards()
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {} }))
    vi.useFakeTimers()
    const { container, rerender } = render(view({ inbox: null }))
    rerender(view({ inbox }))
    expect(slots(container)).toHaveLength(1)
    expect(slots(container)[0]!.getAttribute('style')).toBeNull()
    rerender(view({ inbox: null }))
    expect(slots(container)).toHaveLength(0)
  })

  it('shows and hides cards at once on a tab that is out of sight', () => {
    measureCards()
    vi.useFakeTimers()
    const hidden = (cards: Parameters<typeof view>[0]) => <div className="page-slot" inert><HistoryView {...props} bootstrap={bootstrapWith(5)} {...cards}/></div>
    const { container, rerender } = render(hidden({ reminder: null }))
    rerender(hidden({ reminder }))
    expect(slots(container)[0]!.getAttribute('style')).toBeNull()
    rerender(hidden({ reminder: null }))
    expect(slots(container)).toHaveLength(0)
  })
})

describe('history toolbar entering and leaving selection', () => {
  // jsdom ничего не раскладывает: обёртка панели в покое высотой со своё содержимое (отступ сверху 14, полосы через 10),
  // а в движении — какую ей поставили.
  const PART: Record<string, number> = { 'history-selectbar': 36, 'history-chips': 38, search: 44, 'history-total-line': 24 }
  const natural = (toolbar: Element | null) => {
    const parts = toolbar ? [...toolbar.children].map((child) => PART[child.classList[0] ?? ''] ?? 0).filter(Boolean) : []
    return 14 + parts.reduce((sum, part) => sum + part, 0) + 10 * Math.max(0, parts.length - 1)
  }
  const measure = () => vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const height = !this.classList.contains('history-toolbar-slot') ? 0 : this.style.height ? parseFloat(this.style.height) : natural(this.firstElementChild)
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: height, width: 0, height, toJSON: () => ({}) } as DOMRect
  })
  // Поддельный ResizeObserver: после каждого «кадра» сообщает нынешние размеры, как настоящий после раскладки.
  class FakeResizeObserver {
    static live = new Set<FakeResizeObserver>()
    targets = new Set<Element>()
    constructor(readonly callback: ResizeObserverCallback) {}
    observe(target: Element) { this.targets.add(target); FakeResizeObserver.live.add(this) }
    unobserve(target: Element) { this.targets.delete(target) }
    disconnect() { this.targets.clear(); FakeResizeObserver.live.delete(this) }
  }
  const setup = () => {
    measure()
    FakeResizeObserver.live.clear()
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    vi.useFakeTimers()
  }
  const layout = () => {
    for (const observer of [...FakeResizeObserver.live]) {
      const entries = [...observer.targets].map((target) => ({ target, contentRect: target.getBoundingClientRect() }))
      observer.callback(entries as unknown as ResizeObserverEntry[], observer as unknown as ResizeObserver)
    }
  }
  const frames = (ms: number) => act(() => { vi.advanceTimersByTime(ms); layout() })
  const slot = (container: HTMLElement) => container.querySelector<HTMLElement>('.history-toolbar-slot')
  const height = (node: HTMLElement) => node.style.height === '' ? null : parseFloat(node.style.height)
  const parts = (node: HTMLElement) => [...node.querySelector('.history-toolbar')!.children].map((child) => child.className)
  const hold = (container: HTMLElement) => {
    const row = container.querySelector('.history-expense')!
    fireEvent.pointerDown(row, { pointerType: 'mouse', button: 0, clientX: 150, clientY: 20 })
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS) })
    fireEvent.pointerUp(row, { pointerType: 'mouse', clientX: 150, clientY: 20 })
  }
  const cancel = () => fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))
  const onlyTotal = { shown: ['total'], hidden: ['filters'] }
  const noToolbar = { shown: [], hidden: ['filters', 'total'] }
  const view = (blocks?: { shown: string[]; hidden: string[] }, extra: { editing?: boolean } = {}) => <HistoryView {...props} bootstrap={bootstrapWith(5)} blocks={blocks} {...extra}/>

  it('grows the toolbar from its old height to the new one as records get selected, then lets it rest', () => {
    setup()
    const { container } = render(view(onlyTotal))
    const toolbar = slot(container)!
    // Первый рендер — сразу в конечном виде.
    expect(toolbar.getAttribute('style')).toBeNull()
    expect(parts(toolbar)).toEqual(['history-total-line'])
    layout()

    hold(container)
    // Содержимое уже новое, а высота пока прежняя и содержимое обрезано.
    expect(parts(toolbar)).toEqual(['history-selectbar', 'history-total-line'])
    expect(height(toolbar)).toBe(38)
    expect(toolbar.style.overflow).toBe('hidden')
    frames(100)
    expect(height(toolbar)).toBeGreaterThan(38 + 46 / 2)
    expect(height(toolbar)).toBeLessThan(84)
    frames(150)
    expect(toolbar.getAttribute('style')).toBe('')
    expect(slot(container)).toBe(toolbar)
    expect(toolbar.hasAttribute('inert')).toBe(false)
    expect(parts(toolbar)).toEqual(['history-selectbar', 'history-total-line'])
    expect(toolbar.textContent).toContain('Выбрано 1')
  })

  it('shrinks the toolbar back when the selection is cancelled', () => {
    setup()
    const { container } = render(view(onlyTotal))
    layout()
    hold(container)
    frames(250)
    const toolbar = slot(container)!

    cancel()
    expect(parts(toolbar)).toEqual(['history-total-line'])
    expect(height(toolbar)).toBe(84)
    expect(toolbar.style.overflow).toBe('hidden')
    frames(100)
    expect(height(toolbar)).toBeLessThan(84 - 46 / 2)
    expect(height(toolbar)).toBeGreaterThan(38)
    frames(150)
    expect(toolbar.getAttribute('style')).toBe('')
    expect(container.querySelector('.history-selectbar')).toBeNull()
    expect(container.querySelector('.history-expense.selected')).toBeNull()
  })

  it('unfolds a toolbar that exists only for the selection from zero and folds it away again', () => {
    setup()
    const { container } = render(view(noToolbar))
    expect(slot(container)).toBeNull()
    layout()

    hold(container)
    const toolbar = slot(container)!
    expect(parts(toolbar)).toEqual(['history-selectbar'])
    expect(height(toolbar)).toBe(0)
    expect(toolbar.style.overflow).toBe('hidden')
    frames(100)
    expect(height(toolbar)).toBeGreaterThan(25)
    expect(height(toolbar)).toBeLessThan(50)
    frames(150)
    expect(toolbar.getAttribute('style')).toBe('')

    cancel()
    // Уходящая панель ещё видна с последним содержимым и сворачивается, но уже не нажимается.
    expect(slot(container)).toBe(toolbar)
    expect(toolbar.hasAttribute('inert')).toBe(true)
    expect(toolbar.textContent).toContain('Выбрано 1')
    expect(height(toolbar)).toBe(50)
    frames(100)
    expect(height(toolbar)).toBeGreaterThan(0)
    expect(height(toolbar)).toBeLessThan(25)
    frames(150)
    expect(slot(container)).toBeNull()
    expect(container.querySelector('.history-expense.selected')).toBeNull()
  })

  it('turns a folding toolbar back from where it is when records are selected again', () => {
    setup()
    const { container } = render(view(noToolbar))
    layout()
    hold(container)
    frames(250)
    cancel()
    frames(100)
    const toolbar = slot(container)!
    const folded = height(toolbar)!
    expect(folded).toBeGreaterThan(0)
    // Долгое нажатие дольше сворачивания, поэтому запись снова отмечают её флажком.
    fireEvent.click(container.querySelector('.expense-check input')!)
    expect(slot(container)).toBe(toolbar)
    expect(toolbar.hasAttribute('inert')).toBe(false)
    expect(height(toolbar)).toBe(folded)
    frames(250)
    expect(toolbar.getAttribute('style')).toBe('')
  })

  it('changes the toolbar at once when motion is reduced or the tab is out of sight', () => {
    setup()
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {} }))
    const reduced = render(view(onlyTotal))
    layout()
    hold(reduced.container)
    expect(slot(reduced.container)!.getAttribute('style')).toBeNull()
    expect(parts(slot(reduced.container)!)).toEqual(['history-selectbar', 'history-total-line'])
    cancel()
    expect(slot(reduced.container)!.getAttribute('style')).toBeNull()
    reduced.unmount()
    vi.unstubAllGlobals()

    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    const hidden = render(<div className="page-slot" inert>{view(noToolbar)}</div>)
    layout()
    hold(hidden.container)
    expect(slot(hidden.container)!.getAttribute('style')).toBeNull()
    fireEvent.click(hidden.container.querySelector('.history-selectbar .text-button')!)
    expect(slot(hidden.container)).toBeNull()
  })

  it('leaves the other changes of the toolbar and the screen setup without motion', () => {
    setup()
    const { container, rerender } = render(view(undefined))
    const toolbar = slot(container)!
    layout()
    // Поиск открывается скачком, как раньше.
    fireEvent.click(screen.getByRole('button', { name: 'Поиск' }))
    expect(parts(toolbar)).toEqual(['history-chips', 'search', 'history-total-line'])
    expect(toolbar.getAttribute('style')).toBeNull()
    layout()

    // Настройка экрана посреди движения: панель сразу в своём виде, без высоты и обрезки.
    hold(container)
    expect(toolbar.style.overflow).toBe('hidden')
    rerender(view(undefined, { editing: true }))
    expect(slot(container)).toBe(toolbar)
    expect(toolbar.getAttribute('style')).toBe('')
    expect(toolbar.querySelectorAll('.arrange-slot')).toHaveLength(2)
    frames(250)
    expect(toolbar.getAttribute('style')).toBe('')
    rerender(view(undefined))
    expect(toolbar.getAttribute('style')).toBe('')
    expect(parts(toolbar)).toEqual(['history-chips', 'search', 'history-total-line'])
  })

  it('still enters the selection by a long press, cancels it and deletes the selected records', async () => {
    const submit = vi.spyOn(workspaceApi, 'submitExpenseOperations').mockImplementation(async (_user, _workspace, _type, expenses) => expenses.map((expense) => ({ status: 'applied', expense: { ...expense, deletedAt: '2026-09-20T15:00:00.000Z', version: expense.version + 1 } }) as never))
    setup()
    const { container } = render(view(undefined))
    layout()
    hold(container)
    expect(container.querySelector('.history-expense')!.classList.contains('selected')).toBe(true)
    expect(screen.getByRole('toolbar', { name: 'Выбранные расходы' }).textContent).toContain('Выбрано 1')
    cancel()
    expect(container.querySelector('.history-selectbar')).toBeNull()
    expect(container.querySelector('.history-expense.selected')).toBeNull()
    frames(250)

    hold(container)
    frames(250)
    // Удаление ждёт ответа сервера — дальше настоящие часы.
    vi.useRealTimers()
    fireEvent.click(screen.getByRole('button', { name: 'Удалить выбранные расходы: 1' }))
    expect(container.querySelector('.history-selectbar')).toBeNull()
    await waitFor(() => expect(submit).toHaveBeenCalledWith('user-a', 'workspace-a', 'deleteExpense', [expect.objectContaining({ id: 'e0' })]))
    expect(await screen.findByText('Удалено расходов: 1')).not.toBeNull()
    await waitFor(() => expect(slot(container)!.getAttribute('style')).toBe(''))
  })
})

