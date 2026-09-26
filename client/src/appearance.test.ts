import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACCENTS, DEFAULT_APPEARANCE, appearanceOf, applyAppearance, chartColors, clearAppearanceMirror, readAppearanceMirror, writeAppearanceMirror } from './appearance'

function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() { return data.size }, clear: () => data.clear(), getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null, removeItem: (key) => { data.delete(key) }, setItem: (key, value) => { data.set(key, String(value)) },
  }
}

beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()))
afterEach(() => vi.unstubAllGlobals())

describe('appearance', () => {
  it('reads the look from the account and keeps the default for anything not chosen or not known', () => {
    expect(appearanceOf({})).toEqual(DEFAULT_APPEARANCE)
    expect(appearanceOf({ theme: 'dark', accent: 'lilac', textSize: 'large' })).toEqual({ theme: 'dark', accent: 'lilac', textSize: 'large' })
    expect(appearanceOf({ accent: 'crimson' as never, textSize: 'huge' as never })).toEqual(DEFAULT_APPEARANCE)
  })

  it('colours the charts with the person colour, a fill under the line included', () => {
    expect(chartColors('sage', 'light')).toEqual({ line: '#758d69', fill: 'rgba(117,141,105,0.12)' })
    expect(chartColors('sage', 'dark')).toEqual({ line: '#b1cfa3', fill: 'rgba(177,207,163,0.14)' })
    expect(chartColors('blue', 'light').line).toBe(ACCENTS.find((accent) => accent.id === 'blue')!.chart.light)
  })

  it('marks only a chosen colour and a large text on the root, so the default tokens stay untouched', () => {
    const root = { dataset: {} } as HTMLElement
    applyAppearance(root, { accent: 'graphite', textSize: 'large' })
    expect({ ...root.dataset }).toEqual({ accent: 'graphite', textSize: 'large' })
    applyAppearance(root, { accent: 'sage', textSize: 'normal' })
    expect({ ...root.dataset }).toEqual({})
  })

  it('keeps a copy for the first frame only for what differs from the default, and forgets it', () => {
    writeAppearanceMirror({ theme: 'dark', accent: 'sand', textSize: 'normal' })
    expect([localStorage.getItem('moapp:theme'), localStorage.getItem('moapp:accent'), localStorage.getItem('moapp:text-size')]).toEqual(['dark', 'sand', null])
    expect(readAppearanceMirror()).toEqual({ theme: 'dark', accent: 'sand', textSize: 'normal' })
    localStorage.setItem('moapp:accent', 'neon')
    expect(readAppearanceMirror().accent).toBe('sage')
    clearAppearanceMirror()
    expect(readAppearanceMirror()).toEqual(DEFAULT_APPEARANCE)
  })
})
