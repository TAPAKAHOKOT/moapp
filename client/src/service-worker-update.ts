export type ServiceWorkerUpdateMonitor = {
  checkForUpdate: () => Promise<void>
  activateWaiting: () => boolean
  dispose: () => void
}

type Options = {
  onWaiting: () => void
  onControllerChange: () => void
}

const noopMonitor: ServiceWorkerUpdateMonitor = {
  checkForUpdate: async () => {}, activateWaiting: () => false, dispose: () => {},
}

/** Observe a waiting worker without activating it until the user explicitly asks. */
export function monitorServiceWorkerUpdates({ onWaiting, onControllerChange }: Options): ServiceWorkerUpdateMonitor {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return noopMonitor

  let registration: ServiceWorkerRegistration | undefined
  let disposed = false
  const reportWaiting = () => { if (!disposed && registration?.waiting) onWaiting() }
  const observe = (next: ServiceWorkerRegistration) => {
    registration = next
    next.addEventListener('updatefound', () => {
      const installing = next.installing
      installing?.addEventListener('statechange', reportWaiting)
      reportWaiting()
    })
    reportWaiting()
    return next
  }
  const controllerChange = () => { if (!disposed) onControllerChange() }
  navigator.serviceWorker.addEventListener('controllerchange', controllerChange)
  const ready = navigator.serviceWorker.ready.then(observe).catch(() => undefined)

  return {
    async checkForUpdate() {
      const current = registration ?? await navigator.serviceWorker.getRegistration().catch(() => undefined) ?? await ready
      if (!current) return
      if (current !== registration) observe(current)
      await current.update()
      reportWaiting()
    },
    activateWaiting() {
      const worker = registration?.waiting
      if (!worker) return false
      worker.postMessage({ type: 'SKIP_WAITING' })
      return true
    },
    dispose() {
      disposed = true
      navigator.serviceWorker.removeEventListener('controllerchange', controllerChange)
    },
  }
}
