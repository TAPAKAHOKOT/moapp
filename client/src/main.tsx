import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { consumeCapabilityFromLocation } from './capability'
import './styles.css'
import './workspace-layout.css'

document.documentElement.dataset.theme = localStorage.getItem('moapp:theme') === 'dark' ? 'dark' : 'light'
// Capability fragments are removed before React, network requests, or service
// worker registration can observe a URL that contains a raw secret.
const capability = consumeCapabilityFromLocation()

createRoot(document.getElementById('root')!).render(<StrictMode><App capability={capability}/></StrictMode>)

if ('serviceWorker' in navigator && import.meta.env.PROD) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js'))
