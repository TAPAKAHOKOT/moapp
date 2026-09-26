import {
  ArcElement,
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
} from 'chart.js'
import type { ChartData, ChartOptions } from 'chart.js'
import { memo, useId, useMemo } from 'react'
import { Bar, Doughnut, Line } from 'react-chartjs-2'
import { cachedNumberFormat } from './utils'

ChartJS.register(ArcElement, BarElement, CategoryScale, Filler, Legend, LinearScale, LineElement, PointElement, Tooltip)

type LineChartProps = {
  kind: 'line'
  labels: string[]
  values: number[]
  color: string
  fillColor: string
  pointRadius: number
  target: string
  textColor: string
  gridColor: string
  maxTicksLimit: number
  /** Маленькая карточка: только линия, без осей. */
  compact?: boolean
}

type DoughnutChartProps = {
  kind: 'doughnut'
  labels: string[]
  values: number[]
  colors: string[]
  target: string
}

type BarChartProps = {
  kind: 'bar'
  labels: string[]
  values: number[]
  color: string
  target: string
  textColor: string
  gridColor: string
  /** Маленькая карточка: столбики и буквы дней, без шкалы. */
  compact?: boolean
}

type AnalyticsChartProps = LineChartProps | DoughnutChartProps | BarChartProps

type ChartAccessibility = {
  title: string
  description: string
  dimensionLabel: string
}

/** Холст графика с названием и описанием для читалки. */
type ChartCanvas = { role: 'img'; 'aria-label': string; 'aria-describedby': string; fallbackContent: string }

/** `reduced` — телефон просит обходиться без анимации. */
type ChartSetup = { canvas: ChartCanvas; reduced: boolean }

function prefersReducedMotion() {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
}

// Переходы между наборами данных анимируются коротко; при prefers-reduced-motion графики меняются мгновенно.
function chartAnimation(reduced: boolean) {
  return reduced ? false as const : { duration: 250 }
}

// Точное значение для таблицы читалки и подсказок; на экране аналитика округляет до целых (format.ts).
// Форматтеры дороги в создании, поэтому один на все числа.
function exactAmount(value: number, currency: string) {
  return `${cachedNumberFormat('ru-RU', { maximumFractionDigits: 4 }).format(value)} ${currency}`
}

function formatCompactNumber(value: number) {
  return cachedNumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function chartAccessibility(props: AnalyticsChartProps): ChartAccessibility {
  if (props.kind === 'doughnut') {
    const total = props.values.reduce((sum, value) => sum + value, 0)
    return {
      title: `Расходы по категориям в валюте ${props.target}`,
      description: `Кольцевая диаграмма содержит ${props.labels.length} категорий на общую сумму ${exactAmount(total, props.target)}. Точные значения доступны в таблице после графика.`,
      dimensionLabel: 'Категория',
    }
  }

  const values = props.values.length ? props.values : [0]
  const minimum = Math.min(...values)
  const maximum = Math.max(...values)
  const range = minimum === maximum
    ? `Все значения: ${exactAmount(minimum, props.target)}.`
    : `Значения от ${exactAmount(minimum, props.target)} до ${exactAmount(maximum, props.target)}.`

  if (props.kind === 'line') {
    return {
      title: `Динамика расходов в валюте ${props.target}`,
      description: `Линейный график содержит ${props.labels.length} значений. ${range} Точные значения доступны в таблице после графика.`,
      dimensionLabel: 'Период',
    }
  }

  return {
    title: `Средние расходы по дням недели в валюте ${props.target}`,
    description: `Столбчатая диаграмма содержит ${props.labels.length} значений. ${range} Точные значения доступны в таблице после графика.`,
    dimensionLabel: 'День недели',
  }
}

function ChartDataAlternative({
  descriptionId,
  title,
  description,
  dimensionLabel,
  labels,
  values,
  target,
}: ChartAccessibility & {
  descriptionId: string
  labels: string[]
  values: number[]
  target: string
}) {
  return <>
    <p id={descriptionId} className="sr-only">{description}</p>
    <table className="sr-only">
      <caption>{title}. Точные значения</caption>
      <thead><tr><th scope="col">{dimensionLabel}</th><th scope="col">Расходы, {target}</th></tr></thead>
      <tbody>{labels.map((label, index) => <tr key={`${label}-${index}`}><th scope="row">{label}</th><td>{exactAmount(values[index] ?? 0, target)}</td></tr>)}</tbody>
    </table>
  </>
}

// Данные и настройки собираются заново только от своих пропсов. Новый объект на каждый рендер обёртка react-chartjs-2
// принимает за новые данные и зовёт chart.update(), а Chart.js на каждый такой вызов заново запускает анимацию.
function LineChart({ labels, values, color, fillColor, pointRadius, target, textColor, gridColor, maxTicksLimit, compact, canvas, reduced }: LineChartProps & ChartSetup) {
  const data = useMemo<ChartData<'line'>>(() => ({ labels, datasets: [{ data: values, borderColor: color, backgroundColor: fillColor, fill: true, tension: .38, pointRadius, pointBackgroundColor: color, borderWidth: 2 }] }), [labels, values, color, fillColor, pointRadius])
  const options = useMemo<ChartOptions<'line'>>(() => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: chartAnimation(reduced),
    // У маленькой линии нет осей, и её единственный отступ — половина толщины линии. Chart.js добавляет его только со
    // второго обновления: в первом толщина ему ещё не известна. Раньше второе обновление приходило от лишних
    // перерисовок экрана, теперь отступ задан сразу — линия стоит там же, где стояла.
    ...(compact ? { layout: { padding: 1 } } : {}),
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: (context) => exactAmount(context.parsed.y ?? 0, target) } },
    },
    scales: compact ? { x: { display: false }, y: { display: false, beginAtZero: true } } : {
      x: { grid: { display: false }, ticks: { maxTicksLimit, color: textColor } },
      y: {
        beginAtZero: true,
        border: { display: false },
        grid: { color: gridColor },
        ticks: { color: textColor, maxTicksLimit: 4, callback: (value) => formatCompactNumber(Number(value)) },
      },
    },
  }), [reduced, target, compact, maxTicksLimit, textColor, gridColor])
  return <Line data={data} options={options} {...canvas}/>
}

