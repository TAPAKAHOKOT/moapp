// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EntryView } from './screens/Entry'
import { ExtrasRow } from './tags'
import type { BlockLayout, Expense, Tag, WorkspaceBootstrap } from './types'
import { useOverflowHint } from './ui'

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true })
})

function bootstrapWith(expenses: Expense[], overrides: Partial<WorkspaceBootstrap> = {}): WorkspaceBootstrap {
  const workspace = { id: 'workspace-a', name: 'Дом', role: 'owner' as const, version: 1, joinedAt: '2026-08-01T00:00:00.000Z' }
  return {
    workspaceId: workspace.id,
    workspace,
    categories: [{ id: 'products', name: 'Продукты', color: '#758d69', placement: 'main', sortOrder: 0, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', archivedAt: null, version: 1 }],
    currencies: [{ code: 'RSD', name: 'Сербский динар', symbol: 'дин.', decimals: 2 }],
    rates: { base: 'RSD', date: '2026-08-10', ratesToRsd: { RSD: 1 } },
    tags: [],
    expenses,
    defaultAnalyticsCurrency: 'RSD',
    serverTime: '2026-08-10T14:00:00.000Z',
    ...overrides,
  }
}

// Время и теги записи читает всякий, кто перебирает расходы: по числу чтений видно, пересчитывал ли кто-то весь список.
function countedExpenses(count: number, reads: { occurredAt: number; tagIds: number }) {
  return Array.from({ length: count }, (_, index) => {
    const at = new Date(Date.now() - index * 3_600_000).toISOString()
    const expense = { id: `e${index}`, amountMinor: 1_000, currency: 'RSD', categoryId: 'products', note: null, createdAt: at, updatedAt: at, version: 1, deletedAt: null }
    Object.defineProperty(expense, 'occurredAt', { enumerable: true, get: () => { reads.occurredAt += 1; return at } })
    Object.defineProperty(expense, 'tagIds', { enumerable: true, get: () => { reads.tagIds += 1; return [] } })
    return expense as Expense
  })
}

const stable = { userId: 'user-a', workspaceId: 'workspace-a', setBootstrap: vi.fn(), setCurrentId: vi.fn(), refreshPending: vi.fn(), onDraftDirtyChange: vi.fn(), onEditScreen: vi.fn(), onScreensChange: vi.fn() }

function entry(bootstrap: WorkspaceBootstrap, blocks: BlockLayout) {
  return <EntryView {...stable} workspace={bootstrap.workspace} bootstrap={bootstrap} currentId={null} active blocks={blocks}/>
}

describe('«Сегодня» and «Как обычно» on «Расход»', () => {
  it('does not recount «Сегодня» over every expense on a keypad press', () => {
    const reads = { occurredAt: 0, tagIds: 0 }
    const { container } = render(entry(bootstrapWith(countedExpenses(40, reads)), { shown: ['today', 'keypad', 'tiles', 'note', 'tags'], hidden: ['usual'] }))
    expect(container.querySelector('.entry-today')?.textContent).toMatch(/^Сегодня\d/)
    reads.occurredAt = 0
    fireEvent.click(screen.getByRole('button', { name: '7' }))
    fireEvent.click(screen.getByRole('button', { name: '5' }))
    expect(container.querySelector('.entry-card:not(.aside) .amount-value')?.textContent).toBe('75')
    expect(reads.occurredAt).toBeLessThan(5)
  })

  it('shows the same «Сегодня» in the swipe preview without counting it again', () => {
    const reads = { occurredAt: 0, tagIds: 0 }
    const { container } = render(entry(bootstrapWith(countedExpenses(40, reads)), { shown: ['keypad', 'tiles', 'today', 'note', 'tags'], hidden: ['usual'] }))
    reads.occurredAt = 0
    const section = screen.getByRole('region', { name: 'Ввод суммы' })
    fireEvent.pointerDown(section, { pointerType: 'mouse', button: 0, clientX: 100, clientY: 20 })
    fireEvent.pointerMove(section, { pointerType: 'mouse', clientX: 180, clientY: 20 })
    const live = container.querySelector('.entry-lower-live .entry-today')
    const preview = container.querySelector('.entry-lower-preview .entry-today')
    expect(preview?.textContent).toMatch(/^Сегодня\d/)
    expect(preview?.textContent).toBe(live?.textContent)
    expect(reads.occurredAt).toBeLessThan(5)
  })

  it('works out «Как обычно» only while the block is on the screen', () => {
    const reads = { occurredAt: 0, tagIds: 0 }
    const expenses = countedExpenses(40, reads)
    const off = { shown: ['keypad', 'tiles', 'note', 'tags'], hidden: ['today', 'usual'] }
    const { container, rerender } = render(entry(bootstrapWith(expenses), off))
    rerender(entry(bootstrapWith([...expenses]), off))
    expect(reads.tagIds).toBeLessThan(5)
    rerender(entry(bootstrapWith([...expenses]), { shown: ['usual', 'keypad', 'tiles', 'note', 'tags'], hidden: ['today'] }))
    expect(reads.tagIds).toBeGreaterThanOrEqual(40)
    expect(container.querySelector('.entry-usual')?.textContent).toBe('10Продукты')
  })
})

describe('«Расход» and redraws of the app', () => {
  const blocks = { shown: ['keypad', 'tiles', 'note', 'tags'], hidden: ['today', 'usual'] }

  // Приложение перерисовывается по своим поводам (тосты, очередь отправки, связь); «Расход» с теми же данными — нет.
  it('is not redrawn when the app redraws with the same props', () => {
    let reads = 0
    const bootstrap = bootstrapWith([])
    const [products] = bootstrap.categories
    const counted = { ...bootstrap, categories: [{ ...products!, get name() { reads += 1; return 'Продукты' } }] }
    function Host() {
      const [tick, setTick] = useState(0)
      return <><button type="button" onClick={() => setTick((value) => value + 1)}>{`tick ${tick}`}</button>{entry(counted, blocks)}</>
    }
    render(<Host/>)
    reads = 0
    fireEvent.click(screen.getByRole('button', { name: 'tick 0' }))
    expect(screen.getByRole('button', { name: 'tick 1' })).not.toBeNull()
    expect(reads).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: '7' }))
    expect(reads).toBeGreaterThan(0)
  })

  it('tells the tag sheet about a lost connection without a redraw from the app', () => {
    render(entry(bootstrapWith([]), blocks))
    fireEvent.click(screen.getByRole('button', { name: 'Добавить тег' }))
    fireEvent.change(screen.getByLabelText('Поиск тега'), { target: { value: 'кофе' } })
    expect(screen.getByRole('button', { name: 'Создать тег «кофе»' }).hasAttribute('disabled')).toBe(false)
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false })
    act(() => { window.dispatchEvent(new Event('offline')) })
    expect(screen.getByRole('button', { name: 'Создать тег «кофе»' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('Новые теги создаются только онлайн.')).not.toBeNull()
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true })
    act(() => { window.dispatchEvent(new Event('online')) })
    expect(screen.getByRole('button', { name: 'Создать тег «кофе»' }).hasAttribute('disabled')).toBe(false)
  })
})

