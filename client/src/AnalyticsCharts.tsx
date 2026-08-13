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

function formatAnalyticsAmount(value: number, currency: string) {
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(value)} ${currency}`
}

function formatCompactNumber(value: number) {
  return new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

export default function AnalyticsChart(props: AnalyticsChartProps) {
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
    return <Line data={{ labels: props.labels, datasets: [{ data: props.values, borderColor: props.color, backgroundColor: props.fillColor, fill: true, tension: .38, pointRadius: props.pointRadius, pointBackgroundColor: props.color, borderWidth: 2 }] }} options={options}/>
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
    return <Doughnut data={{ labels: props.labels, datasets: [{ data: props.values, backgroundColor: props.colors, borderWidth: 0, spacing: 3 }] }} options={options}/>
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
  return <Bar data={{ labels: props.labels, datasets: [{ data: props.values, backgroundColor: props.color, borderRadius: 6, borderSkipped: false }] }} options={options}/>
}
