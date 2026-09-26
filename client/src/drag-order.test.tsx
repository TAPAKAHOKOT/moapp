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
