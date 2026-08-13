import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { consumeCapabilityFromLocation } from './capability'
import './styles.css'
import './workspace-layout.css'

type Theme = 'light' | 'dark'

const themeColors: Record<Theme, string> = {
  light: '#f5f2eb',
  dark: '#181b18',
}

function syncThemeColor(theme: Theme) {
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
    .forEach((meta) => meta.setAttribute('content', themeColors[theme]))
}

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

document.documentElement.dataset.theme = localStorage.getItem('moapp:theme') === 'dark' ? 'dark' : 'light'
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
