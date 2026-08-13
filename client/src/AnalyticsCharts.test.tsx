// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import type { CanvasHTMLAttributes, ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AnalyticsChart from './AnalyticsCharts'

type ChartMockProps = CanvasHTMLAttributes<HTMLCanvasElement> & {
  data?: unknown
  options?: unknown
  fallbackContent?: ReactNode
}

vi.mock('react-chartjs-2', () => {
  function ChartMock({ data, options, fallbackContent, ...canvasProps }: ChartMockProps) {
    void data
    void options
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
