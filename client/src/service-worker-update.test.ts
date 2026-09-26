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
      active: {} as ServiceWorker,
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

    // Контроллера при старте не было (жёсткая перезагрузка), но «Обновить» нажато — перезагрузка нужна.
    serviceWorker.dispatchEvent(new Event('controllerchange'))
    expect(controllerChange).toHaveBeenCalledTimes(1)
  })

  // Воркер без ожидающего обновления: страница видит только смену контроллера.
  function watch(controller: object | null) {
    const serviceWorker = Object.assign(new EventTarget(), {
      controller,
      ready: new Promise<ServiceWorkerRegistration>(() => {}),
      getRegistration: vi.fn(async () => undefined),
    })
    vi.stubGlobal('navigator', { serviceWorker })
    const controllerChange = vi.fn()
    monitorServiceWorkerUpdates({ onWaiting: vi.fn(), onControllerChange: controllerChange })
    return { controllerChange, takeOver: () => serviceWorker.dispatchEvent(new Event('controllerchange')) }
  }

  it('lets the first worker take over a fresh page without a reload, so an invitation link survives', () => {
    const { controllerChange, takeOver } = watch(null)
    takeOver()
    expect(controllerChange).not.toHaveBeenCalled()

    // Дальше страница уже под воркером: его замена — обновление работающего приложения.
    takeOver()
    expect(controllerChange).toHaveBeenCalledTimes(1)
  })

  it('reloads as before when the worker of a page that started under one is replaced', () => {
    const { controllerChange, takeOver } = watch({})
    takeOver()
    expect(controllerChange).toHaveBeenCalledTimes(1)
  })

  // Вкладка открыта жёсткой перезагрузкой (Cmd+Shift+R): контроллера нет, хотя приложение уже установлено.
  function hardReloaded(waiting: EventTarget | null) {
    const registration = Object.assign(new EventTarget(), {
      installing: null as EventTarget | null,
      waiting,
      active: new EventTarget() as EventTarget | null,
      update: vi.fn(async () => {}),
    })
    const serviceWorker = Object.assign(new EventTarget(), {
      controller: null,
      ready: Promise.resolve(registration as unknown as ServiceWorkerRegistration),
      getRegistration: vi.fn(async () => registration as unknown as ServiceWorkerRegistration),
    })
    vi.stubGlobal('navigator', { serviceWorker })
    const waitingSeen = vi.fn()
    const controllerChange = vi.fn()
    const monitor = monitorServiceWorkerUpdates({ onWaiting: waitingSeen, onControllerChange: controllerChange })
    // Новая версия занимает место действующей (её активировали в другой вкладке), clients.claim() забирает и эту.
    const takeOver = () => {
      registration.active = registration.waiting; registration.waiting = null
      serviceWorker.dispatchEvent(new Event('controllerchange'))
    }
    return { registration, monitor, waitingSeen, controllerChange, takeOver }
  }

  it('reloads a hard-reloaded tab once «Обновить», offered in it too, is pressed in another tab', async () => {
    const { monitor, waitingSeen, controllerChange, takeOver } = hardReloaded(new EventTarget())
    await monitor.checkForUpdate()
    expect(waitingSeen).toHaveBeenCalled()

    takeOver()
    expect(controllerChange).toHaveBeenCalledTimes(1)
  })

  it('reloads a hard-reloaded tab when an update that arrived later is activated in another tab', async () => {
    const { registration, monitor, waitingSeen, controllerChange, takeOver } = hardReloaded(null)
    await monitor.checkForUpdate()
    expect(waitingSeen).not.toHaveBeenCalled()

    const next = new EventTarget()
    registration.installing = next
    registration.dispatchEvent(new Event('updatefound'))
    registration.installing = null; registration.waiting = next
    next.dispatchEvent(new Event('statechange'))
    expect(waitingSeen).toHaveBeenCalled()

    takeOver()
    expect(controllerChange).toHaveBeenCalledTimes(1)
  })

  it('does not offer «Обновить» for the first install, which passes through waiting on its way to active', async () => {
    const registration = Object.assign(new EventTarget(), {
      installing: null as EventTarget | null,
      waiting: null as EventTarget | null,
      active: null as EventTarget | null,
      update: vi.fn(async () => {}),
    })
    const serviceWorker = Object.assign(new EventTarget(), {
      controller: null,
      ready: new Promise<ServiceWorkerRegistration>(() => {}),
      getRegistration: vi.fn(async () => registration as unknown as ServiceWorkerRegistration),
    })
    vi.stubGlobal('navigator', { serviceWorker })
    const waiting = vi.fn()
    const controllerChange = vi.fn()
    const monitor = monitorServiceWorkerUpdates({ onWaiting: waiting, onControllerChange: controllerChange })
    await monitor.checkForUpdate()
    const install = (worker: EventTarget) => {
      registration.installing = worker
      registration.dispatchEvent(new Event('updatefound'))
      registration.installing = null; registration.waiting = worker
      worker.dispatchEvent(new Event('statechange'))
    }

    // Первая установка: installing → waiting → active, затем clients.claim() забирает страницу.
    const first = new EventTarget()
    install(first)
    registration.waiting = null; registration.active = first
    first.dispatchEvent(new Event('statechange'))
    serviceWorker.dispatchEvent(new Event('controllerchange'))
    expect(waiting).not.toHaveBeenCalled()
    expect(controllerChange).not.toHaveBeenCalled()

    // Следующая версия ждёт при действующей — это обновление.
    install(new EventTarget())
    expect(waiting).toHaveBeenCalledTimes(1)
  })
})
