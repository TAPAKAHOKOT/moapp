// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDragOrder, useFlip } from './ui'

// Раскладка без браузера: у каждого элемента со своим data-drag-id — выдуманная рамка по вертикали.
const rects: Record<string, [number, number]> = { a: [0, 40], b: [50, 130], c: [140, 180], inner1: [60, 70], inner2: [80, 90] }

function List({ onReorder, shown = true }: { onReorder: (ids: string[]) => void; shown?: boolean }) {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const drag = useDragOrder({ items, onReorder })
  if (!shown) return null
  return <div ref={drag.listRef}>{drag.shown.map((item) => <div key={item.id} data-drag-id={item.id} data-testid={`row-${item.id}`} className={drag.lifted === item.id ? 'lifted' : undefined}>
    <span role="button" aria-label={`Перетащить ${item.id}`} {...drag.handle(item.id)}/>
    {/* Внутри блока — свой список со своими перетаскиваемыми элементами, как плитки в блоке «Плитки». */}
    {item.id === 'b' && <div><span data-drag-id="inner1"/><span data-drag-id="inner2"/></div>}
  </div>)}</div>
}

describe('dragging to reorder', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  const layout = () => vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const [top, bottom] = rects[(this as HTMLElement).dataset?.dragId ?? ''] ?? [0, 0]
    return { top, bottom, left: 0, right: 300, width: 300, height: bottom - top, x: 0, y: top, toJSON: () => ({}) } as DOMRect
  })
  const press = (id: string, y: number) => fireEvent.pointerDown(screen.getByRole('button', { name: `Перетащить ${id}` }), { button: 0, clientX: 10, clientY: y, pointerId: 1 })
  const moveTo = (id: string, y: number) => fireEvent.pointerMove(screen.getByRole('button', { name: `Перетащить ${id}` }), { clientX: 10, clientY: y, pointerId: 1 })
  const lift = (id: string) => fireEvent.pointerUp(screen.getByRole('button', { name: `Перетащить ${id}` }), { clientX: 10, pointerId: 1 })

  it('counts only its own rows, not the draggable items inside a row', () => {
    layout()
    const reorder = vi.fn()
    render(<List onReorder={reorder}/>)
    press('a', 10)
    moveTo('a', 150)
    // Во время жеста порядок в DOM прежний: сдвигаются только рамки.
    expect([...document.querySelectorAll(':scope [data-testid]')].map((node) => node.getAttribute('data-testid'))).toEqual(['row-a', 'row-b', 'row-c'])
    expect(screen.getByTestId('row-a').className).toBe('lifted')
    expect(screen.getByTestId('row-b').style.transform).toBe('translate(0px, -50px)')
    lift('a')
    expect(reorder).toHaveBeenCalledWith(['b', 'a', 'c'])
    expect(screen.getByTestId('row-a').style.transform).toBe('')
  })

  it('forgets a drag that was cut off when the list went away, and a plain tap saves nothing', () => {
    layout()
    const reorder = vi.fn()
    const { rerender } = render(<List onReorder={reorder}/>)
    press('a', 10)
    moveTo('a', 150)
    rerender(<List onReorder={reorder} shown={false}/>)
    rerender(<List onReorder={reorder}/>)
    expect(screen.getByTestId('row-a').className).toBe('')
    press('c', 150)
    lift('c')
    expect(reorder).not.toHaveBeenCalled()
  })
})

// Раскладка задана рамками: [left, top, width, height]. Зазоры между элементами — отступы, а gap у списка нулевой, как
// у карточек «Аналитики» (margin-bottom: 16px) — jsdom и не считает gap.
function Spaced({ ids, axis, onReorder }: { ids: string[]; axis?: 'y' | 'grid'; onReorder: (ids: string[]) => void }) {
  const drag = useDragOrder({ items: ids.map((id) => ({ id })), axis, onReorder })
  return <div ref={drag.listRef}>{drag.shown.map((item) => <div key={item.id} data-drag-id={item.id} data-testid={`slot-${item.id}`}>
    <span role="button" aria-label={`Перетащить ${item.id}`} {...drag.handle(item.id)}/>
  </div>)}</div>
}

