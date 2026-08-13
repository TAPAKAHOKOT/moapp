// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as accessFlow from './access-flow'
import { CapabilityScreen, CreateWorkspaceSheet, RecoverySave, WorkspaceSwitcher } from './App'
import * as workspaceApi from './workspace-api'
import type { AuthenticatedSession } from './types'

const prepared = {
  recoveryUrl: `https://example.test/#/recover/${'a'.repeat(43)}`,
  completionToken: 'complete',
  expiresAt: '2030-01-01T00:00:00.000Z',
  nextGeneration: 1,
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true })
})

describe('workspace onboarding controls', () => {
  it('requires a guest display name before creation', async () => {
    const create = vi.fn().mockResolvedValue(undefined)
    render(<CreateWorkspaceSheet existing={false} onClose={vi.fn()} onCreate={create}/>)
    fireEvent.change(screen.getByLabelText('Как вас называть'), { target: { value: 'Аня' } })
    fireEvent.change(screen.getByLabelText('Название пространства'), { target: { value: 'Дом' } })
    fireEvent.submit(screen.getByRole('button', { name: 'Создать пространство' }).closest('form')!)
    expect(create).toHaveBeenCalledWith(expect.any(String), 'Дом', 'Аня')
  })

  it('keeps the workspace UUID when the create sheet is submitted again', async () => {
    const create = vi.fn().mockResolvedValue(undefined)
    render(<CreateWorkspaceSheet existing onClose={vi.fn()} onCreate={create}/>)
    fireEvent.change(screen.getByLabelText('Название пространства'), { target: { value: 'Дом' } })

    fireEvent.click(screen.getByRole('button', { name: 'Создать пространство' }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Создать пространство' }) as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(screen.getByRole('button', { name: 'Создать пространство' }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
    expect(create.mock.calls[1][0]).toBe(create.mock.calls[0][0])
  })

  it('does not offer uncached workspaces while offline', () => {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false })
    const select = vi.fn()
    render(<WorkspaceSwitcher active="a" onCreate={vi.fn()} onSelect={select} runtimes={{ a: { workspaceId: 'a', bootstrap: {} as never, source: 'cache', status: 'ready', offline: true, outbox: { total: 0, conflicts: 0, failed: 0 }, requestEpoch: 0 } }} items={[{ id: 'a', name: 'A', role: 'owner', version: 1, joinedAt: '' }, { id: 'b', name: 'B', role: 'member', version: 1, joinedAt: '' }]}/>)
    expect((screen.getByRole('button', { name: /B/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows pending changes and allows switching to a cached workspace offline', () => {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false })
    const select = vi.fn()
    render(<WorkspaceSwitcher
      active="a"
      onCreate={vi.fn()}
      onSelect={select}
      items={[
        { id: 'a', name: 'A', role: 'owner', version: 1, joinedAt: '' },
        { id: 'b', name: 'Кэш', role: 'member', version: 1, joinedAt: '' },
      ]}
      runtimes={{
        a: { workspaceId: 'a', bootstrap: {} as never, source: 'cache', status: 'ready', offline: true, outbox: { total: 0, conflicts: 0, failed: 0 }, requestEpoch: 0 },
        b: { workspaceId: 'b', bootstrap: {} as never, source: 'cache', status: 'ready', offline: true, outbox: { total: 3, conflicts: 1, failed: 0 }, requestEpoch: 0 },
      }}
    />)

    const cached = screen.getByRole('button', { name: /Кэш/ })
    expect((cached as HTMLButtonElement).disabled).toBe(false)
    expect(cached.textContent).toContain('Участник · 3')
    fireEvent.click(cached)
    expect(select).toHaveBeenCalledWith('b')
  })

  it('requires recovery-save acknowledgement and supports blocking mode', () => {
    const complete = vi.fn().mockResolvedValue(undefined)
    render(<RecoverySave prepared={prepared} complete={complete} close={vi.fn()} allowLater={false}/>)
    expect(screen.queryByRole('button', { name: 'Позже' })).toBeNull()
    expect((screen.getByRole('button', { name: 'Завершить' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    expect((screen.getByRole('button', { name: 'Завершить' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('explains the difference between initial, rotating and public recovery links', () => {
    const complete = vi.fn().mockResolvedValue(undefined)
    const initial = render(<RecoverySave prepared={prepared} complete={complete} close={vi.fn()} mode="initial"/>)
    expect(screen.getByText(/показать эту ссылку снова будет нельзя/i)).not.toBeNull()
    initial.unmount()

    const rotation = render(<RecoverySave prepared={prepared} complete={complete} close={vi.fn()} mode="rotation"/>)
    expect(screen.getByText(/старая ссылка сразу перестанет работать/i)).not.toBeNull()
    rotation.unmount()

    render(<RecoverySave prepared={prepared} complete={complete} close={vi.fn()} mode="public"/>)
    expect(screen.getByText(/все прежние устройства будут отключены/i)).not.toBeNull()
  })

  it('keeps the recovery link visible after an error and shows the success reminder after completion', async () => {
    const complete = vi.fn()
      .mockRejectedValueOnce(new Error('Связь прервалась'))
      .mockResolvedValueOnce(undefined)
    const close = vi.fn()
    render(<RecoverySave prepared={prepared} complete={complete} close={close} mode="rotation" allowLater={false}/>)

    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Завершить' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Связь прервалась')
    expect(screen.getByText(prepared.recoveryUrl)).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Завершить' }))
    expect(await screen.findByRole('heading', { name: 'Новая ссылка сохранена' })).not.toBeNull()
    expect(screen.getByText(/предыдущая ссылка больше не работает/i)).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Готово' }))
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('retries a transient capability action with the same in-memory token and attempt', async () => {
    const token = 'A'.repeat(43)
    const accepted: AuthenticatedSession = {
      authenticated: true,
      user: { id: 'user-a', displayName: 'Аня', recoveryConfigured: true, recoveryGeneration: 1 },
      currentSessionId: 'session-a',
      currentSessionExpiresAt: '2030-01-01T00:00:00.000Z',
      serverTime: '2026-01-01T00:00:00.000Z',
      restrictedToRecovery: false,
      workspaces: [],
      legacyWorkspaceId: null,
    }
    vi.spyOn(workspaceApi, 'previewDeviceLink').mockResolvedValue({
      kind: 'device', targetUserId: 'user-a', displayName: 'Аня', expiresAt: '2030-01-01T00:00:00.000Z',
    })
    const accept = vi.spyOn(accessFlow, 'acceptDeviceWithProbe')
      .mockRejectedValueOnce(new Error('Временная ошибка сети'))
      .mockResolvedValueOnce(accepted)
    const finish = vi.fn().mockResolvedValue(undefined)

    render(<CapabilityScreen
      intent={{ kind: 'device', token }}
      session={null}
      knownUserId={null}
      finish={finish}
      close={vi.fn()}
      resolveIdentityConflict={vi.fn()}
    />)

    const connect = await screen.findByRole('button', { name: 'Подключить' })
    await waitFor(() => expect((connect as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(connect)
    expect(await screen.findByText('Временная ошибка сети')).not.toBeNull()
    expect((connect as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(connect)
    await waitFor(() => expect(finish).toHaveBeenCalledWith(accepted))
    expect(accept).toHaveBeenCalledTimes(2)
    expect(accept.mock.calls[1]?.[0]).toBe(token)
    expect(accept.mock.calls[1]?.[1]).toBe(accept.mock.calls[0]?.[1])
  })

  it('turns an action-time identity mismatch into the explicit logout flow', async () => {
    vi.spyOn(workspaceApi, 'previewDeviceLink').mockResolvedValue({
      kind: 'device', targetUserId: 'user-a', displayName: 'Аня', expiresAt: '2030-01-01T00:00:00.000Z',
    })
    vi.spyOn(accessFlow, 'acceptDeviceWithProbe').mockRejectedValue(
      new accessFlow.AccessFlowError('IDENTITY_CONFLICT', 'Эта ссылка предназначена для другого профиля'),
    )

    render(<CapabilityScreen
      intent={{ kind: 'device', token: 'A'.repeat(43) }}
      session={null}
      knownUserId={null}
      finish={vi.fn()}
      close={vi.fn()}
      resolveIdentityConflict={vi.fn()}
    />)

    const connect = await screen.findByRole('button', { name: 'Подключить' })
    await waitFor(() => expect((connect as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(connect)

    expect(await screen.findByRole('button', { name: 'Выйти и продолжить' })).not.toBeNull()
    expect(screen.getByText(/ссылка относится к другому профилю/i)).not.toBeNull()
  })
})
