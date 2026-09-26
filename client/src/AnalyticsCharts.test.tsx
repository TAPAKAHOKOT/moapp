// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { Chart as ChartJS, LineController } from 'chart.js'
import type { Plugin } from 'chart.js'
import type { CanvasHTMLAttributes, ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AnalyticsChart, { settledLinePadding } from './AnalyticsCharts'

type ChartMockProps = CanvasHTMLAttributes<HTMLCanvasElement> & {
  data?: unknown
  options?: unknown
  plugins?: unknown
  fallbackContent?: ReactNode
}

// Плагины, с которыми рисовался последний график.
const chartPlugins = vi.hoisted(() => ({ last: undefined as unknown }))

vi.mock('react-chartjs-2', () => {
  function ChartMock({ data, options, plugins, fallbackContent, ...canvasProps }: ChartMockProps) {
    void data
    void options
    chartPlugins.last = plugins
    return <canvas {...canvasProps}>{fallbackContent}</canvas>
  }

  return { Bar: ChartMock, Doughnut: ChartMock, Line: ChartMock }
})

afterEach(cleanup)

describe('analytics chart accessibility', () => {
  it('names and describes the line chart and exposes every exact value in a table', () => {
    render(<AnalyticsChart
      kind="line"
      labels={['пн', 'вт']}
      values={[1200, 350]}
      color="#758d69"
      fillColor="#e9ede4"
      pointRadius={3}
      target="RSD"
      textColor="#73776f"
      gridColor="#e3dfd5"
      maxTicksLimit={7}
    />)

    const chart = screen.getByRole('img', { name: 'Динамика расходов в валюте RSD' })
    const description = document.getElementById(chart.getAttribute('aria-describedby') ?? '')
    expect(description?.textContent).toContain('Значения от 350 RSD до 1\u00a0200 RSD')

    const table = screen.getByRole('table', { name: 'Динамика расходов в валюте RSD. Точные значения' })
    expect(within(table).getByRole('row', { name: /пн 1\s200 RSD/ })).not.toBeNull()
    expect(within(table).getByRole('row', { name: 'вт 350 RSD' })).not.toBeNull()
  })

  it('keeps all doughnut categories available even when the visible legend is shortened', () => {
    const labels = ['Продукты', 'Транспорт', 'Дом', 'Здоровье', 'Досуг', 'Другое']
    render(<AnalyticsChart
      kind="doughnut"
      labels={labels}
      values={[100, 200, 300, 400, 500, 600]}
      colors={labels.map(() => '#758d69')}
      target="EUR"
    />)

    expect(screen.getByRole('img', { name: 'Расходы по категориям в валюте EUR' })).not.toBeNull()
    const table = screen.getByRole('table', { name: 'Расходы по категориям в валюте EUR. Точные значения' })
    expect(within(table).getAllByRole('row')).toHaveLength(labels.length + 1)
    expect(within(table).getByRole('row', { name: 'Другое 600 EUR' })).not.toBeNull()
  })

  it('identifies the weekday bar chart and its table columns', () => {
    render(<AnalyticsChart
      kind="bar"
      labels={['Пн', 'Вт']}
      values={[50, 75]}
      color="#758d69"
      target="RSD"
      textColor="#73776f"
      gridColor="#e3dfd5"
    />)

    expect(screen.getByRole('img', { name: 'Средние расходы по дням недели в валюте RSD' })).not.toBeNull()
    const table = screen.getByRole('table')
    expect(within(table).getByRole('columnheader', { name: 'День недели' })).not.toBeNull()
    expect(within(table).getByRole('columnheader', { name: 'Расходы, RSD' })).not.toBeNull()
  })

  it('keeps fractional currency values exact in the accessible table', () => {
    render(<AnalyticsChart
      kind="doughnut"
      labels={['Кафе']}
      values={[12.5]}
      colors={['#758d69']}
      target="EUR"
    />)

    const table = screen.getByRole('table', { name: 'Расходы по категориям в валюте EUR. Точные значения' })
    expect(within(table).getByRole('row', { name: 'Кафе 12,5 EUR' })).not.toBeNull()
  })
})

// Холст с поддельным 2D-контекстом: jsdom не рисует, а раскладке Chart.js нужны только размер холста и ширина текста.
function testCanvas() {
  const canvas = document.createElement('canvas')
  canvas.width = 320
  canvas.height = 150
  const state: Record<PropertyKey, unknown> = { canvas }
  const context = new Proxy(state, {
    get: (target, key) => key in target ? target[key] : key === 'measureText' ? (text: string) => ({ width: text.length * 6 }) : () => undefined,
    set: (target, key, value) => { target[key] = value; return true },
  })
  canvas.getContext = (() => context) as unknown as HTMLCanvasElement['getContext']
  return canvas
}

describe('line chart padding', () => {
  ChartJS.register(LineController)
  const labels = Array.from({ length: 30 }, (_, index) => `${index + 1} сент.`)
  const values = labels.map((_, index) => index * 37 % 11 * 100)
  const charts: ChartJS[] = []
  afterEach(() => { charts.splice(0).forEach((chart) => chart.destroy()) })

  // «Месяц» — линия толщиной 2 без точек, «Неделя» — с точками радиуса 3; маленькая карточка — без осей.
  function lineChart(pointRadius: number, { axes = false, plugins = [] as Plugin<'line'>[] } = {}) {
    const chart = new ChartJS(testCanvas(), {
      type: 'line',
      data: { labels, datasets: [{ data: values, borderWidth: 2, pointRadius, fill: true, tension: .38 }] },
      options: {
        responsive: false,
        animation: false,
        plugins: { legend: { display: false } },
        scales: axes
          ? { x: { grid: { display: false }, ticks: { maxTicksLimit: 6 } }, y: { beginAtZero: true, ticks: { maxTicksLimit: 4 } } }
          : { x: { display: false }, y: { display: false, beginAtZero: true } },
      },
      plugins,
    })
    charts.push(chart)
    return chart
  }
  const area = (chart: ChartJS) => ({ ...chart.chartArea })
  // Раскладка, к которой Chart.js приходит со второго обновления с теми же данными.
  function settledArea(pointRadius: number, axes = false) {
    const chart = lineChart(pointRadius, { axes })
    chart.update()
    return area(chart)
  }

  it('gives the line its half-width margin already in the first layout', () => {
    // Причина: в первом обновлении Chart.js ещё не знает толщину линии и не оставляет под неё поля.
    expect(area(lineChart(0))).toMatchObject({ left: 0, top: 0, right: 320, bottom: 150 })
    expect(settledArea(0)).toMatchObject({ left: 1, top: 1, right: 319, bottom: 149 })

    expect(area(lineChart(0, { plugins: [settledLinePadding] }))).toEqual(settledArea(0))
    expect(area(lineChart(0, { axes: true, plugins: [settledLinePadding] }))).toEqual(settledArea(0, true))
    expect(area(lineChart(3, { axes: true, plugins: [settledLinePadding] }))).toEqual(settledArea(3, true))
  })

  it('does not keep the margin of the previous points after the period changes', () => {
    // Без плагина первое обновление после смены точек берёт поле от прежних точек.
    const plain = lineChart(3, { axes: true })
    plain.update()
    plain.data.datasets[0].pointRadius = 0
    plain.update()
    expect(area(plain)).not.toEqual(settledArea(0, true))

    const chart = lineChart(3, { axes: true, plugins: [settledLinePadding] })
    chart.data.datasets[0].pointRadius = 0
    chart.update()
    expect(area(chart)).toEqual(settledArea(0, true))
    chart.data.datasets[0].pointRadius = 3
    chart.update()
    expect(area(chart)).toEqual(settledArea(3, true))
  })

  it('hands the margin plugin to both analytics lines', () => {
    for (const compact of [false, true]) {
      render(<AnalyticsChart kind="line" compact={compact} labels={['пн']} values={[1]} color="#758d69" fillColor="#e9ede4" pointRadius={0} target="RSD" textColor="#73776f" gridColor="#e3dfd5" maxTicksLimit={6}/>)
      expect(chartPlugins.last).toContain(settledLinePadding)
      cleanup()
    }
  })
})