// В jsdom нет раскладки: полоса шириной 300 px, каждый чип в ней — 100 px. Чтения scrollWidth считаются: по ним
// видно, читал ли кто-то раскладку после рендера.
const layout = { box: 300, reads: 0 }
function fakeLayout() {
  layout.box = 300
  layout.reads = 0
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return layout.box } })
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get(this: HTMLElement) { layout.reads += 1; return Math.max(layout.box, this.childElementCount * 100) } })
}
function realLayout() {
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
  delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth
}

// ResizeObserver, который помнит, за кем следит, и даёт вызвать себя вручную.
class FakeResizeObserver {
  static observed: Element[] = []
  static all: FakeResizeObserver[] = []
  targets = new Set<Element>()
  constructor(readonly callback: () => void) { FakeResizeObserver.all.push(this) }
  observe(target: Element) { this.targets.add(target); FakeResizeObserver.observed.push(target) }
  unobserve(target: Element) { this.targets.delete(target) }
  disconnect() { this.targets.clear() }
  static resize(target: Element) { for (const observer of FakeResizeObserver.all) if (observer.targets.has(target)) observer.callback() }
}
function fakeResizeObserver() {
  FakeResizeObserver.observed = []
  FakeResizeObserver.all = []
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
}

describe('layout reads of the tag and chip strips', () => {
  afterEach(realLayout)

  const tags: Tag[] = Array.from({ length: 8 }, (_, index) => ({ id: `t${index}`, name: `тег ${index}`, color: null, sortOrder: index, version: 1, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' }))
  const order = { shown: ['t0', 't1'], more: ['t2', 't3', 't4', 't5', 't6', 't7'] }
  const noop = () => {}
  const row = (props: Partial<React.ComponentProps<typeof ExtrasRow>> = {}) => <ExtrasRow tags={tags} order={order} selected={[]} note="" onChange={noop} onNote={noop} {...props}/>

  it('switches the pan and the fading edge of the tag row when chips start and stop overflowing it', () => {
    fakeLayout()
    fakeResizeObserver()
    const selected = ['t5']
    const { container, rerender } = render(row())
    const strip = container.querySelector<HTMLElement>('.tag-strip')!
    const extras = container.querySelector('.extras-row')!
    // Два чипа и «Ещё 6» помещаются.
    expect(strip.style.touchAction).toBe('pan-y')
    expect(extras.classList.contains('more')).toBe(false)
    // Выбранный тег из «Ещё» встаёт в ряд — чипы переполняют полосу.
    rerender(row({ selected }))
    expect(strip.style.touchAction).toBe('pan-x')
    expect(extras.classList.contains('more')).toBe(true)
    // Полосу долистали до конца: край больше не затухает, а пан остаётся.
    Object.defineProperty(strip, 'scrollLeft', { configurable: true, value: 100 })
    fireEvent.scroll(strip)
    expect(extras.classList.contains('more')).toBe(false)
    expect(strip.style.touchAction).toBe('pan-x')
    Object.defineProperty(strip, 'scrollLeft', { configurable: true, value: 0 })
    fireEvent.scroll(strip)
    expect(extras.classList.contains('more')).toBe(true)
    // Полоса стала шире — всё снова помещается.
    layout.box = 500
    act(() => FakeResizeObserver.resize(strip))
    expect(strip.style.touchAction).toBe('pan-y')
    expect(extras.classList.contains('more')).toBe(false)
    layout.box = 300
    act(() => FakeResizeObserver.resize(strip))
    expect(extras.classList.contains('more')).toBe(true)
    // Выбор сняли — тег вернулся за «Ещё».
    rerender(row({ selected: [] }))
    expect(strip.style.touchAction).toBe('pan-y')
    expect(extras.classList.contains('more')).toBe(false)
    // Один ResizeObserver на всю жизнь полосы.
    expect(FakeResizeObserver.observed.filter((node) => node === strip)).toHaveLength(1)
  })

  it('reads the layout of the tag row only when what it shows changes', () => {
    fakeLayout()
    const selected: string[] = []
    const { rerender } = render(row({ selected }))
    layout.reads = 0
    rerender(row({ selected, disabled: true }))
    rerender(row({ selected, disabled: false }))
    expect(layout.reads).toBe(0)
    rerender(row({ selected, note: 'IKEA' }))
    expect(layout.reads).toBeGreaterThan(0)
    layout.reads = 0
    rerender(row({ selected, note: 'IKEA', showNote: false }))
    expect(layout.reads).toBeGreaterThan(0)
  })

  // Так полосу чипов меряет «История».
  function Chips({ labels, strip = 'a' }: { labels: string[]; strip?: string }) {
    const ref = useRef<HTMLDivElement>(null)
    const more = useOverflowHint(ref)
    return <div className={`history-chips${more ? ' more' : ''}`}><div key={strip} ref={ref} className="history-chip-strip">{labels.map((label) => <button key={label} type="button">{label}</button>)}</div></div>
  }

  it('fades the edge of the history chips as before but reads the layout only when the chips change', () => {
    fakeLayout()
    fakeResizeObserver()
    const { container, rerender } = render(<Chips labels={['Даты', 'Категория']}/>)
    const chips = () => container.querySelector('.history-chips')!
    expect(chips().classList.contains('more')).toBe(false)
    layout.reads = 0
    rerender(<Chips labels={['Даты', 'Категория']}/>)
    expect(layout.reads).toBe(0)
    rerender(<Chips labels={['Даты', 'Категория', 'Валюта', 'Тег']}/>)
    expect(chips().classList.contains('more')).toBe(true)
    // Подпись сменилась при том же числе чипов — полосу меряют заново.
    layout.reads = 0
    rerender(<Chips labels={['Сегодня', 'Категория', 'Валюта', 'Тег']}/>)
    expect(layout.reads).toBeGreaterThan(0)
    const strip = container.querySelector<HTMLElement>('.history-chip-strip')!
    Object.defineProperty(strip, 'scrollLeft', { configurable: true, value: 100 })
    fireEvent.scroll(strip)
    expect(chips().classList.contains('more')).toBe(false)
    layout.box = 250
    act(() => FakeResizeObserver.resize(strip))
    expect(chips().classList.contains('more')).toBe(true)
    expect(FakeResizeObserver.observed.filter((node) => node === strip)).toHaveLength(1)
    // Полосу нарисовали заново другим элементом: за ним и следят, а за прежним — нет.
    layout.box = 300
    rerender(<Chips labels={['Сегодня', 'Категория', 'Валюта', 'Тег']} strip="b"/>)
    const next = container.querySelector<HTMLElement>('.history-chip-strip')!
    expect(next).not.toBe(strip)
    expect(chips().classList.contains('more')).toBe(true)
    expect(FakeResizeObserver.all.filter((observer) => observer.targets.has(strip))).toHaveLength(0)
    expect(FakeResizeObserver.all.filter((observer) => observer.targets.has(next))).toHaveLength(1)
    rerender(<Chips labels={['Даты']} strip="b"/>)
    expect(chips().classList.contains('more')).toBe(false)
  })
})
