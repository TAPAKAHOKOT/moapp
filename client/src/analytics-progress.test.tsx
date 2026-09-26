// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnalyticsProgress } from './screens/Analytics'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

// Бег полоски — класс `running` (styles.css): с ним у полоски есть анимация, без него — нет вовсе.
function bar(on: boolean) {
  const view = render(<AnalyticsProgress on={on}/>)
  const node = view.container.querySelector<HTMLElement>('.analytics-progress')!
  return { node, show: (next: boolean) => view.rerender(<AnalyticsProgress on={next}/>) }
}

describe('the loading bar of «Аналитика»', () => {
  it('runs only while it is shown and while it fades, and starts over from the left edge on every show', () => {
    const { node, show } = bar(false)
    expect(node.className).toBe('analytics-progress')

    show(true)
    expect(node.className).toBe('analytics-progress on running')

    // Сняли — полоска ещё гаснет и едет дальше, а не замирает.
    show(false)
    expect(node.className).toBe('analytics-progress running')
    fireEvent.transitionEnd(node, { propertyName: 'opacity' })
    expect(node.className).toBe('analytics-progress')

    // Новый показ — новая анимация, с левого края.
    show(true)
    expect(node.className).toBe('analytics-progress on running')
  })

  it('keeps running without a jump when shown again before it has faded', () => {
    const { node, show } = bar(true)
    show(false)
    show(true)
    // Конец разворота прозрачности к видимой полоске бег не снимает.
    fireEvent.transitionEnd(node, { propertyName: 'opacity' })
    expect(node.className).toBe('analytics-progress on running')
  })

  it('stops by itself when the fade never ran and no transitionend comes', () => {
    vi.useFakeTimers()
    const { node, show } = bar(true)
    show(false)
    expect(node.className).toBe('analytics-progress running')
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(node.className).toBe('analytics-progress')
  })
})
