import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { consumeCapabilityFromLocation } from './capability'
import './styles.css'
import './workspace-layout.css'

// По обычному http (телефон в локальной сети, не localhost) браузер считает контекст небезопасным и не даёт
// crypto.randomUUID, хотя getRandomValues доступен. Без этого ни расход, ни пространство не создать.
if (typeof crypto.randomUUID !== 'function') {
  crypto.randomUUID = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6]! & 0x0f) | 0x40
    bytes[8] = (bytes[8]! & 0x3f) | 0x80
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as `${string}-${string}-${string}-${string}-${string}`
  }
}

type Theme = 'light' | 'dark'

const themeColors: Record<Theme, string> = {
  light: '#f5f2eb',
  dark: '#111212',
}

function syncThemeColor(theme: Theme) {
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
    .forEach((meta) => meta.setAttribute('content', themeColors[theme]))
}

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

// Без явного выбора тема повторяет системную — телефон уже решил это за человека.
const savedTheme = localStorage.getItem('moapp:theme')
document.documentElement.dataset.theme = savedTheme === 'dark' || savedTheme === 'light' ? savedTheme : window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
syncThemeColor(currentTheme())

// App owns the theme preference. Keep the browser/PWA chrome in sync whenever
// that preference changes without coupling the root component to document meta.
new MutationObserver(() => syncThemeColor(currentTheme())).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['data-theme'],
})
// Capability fragments are removed before React, network requests, or service
// worker registration can observe a URL that contains a raw secret.
const capability = consumeCapabilityFromLocation()

createRoot(document.getElementById('root')!).render(<StrictMode><App capability={capability}/></StrictMode>)

if ('serviceWorker' in navigator && import.meta.env.PROD) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js'))
