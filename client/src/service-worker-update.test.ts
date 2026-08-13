import { beforeEach, describe, expect, it, vi } from 'vitest'
import { monitorServiceWorkerUpdates } from './service-worker-update'

describe('service worker update monitor', () => {
  beforeEach(() => vi.unstubAllGlobals())

  it('finds a waiting update before a cutover response and activates it only by message', async () => {
    const worker = { postMessage: vi.fn() }
    const installing = new EventTarget()
    const registration = Object.assign(new EventTarget(), {
      waiting: null as ServiceWorker | null,
      installing: installing as unknown as ServiceWorker,
      update: vi.fn(async () => {}),
    }) as unknown as ServiceWorkerRegistration
    const serviceWorker = Object.assign(new EventTarget(), {
      ready: Promise.resolve(registration),
      getRegistration: vi.fn(async () => registration),
    })
    vi.stubGlobal('navigator', { serviceWorker })
    const waiting = vi.fn()
    const controllerChange = vi.fn()

    const monitor = monitorServiceWorkerUpdates({ onWaiting: waiting, onControllerChange: controllerChange })
    await monitor.checkForUpdate()
    registration.dispatchEvent(new Event('updatefound'))
    ;(registration as unknown as { waiting: ServiceWorker }).waiting = worker as unknown as ServiceWorker
    installing.dispatchEvent(new Event('statechange'))
    expect(waiting).toHaveBeenCalled()
    expect(monitor.activateWaiting()).toBe(true)
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })

    serviceWorker.dispatchEvent(new Event('controllerchange'))
    expect(controllerChange).toHaveBeenCalledTimes(1)
  })
})
