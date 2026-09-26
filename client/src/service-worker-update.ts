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
  // Первая установка воркера забирает страницу без контроллера (clients.claim()) — это не обновление, а перезагрузка
  // потеряла бы приглашение, уже вынутое из адреса. Перезагружаемся, когда меняется прежний контроллер или человек
  // сам нажал «Обновить».
  let controlled = Boolean(navigator.serviceWorker.controller)
  let activationRequested = false
  // Ожидающий воркер — обновление, только если есть действующий, которого он сменит: первая установка тоже на миг
  // проходит через waiting, и без перезагрузки кнопка «Обновить» так и осталась бы в шапке.
  const reportWaiting = () => { if (!disposed && registration?.waiting && registration.active) onWaiting() }
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
  const controllerChange = () => {
    const replaced = controlled || activationRequested
    controlled = true
    if (!disposed && replaced) onControllerChange()
  }
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
      activationRequested = true
      worker.postMessage({ type: 'SKIP_WAITING' })
      return true
    },
    dispose() {
      disposed = true
      navigator.serviceWorker.removeEventListener('controllerchange', controllerChange)
    },
  }
}