describe('dragging keeps the real spacing between neighbours', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  const layout = (boxes: Record<string, [number, number, number, number]>) => vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const [left, top, width, height] = boxes[(this as HTMLElement).dataset?.dragId ?? ''] ?? [0, 0, 0, 0]
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect
  })
  const handle = (id: string) => screen.getByRole('button', { name: `Перетащить ${id}` })
  const shift = (id: string) => screen.getByTestId(`slot-${id}`).style.transform

  it('moves a card in a column by its height plus the margin under it, and leaves the rest where they stood', () => {
    // Карточки по 64 px, между ними 16 px отступа.
    layout({ a: [0, 0, 300, 64], b: [0, 80, 300, 64], c: [0, 160, 300, 64], d: [0, 240, 300, 64] })
    const reorder = vi.fn()
    render(<Spaced ids={['a', 'b', 'c', 'd']} onReorder={reorder}/>)
    fireEvent.pointerDown(handle('a'), { button: 0, clientX: 280, clientY: 32, pointerId: 1 })
    // Поднятая карточка ещё на своём месте: соседи не трогаются, промежутки те же 16 px.
    fireEvent.pointerMove(handle('a'), { clientX: 280, clientY: 37, pointerId: 1 })
    expect(['b', 'c', 'd'].map(shift)).toEqual(['translate(0px, 0px)', 'translate(0px, 0px)', 'translate(0px, 0px)'])
    // Протащили за середину второй карточки: она встаёт на место первой — на 64 + 16 px выше, остальные не двигаются.
    fireEvent.pointerMove(handle('a'), { clientX: 280, clientY: 130, pointerId: 1 })
    expect(['b', 'c', 'd'].map(shift)).toEqual(['translate(0px, -80px)', 'translate(0px, 0px)', 'translate(0px, 0px)'])
    fireEvent.pointerMove(handle('a'), { clientX: 280, clientY: 210, pointerId: 1 })
    expect(['b', 'c', 'd'].map(shift)).toEqual(['translate(0px, -80px)', 'translate(0px, -80px)', 'translate(0px, 0px)'])
    fireEvent.pointerUp(handle('a'), { clientX: 280, clientY: 210, pointerId: 1 })
    expect(reorder).toHaveBeenCalledWith(['b', 'c', 'a', 'd'])
  })

  it('keeps the gap within a row and between rows of a grid', () => {
    // Три плитки по 50 px через 10 px, вторая строка — на 12 px ниже первой.
    layout({ a: [0, 0, 50, 30], b: [60, 0, 50, 30], c: [120, 0, 50, 30], d: [0, 42, 50, 30] })
    render(<Spaced ids={['a', 'b', 'c', 'd']} axis="grid" onReorder={vi.fn()}/>)
    fireEvent.pointerDown(handle('d'), { button: 0, clientX: 25, clientY: 57, pointerId: 1 })
    fireEvent.pointerMove(handle('d'), { clientX: 10, clientY: 15, pointerId: 1 })
    // Последняя плитка поставлена первой: две сдвигаются вправо на 50 + 10 px, третья уходит в начало второй строки.
    expect(['a', 'b', 'c'].map(shift)).toEqual(['translate(60px, 0px)', 'translate(60px, 0px)', 'translate(-120px, 42px)'])
  })
})

// Блоки стоят столбиком по 50 px: место элемента — его номер среди соседей.
function Column({ order }: { order: string[] }) {
  const root = useRef<HTMLDivElement>(null)
  useFlip(root, true)
  return <div ref={root}>{order.map((id) => <div key={id} data-flip-id={id} data-testid={`block-${id}`}/>)}</div>
}

describe('smooth rearrangement', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

  it('lets a block that moved glide from where it stood and end exactly in place', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const node = this as HTMLElement
      const top = node.dataset.flipId ? [...node.parentElement!.children].indexOf(node) * 50 : 0
      return { top, bottom: top + 40, left: 0, right: 300, width: 300, height: 40, x: 0, y: top, toJSON: () => ({}) } as DOMRect
    })
    const { rerender } = render(<Column order={['a', 'b', 'c']}/>)
    rerender(<Column order={['b', 'c', 'a']}/>)
    // Сразу после перестановки блоки стоят там, где были, и оттуда едут.
    expect(screen.getByTestId('block-a').style.translate).toBe('0px -100px')
    expect(screen.getByTestId('block-b').style.translate).toBe('0px 50px')
    act(() => { vi.advanceTimersByTime(120) })
    const halfway = Number.parseFloat(screen.getByTestId('block-a').style.translate.split(' ')[1]!)
    expect(halfway).toBeGreaterThan(-100)
    expect(halfway).toBeLessThan(0)
    act(() => { vi.advanceTimersByTime(400) })
    expect(['a', 'b', 'c'].map((id) => screen.getByTestId(`block-${id}`).style.translate)).toEqual(['', '', ''])
  })
})
