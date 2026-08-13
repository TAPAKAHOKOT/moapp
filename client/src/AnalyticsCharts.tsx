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
import type { ChartOptions } from 'chart.js'
import { useId } from 'react'
import { Bar, Doughnut, Line } from 'react-chartjs-2'

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
}

type AnalyticsChartProps = LineChartProps | DoughnutChartProps | BarChartProps

type ChartAccessibility = {
  title: string
  description: string
  dimensionLabel: string
}

function formatAnalyticsAmount(value: number, currency: string) {
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 4 }).format(value)} ${currency}`
}

function formatCompactNumber(value: number) {
  return new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function chartAccessibility(props: AnalyticsChartProps): ChartAccessibility {
  if (props.kind === 'doughnut') {
    const total = props.values.reduce((sum, value) => sum + value, 0)
    return {
      title: `Расходы по категориям в валюте ${props.target}`,
      description: `Кольцевая диаграмма содержит ${props.labels.length} категорий на общую сумму ${formatAnalyticsAmount(total, props.target)}. Точные значения доступны в таблице после графика.`,
      dimensionLabel: 'Категория',
    }
  }

  const values = props.values.length ? props.values : [0]
  const minimum = Math.min(...values)
  const maximum = Math.max(...values)
  const range = minimum === maximum
    ? `Все значения: ${formatAnalyticsAmount(minimum, props.target)}.`
    : `Значения от ${formatAnalyticsAmount(minimum, props.target)} до ${formatAnalyticsAmount(maximum, props.target)}.`

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
      <tbody>{labels.map((label, index) => <tr key={`${label}-${index}`}><th scope="row">{label}</th><td>{formatAnalyticsAmount(values[index] ?? 0, target)}</td></tr>)}</tbody>
    </table>
  </>
}

export default function AnalyticsChart(props: AnalyticsChartProps) {
  const descriptionId = useId()
  const accessibility = chartAccessibility(props)
  const accessibleCanvas = {
    role: 'img',
    'aria-label': accessibility.title,
    'aria-describedby': descriptionId,
    fallbackContent: `${accessibility.title}. ${accessibility.description}`,
  } as const
  const dataAlternative = <ChartDataAlternative
    {...accessibility}
    descriptionId={descriptionId}
    labels={props.labels}
    values={props.values}
    target={props.target}
  />

  if (props.kind === 'line') {
    const options: ChartOptions<'line'> = {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (context) => formatAnalyticsAmount(context.parsed.y ?? 0, props.target) } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: props.maxTicksLimit, color: props.textColor } },
        y: {
          beginAtZero: true,
          border: { display: false },
          grid: { color: props.gridColor },
          ticks: { color: props.textColor, maxTicksLimit: 4, callback: (value) => formatCompactNumber(Number(value)) },
        },
      },
    }
    return <><Line data={{ labels: props.labels, datasets: [{ data: props.values, borderColor: props.color, backgroundColor: props.fillColor, fill: true, tension: .38, pointRadius: props.pointRadius, pointBackgroundColor: props.color, borderWidth: 2 }] }} options={options} {...accessibleCanvas}/>{dataAlternative}</>
  }

  if (props.kind === 'doughnut') {
    const options: ChartOptions<'doughnut'> = {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      cutout: '72%',
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (context) => formatAnalyticsAmount(context.parsed, props.target) } },
      },
    }
    return <><Doughnut data={{ labels: props.labels, datasets: [{ data: props.values, backgroundColor: props.colors, borderWidth: 0, spacing: 3 }] }} options={options} {...accessibleCanvas}/>{dataAlternative}</>
  }

  const options: ChartOptions<'bar'> = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: (context) => formatAnalyticsAmount(context.parsed.y ?? 0, props.target) } },
    },
    scales: {
      x: { grid: { display: false }, ticks: { color: props.textColor } },
      y: {
        beginAtZero: true,
        border: { display: false },
        grid: { color: props.gridColor },
        ticks: { color: props.textColor, maxTicksLimit: 4, callback: (value) => formatCompactNumber(Number(value)) },
      },
    },
  }
  return <><Bar data={{ labels: props.labels, datasets: [{ data: props.values, backgroundColor: props.color, borderRadius: 6, borderSkipped: false }] }} options={options} {...accessibleCanvas}/>{dataAlternative}</>
}