function DoughnutChart({ labels, values, colors, target, canvas, reduced }: DoughnutChartProps & ChartSetup) {
  const data = useMemo<ChartData<'doughnut'>>(() => ({ labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 0, spacing: 3 }] }), [labels, values, colors])
  const options = useMemo<ChartOptions<'doughnut'>>(() => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: chartAnimation(reduced),
    cutout: '72%',
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: (context) => exactAmount(context.parsed, target) } },
    },
  }), [reduced, target])
  return <Doughnut data={data} options={options} {...canvas}/>
}

function BarChart({ labels, values, color, target, textColor, gridColor, compact, canvas, reduced }: BarChartProps & ChartSetup) {
  const data = useMemo<ChartData<'bar'>>(() => ({ labels, datasets: [{ data: values, backgroundColor: color, borderRadius: 6, borderSkipped: false }] }), [labels, values, color])
  const options = useMemo<ChartOptions<'bar'>>(() => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: chartAnimation(reduced),
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: (context) => exactAmount(context.parsed.y ?? 0, target) } },
    },
    scales: {
      x: { grid: { display: false }, border: { display: !compact }, ticks: { color: textColor, ...(compact ? { font: { size: 10 }, padding: 0 } : {}) } },
      y: compact ? { display: false, beginAtZero: true } : {
        beginAtZero: true,
        border: { display: false },
        grid: { color: gridColor },
        ticks: { color: textColor, maxTicksLimit: 4, callback: (value) => formatCompactNumber(Number(value)) },
      },
    },
  }), [reduced, target, compact, textColor, gridColor])
  return <Bar data={data} options={options} {...canvas}/>
}

function AnalyticsChart(props: AnalyticsChartProps) {
  const descriptionId = useId()
  const accessibility = chartAccessibility(props)
  const canvas: ChartCanvas = {
    role: 'img',
    'aria-label': accessibility.title,
    'aria-describedby': descriptionId,
    fallbackContent: `${accessibility.title}. ${accessibility.description}`,
  }
  const reduced = prefersReducedMotion()
  const dataAlternative = <ChartDataAlternative
    {...accessibility}
    descriptionId={descriptionId}
    labels={props.labels}
    values={props.values}
    target={props.target}
  />

  if (props.kind === 'line') return <><LineChart {...props} canvas={canvas} reduced={reduced}/>{dataAlternative}</>
  if (props.kind === 'doughnut') return <><DoughnutChart {...props} canvas={canvas} reduced={reduced}/>{dataAlternative}</>
  return <><BarChart {...props} canvas={canvas} reduced={reduced}/>{dataAlternative}</>
}

// Экран аналитики перерисовывается часто и каждый раз собирает подписи и суммы в новые массивы. Массивы поэтому
// сравниваются по значениям, остальное — строго: график рисуется и обновляется от новых чисел, цвета, валюты, а не
// от нового массива с теми же числами.
function sameChart(previous: AnalyticsChartProps, next: AnalyticsChartProps) {
  const before: Record<string, unknown> = previous
  const after: Record<string, unknown> = next
  const keys = Object.keys(after)
  return keys.length === Object.keys(before).length && keys.every((key) => {
    const left = before[key]
    const right = after[key]
    return Array.isArray(left) && Array.isArray(right)
      ? left.length === right.length && left.every((item, index) => Object.is(item, right[index]))
      : Object.is(left, right)
  })
}

export default memo(AnalyticsChart, sameChart)
