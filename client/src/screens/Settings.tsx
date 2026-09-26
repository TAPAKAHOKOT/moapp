import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { WorkspaceApiError as ApiError, changeWorkspaceCurrency, createCategory, createDeviceLink, createInvitation, createTag, deleteTag, getSession, leaveWorkspace, listInvitations, listMembers, listSessions, prepareInitialOrManualRecovery, removeMember, renameWorkspace, revokeInvitation, revokeSession, saveMemberSettings, transferOwnership, updateCategory, updateProfile, updateTag } from '../workspace-api'
import { clearWorkspaceOfflineData } from '../workspace-offline'
import { patchSettings } from '../settings'
import type { SettingsPatch } from '../settings'
import { ACCENTS, DEFAULT_APPEARANCE, TEXT_SIZES, accentInfo } from '../appearance'
import type { Appearance } from '../appearance'
import { completeRotationSafely } from '../recovery-flow'
import type { AccountSettings, AuthenticatedSession, Category, Expense, RecoveryPrepareResponse, SessionState, Tag, ThemePreference, WorkspaceMod, WorkspaceSummary } from '../types'
import { PINNED_CURRENCIES, lastEmoji, localDateKey, workspaceCurrency } from '../utils'
import { buildHistoryCsv } from '../history'
import { CategoryMark, ChevronIcon, CurrencySheet, ListSheet, TextSheet, Toast, copyText, tap, useConfirm, useDialog, useToast } from '../ui'
import type { SelectOption } from '../ui'
import { formatLinkLifetime, formatRelativeTime } from '../format'
import type { Bootstrap } from '../format'
import { TAG_COLORS, TAG_COLOR_NAMES, TagEditor } from '../tags'
import { ROOMY_TILES, categoryLayout, moveToMore, moveToShown, reorderGroup, tagLayout, toScreenOrder } from '../screen-order'
import type { Layout } from '../screen-order'
import { BLOCK_SCREENS, SCREENS, blocksOf, hiddenBlockCount, hideBlock, reorderBlocks, showBlock, toBlockLayout } from '../screen-blocks'
import type { BlockInfo, BlockScreen, Blocks } from '../screen-blocks'
import { RecoverySave } from './Access'

// Ссылка приглашения или подключения: на телефоне главное действие — «Поделиться», сам URL человеку читать не нужно
// и он показывается только если ни копирование, ни системное меню недоступны.
export function AccessLinkSheet({ link, onClose, onRevoke }: { link: { title: string; url: string; expiresAt?: string; hint?: string; revoke?: () => Promise<void> }; onClose: () => void; onRevoke: (reason: unknown) => void }) {
  const dialogRef = useDialog(onClose)
  const { confirm, confirmation } = useConfirm()
  const [feedback, setFeedback] = useState('')
  const [feedbackError, setFeedbackError] = useState(false)
  const [busy, setBusy] = useState(false)
  const canShare = typeof navigator.share === 'function'
  const copy = async () => {
    try { await copyText(link.url); setFeedbackError(false); setFeedback('Ссылка скопирована') }
    catch (reason) { setFeedbackError(true); setFeedback(reason instanceof Error ? reason.message : 'Не удалось скопировать ссылку') }
  }
  const share = async () => {
    try {
      if (canShare) { await navigator.share({ title: link.title, url: link.url }); setFeedbackError(false); setFeedback('Меню «Поделиться» открыто') }
      else await copy()
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') return
      setFeedbackError(true); setFeedback('Не удалось поделиться ссылкой')
    }
  }
  const revoke = async () => {
    if (!link.revoke || busy) return
    if (!await confirm({ title: 'Отозвать ссылку?', message: 'Ссылка сразу перестанет работать.', confirmLabel: 'Отозвать', danger: true })) return
    setBusy(true)
    try { await link.revoke() }
    catch (reason) { onRevoke(reason); setBusy(false) }
  }
  return <div className="sheet-backdrop" onMouseDown={onClose}><section ref={dialogRef} className="bottom-sheet access-sheet" role="dialog" aria-modal="true" aria-labelledby="access-link-title" onMouseDown={(event) => event.stopPropagation()}>
    <div className="sheet-handle"/><div className="sheet-title"><h2 id="access-link-title">{link.title}</h2><button type="button" className="icon-button" data-dialog-initial-focus onClick={onClose} aria-label="Закрыть">×</button></div>
    {link.hint && <p className="sheet-copy">{link.hint}</p>}
    <div className="qr"><QRCodeSVG value={link.url} size={160}/></div>
    {link.expiresAt && <p className="sheet-copy centered">{formatLinkLifetime(link.expiresAt)}</p>}
    {feedbackError && <code className="access-link">{link.url}</code>}
    {feedback && <p className="inline-feedback" role={feedbackError ? 'alert' : 'status'}>{feedback}</p>}
    {canShare
      ? <><button type="button" className="primary" onClick={() => void share()}>Поделиться</button><button type="button" className="sheet-cancel" onClick={() => void copy()}>Скопировать</button></>
      : <button type="button" className="primary" onClick={() => void copy()}>Скопировать</button>}
    {link.revoke && <button type="button" className="danger-link" disabled={busy} onClick={() => void revoke()}>{busy ? 'Отзываем…' : 'Отозвать'}</button>}
  </section>{confirmation}</div>
}

// Строка настроек: слева понятие, справа значение и стрелка. Всё, что требует экрана, открывается шитом.
export function SettingsRow({ label, value, tone, disabled = false, onClick }: { label: string; value?: React.ReactNode; tone?: 'warn' | 'danger'; disabled?: boolean; onClick?: () => void }) {
  const className = `settings-row${tone ? ` ${tone}` : ''}`
  if (!onClick) return <div className={className}><span>{label}</span>{value !== undefined && <span className="settings-row-value"><span>{value}</span></span>}</div>
  return <button type="button" className={className} disabled={disabled} onClick={() => { tap(4); onClick() }}><span>{label}</span><span className="settings-row-value">{value !== undefined && <span>{value}</span>}{tone !== 'danger' && <ChevronIcon/>}</span></button>
}

export type AccessSheet = 'members' | 'devices' | 'workspace-name' | 'display-name' | 'currency' | null

// Две группы строк — «Пространство» и «Профиль»; списки участников и устройств живут в шитах, на первом уровне только счётчик.
// `children` дописываются в «Пространство», `profileRows` — в «Профиль».
export function AccessSettings({ user, workspace, bootstrap, setBootstrap, pendingCount, online, onSession, onNotice, onBusyChange, children, profileRows }: {
  user: AuthenticatedSession
  workspace: WorkspaceSummary
  bootstrap: Bootstrap
  setBootstrap: React.Dispatch<React.SetStateAction<Bootstrap>>
  pendingCount: number
  online: boolean
  onSession: (session: SessionState) => Promise<void>
  onNotice: (message: string, urgent?: boolean) => void
  onBusyChange: (busy: boolean) => void
  children?: React.ReactNode
  profileRows?: React.ReactNode
}) {
  const [members, setMembers] = useState<import('../types').Participant[]>([])
  const [devices, setDevices] = useState<import('../types').DeviceSession[]>([])
  const [invitations, setInvitations] = useState<import('../types').InvitationMetadata[]>([])
  const [link, setLink] = useState<{ title: string; url: string; expiresAt?: string; hint?: string; revoke?: () => Promise<void> } | null>(null)
  const [recovery, setRecovery] = useState<RecoveryPrepareResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [sheet, setSheet] = useState<AccessSheet>(null)
  const { confirm, confirmation } = useConfirm()
  const owner = workspace.role === 'owner'

  useEffect(() => {
    onBusyChange(Boolean(busyAction))
    return () => onBusyChange(false)
  }, [busyAction, onBusyChange])

  const showError = useCallback((reason: unknown, fallback: string) => {
    onNotice(reason instanceof ApiError || reason instanceof Error ? reason.message : fallback, true)
  }, [onNotice])

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!online) {
      setLoading(false)
      setLoadError('Список обновится, когда появится сеть.')
      return
    }
    setLoading(true); setLoadError('')
    try {
      const [people, sessions, links] = await Promise.all([
        listMembers(workspace.id, signal),
        listSessions(signal),
        workspace.role === 'owner' ? listInvitations(workspace.id, signal) : Promise.resolve({ invitations: [] }),
      ])
      if (signal?.aborted) return
      setMembers(people.members); setDevices(sessions.sessions); setInvitations(links.invitations)
      setLoading(false)
    } catch (reason) {
      if (signal?.aborted) return
      setLoading(false); setLoadError(reason instanceof ApiError || reason instanceof Error ? reason.message : 'Не удалось загрузить список.')
    }
  }, [online, workspace.id, workspace.role])

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [refresh])

  const invite = async () => {
    if (busyAction) return
    setBusyAction('invite')
    try {
      const result = await createInvitation(workspace.id)
      setLink({
        title: 'Приглашение', url: result.url, expiresAt: result.invitation.expiresAt, hint: `Отправьте ссылку человеку, которого зовёте в «${workspace.name}».`,
        revoke: async () => { await revokeInvitation(workspace.id, result.invitation.id); setLink(null); await refresh() },
      })
      await refresh()
    } catch (reason) { showError(reason, 'Не удалось создать приглашение') }
    finally { setBusyAction(null) }
  }

  const device = async () => {
    if (busyAction) return
    setBusyAction('device')
    try {
      const result = await createDeviceLink()
      setLink({ title: 'Открыть на другом устройстве', url: result.url, expiresAt: result.deviceLink.expiresAt, hint: 'Откройте ссылку или QR на другом телефоне или компьютере — там появится этот же профиль.' })
    } catch (reason) { showError(reason, 'Не удалось создать ссылку') }
    finally { setBusyAction(null) }
  }

  const rotateRecovery = async () => {
    if (busyAction) return
    if (user.user.recoveryConfigured && !await confirm({ title: 'Заменить ссылку доступа?', message: 'Старая ссылка перестанет работать, как только вы подтвердите новую. Сначала убедитесь, что сможете сохранить новую.', confirmLabel: 'Заменить', danger: true })) return
    setBusyAction('recovery')
    try { setRecovery(await prepareInitialOrManualRecovery()) }
    catch (reason) { showError(reason, 'Не удалось подготовить ссылку доступа') }
    finally { setBusyAction(null) }
  }

  const completeRotation = async (): Promise<void> => {
    if (!recovery) return
    const outcome = await completeRotationSafely({ prepared: recovery, targetUserId: user.user.id })
    if (outcome.status !== 'completed') {
      if (outcome.status === 'rotation-stale') throw new Error('Параллельно была сохранена другая ссылка. Используйте последнюю подтверждённую.')
      throw new Error('Не удалось подтвердить новую ссылку. Не удаляйте предыдущую, пока не повторите.')
    }
    await onSession(outcome.session)
    onNotice('Ссылка доступа сохранена')
  }

  const runAction = async (key: string, action: () => Promise<void>, fallback: string, success?: string) => {
    if (busyAction) return
    setBusyAction(key)
    try { await action(); if (success) onNotice(success) }
    catch (reason) { showError(reason, fallback) }
    finally { setBusyAction(null) }
  }

  const saveWorkspaceName = async (name: string) => {
    await renameWorkspace(workspace.id, name, workspace.version)
    await onSession(await getSession())
  }
  const saveDisplayName = async (name: string) => {
    await updateProfile(name)
    await onSession(await getSession())
  }
  // Валюта пространства общая для всех: в ней начинается новый расход и считаются итоги. Меняет её владелец; валюта,
  // которую он выбирал вручную, сбрасывается, чтобы его следующая запись сразу пошла в новой.
  const currency = workspaceCurrency(bootstrap)
  // Короткий список шторки: текущая, встречавшиеся в записях и четыре ходовые — чтобы обычный выбор обходился без поиска.
  const usedCurrencies = [...new Set([currency, ...bootstrap.expenses.filter((item) => !item.deletedAt).map((item) => item.currency), ...PINNED_CURRENCIES])]
  const saveCurrency = (code: string) => runAction('currency', async () => {
    const { workspace: saved } = await changeWorkspaceCurrency(workspace.id, code, workspace.version)
    setBootstrap((data) => ({ ...data, workspace: { ...data.workspace, ...saved }, defaultAnalyticsCurrency: saved.currency ?? code, settings: patchSettings(data.settings, { lastCurrency: null }) }))
    saveMemberSettings(user.user.id, workspace.id, { lastCurrency: null })
    await onSession(await getSession())
  }, 'Не удалось изменить валюту', `Новые расходы — в ${code}`)

  const otherDevices = devices.filter((item) => !item.current)
  const busy = Boolean(busyAction)
  const listState = loading
    ? <p className="management-state" role="status">Загружаем…</p>
    : loadError ? <p className="management-state" role="status"><span>{loadError}</span>{online && <button type="button" onClick={() => void refresh()}>Повторить</button>}</p> : null
  return <>
    <div className="settings-list" role="group" aria-labelledby="settings-space"><h2 id="settings-space">Пространство</h2><div className="settings-rows">
      <SettingsRow label="Название пространства" value={workspace.name} onClick={owner ? () => setSheet('workspace-name') : undefined} disabled={!online}/>
      <SettingsRow label="Валюта" value={currency} onClick={owner ? () => setSheet('currency') : undefined} disabled={!online}/>
      <SettingsRow label="Участники" value={loading ? '…' : owner ? `${members.length} · пригласить` : String(members.length)} onClick={() => setSheet('members')}/>
      {children}
    </div></div>
    <div className="settings-list" role="group" aria-labelledby="settings-profile"><h2 id="settings-profile">Профиль</h2><div className="settings-rows">
      <SettingsRow label="Ваше имя" value={user.user.displayName} onClick={() => setSheet('display-name')} disabled={!online}/>
      <SettingsRow label="Ссылка доступа" value={busyAction === 'recovery' ? 'Готовим…' : user.user.recoveryConfigured ? 'сохранена' : 'не сохранена'} tone={user.user.recoveryConfigured ? undefined : 'warn'} onClick={() => void rotateRecovery()} disabled={!online || busy}/>
      <SettingsRow label="Другие устройства" value={loading ? '…' : otherDevices.length ? String(otherDevices.length) : 'нет'} onClick={() => setSheet('devices')}/>
      {profileRows}
    </div></div>
    {sheet === 'workspace-name' && <TextSheet title="Название пространства" value={workspace.name} placeholder="Например, Дом или Поездка" onClose={() => setSheet(null)} onSave={saveWorkspaceName}/>}
    {sheet === 'currency' && <CurrencySheet currencies={bootstrap.currencies} used={usedCurrencies} selected={currency} onClose={() => setSheet(null)} onSelect={(code) => { setSheet(null); if (code !== currency) void saveCurrency(code) }}/>}
    {sheet === 'display-name' && <TextSheet title="Ваше имя" value={user.user.displayName} onClose={() => setSheet(null)} onSave={saveDisplayName}/>}
    {sheet === 'members' && <ListSheet title="Участники" dismissible={!busy} onClose={() => setSheet(null)}>
      {listState}
      {members.map((member) => <div className="management-row" key={member.userId}>
        <span>{member.displayName}<small>{member.role === 'owner' ? 'Владелец' : 'Участник'}{member.isCurrentUser ? ' · это вы' : ''}</small></span>
        {owner && !member.isCurrentUser && <span>
          <button type="button" disabled={!online || busy} onClick={() => void (async () => {
            if (!await confirm({ title: 'Передать владение?', message: `${member.displayName} станет владельцем пространства, а вы — участником.`, confirmLabel: 'Передать', danger: true })) return
            await runAction(`transfer-${member.userId}`, async () => { await transferOwnership(workspace.id, member.userId, workspace.version); await onSession(await getSession()) }, 'Не удалось передать владение', 'Владение передано')
          })()}>Передать</button>
          <button type="button" disabled={!online || busy} onClick={() => void (async () => {
            if (!await confirm({ title: 'Удалить участника?', message: 'Доступ к пространству прекратится, но уже скачанные на его устройства данные стереть удалённо нельзя.', confirmLabel: 'Удалить', danger: true })) return
            await runAction(`remove-${member.userId}`, async () => { await removeMember(workspace.id, member.userId); await refresh() }, 'Не удалось удалить участника', 'Участник удалён')
          })()}>Удалить</button>
        </span>}
      </div>)}
      {owner && invitations.map((item) => <div className="management-row" key={item.id}><span>Приглашение<small>{formatLinkLifetime(item.expiresAt).replace('Ссылка действует', 'действует ещё')}</small></span><button type="button" disabled={!online || busy} onClick={() => void (async () => { if (!await confirm({ title: 'Отозвать приглашение?', message: 'Ссылка сразу перестанет работать.', confirmLabel: 'Отозвать', danger: true })) return; await runAction(`invite-${item.id}`, async () => { await revokeInvitation(workspace.id, item.id); await refresh() }, 'Не удалось отозвать приглашение', 'Приглашение отозвано') })()}>{busyAction === `invite-${item.id}` ? 'Отзываем…' : 'Отозвать'}</button></div>)}
      {owner
        ? <button type="button" className="primary sheet-action" disabled={!online || busy} onClick={() => void invite()}>{busyAction === 'invite' ? 'Создаём приглашение…' : 'Пригласить человека'}</button>
        : <button type="button" className="danger-link sheet-action" disabled={!online || busy} onClick={() => {
          const warning = pendingCount ? `Неотправленные изменения (${pendingCount}) пропадут вместе с данными пространства на этом телефоне.` : 'Пространство исчезнет с этого телефона. Вернуться в него можно только по новому приглашению.'
          void (async () => {
            if (!await confirm({ title: 'Выйти из пространства?', message: warning, confirmLabel: 'Выйти', danger: true })) return
            await runAction('leave', async () => { await leaveWorkspace(workspace.id); await clearWorkspaceOfflineData(user.user.id, workspace.id); await onSession(await getSession()) }, 'Не удалось выйти из пространства')
          })()
        }}>Выйти из пространства</button>}
    </ListSheet>}
    {sheet === 'devices' && <ListSheet title="Другие устройства" dismissible={!busy} onClose={() => setSheet(null)}>
      {listState}
      {otherDevices.map((deviceItem) => <div className="management-row" key={deviceItem.id}>
        <span>{deviceItem.label}<small>Был в сети {formatRelativeTime(deviceItem.lastSeenAt)}</small></span>
        <button type="button" disabled={!online || busy} onClick={() => void (async () => { if (!await confirm({ title: 'Отключить устройство?', message: `На устройстве «${deviceItem.label}» придётся войти заново.`, confirmLabel: 'Отключить', danger: true })) return; await runAction(`device-${deviceItem.id}`, async () => { await revokeSession(deviceItem.id); await refresh() }, 'Не удалось отключить устройство', 'Устройство отключено') })()}>{busyAction === `device-${deviceItem.id}` ? 'Отключаем…' : 'Отключить'}</button>
      </div>)}
      {!loading && !loadError && !otherDevices.length && <p className="sheet-copy">Пока этот профиль открыт только здесь.</p>}
      <button type="button" className="primary sheet-action" disabled={!online || busy} onClick={() => void device()}>{busyAction === 'device' ? 'Готовим ссылку…' : 'Открыть на другом устройстве'}</button>
    </ListSheet>}
    {link && <AccessLinkSheet link={link} onClose={() => setLink(null)} onRevoke={(reason) => showError(reason, 'Не удалось отозвать ссылку')}/>}
    {recovery && <RecoverySave key={recovery.completionToken} prepared={recovery} mode={user.user.recoveryConfigured ? 'rotation' : 'initial'} close={() => setRecovery(null)} complete={completeRotation}/>}
    {confirmation}
  </>
}

// Порядок в списке меняется перетаскиванием за ручку ≡ (или стрелками с клавиатуры) — вместо двух стрелок на каждую строку.
// На iOS ручке нужен touch-action: none, иначе Safari отдаёт жест прокрутке и обрывает указатель.
export function DragList<T extends { id: string }>({ items, disabled = false, className, onReorder, render }: { items: T[]; disabled?: boolean; className?: string; onReorder: (ids: string[]) => void; render: (item: T) => React.ReactNode }) {
  const [order, setOrder] = useState<string[] | null>(null)
  const [drag, setDrag] = useState<{ id: string; pointerY: number } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const grabOffset = useRef(0)
  const shown = order ? order.map((id) => items.find((item) => item.id === id)).filter((item): item is T => Boolean(item)) : items
  const rowOf = (id: string) => Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-drag-id]') ?? []).find((row) => row.dataset.dragId === id) ?? null
  // Поднятая строка следует за пальцем; её место в списке уже поменялось, поэтому сдвиг считается от новой позиции в раскладке.
  useLayoutEffect(() => {
    if (!drag) return
    const row = rowOf(drag.id)
    const list = listRef.current
    if (!row || !list) return
    row.style.transform = `translateY(${drag.pointerY - (list.getBoundingClientRect().top + row.offsetTop + grabOffset.current)}px)`
  }, [drag, order])
  const start = (event: React.PointerEvent<HTMLElement>, id: string) => {
    if (disabled || event.button !== 0) return
    const row = rowOf(id)
    if (!row) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    grabOffset.current = event.clientY - row.getBoundingClientRect().top
    setOrder(items.map((item) => item.id))
    setDrag({ id, pointerY: event.clientY })
  }
  const move = (event: React.PointerEvent) => {
    if (!drag) return
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-drag-id]') ?? []).filter((row) => row.dataset.dragId !== drag.id)
    // Новая позиция — число чужих строк, середину которых палец уже прошёл.
    let index = 0
    for (const row of rows) { const rect = row.getBoundingClientRect(); if (event.clientY > rect.top + rect.height / 2) index += 1 }
    setOrder((current) => {
      if (!current) return current
      const without = current.filter((id) => id !== drag.id)
      const next = [...without.slice(0, index), drag.id, ...without.slice(index)]
      return next.every((id, at) => id === current[at]) ? current : next
    })
    setDrag({ id: drag.id, pointerY: event.clientY })
  }
  const end = (commit: boolean) => {
    if (!drag) return
    const row = rowOf(drag.id)
    if (row) row.style.transform = ''
    const next = order
    setDrag(null); setOrder(null)
    if (commit && next && next.some((id, at) => id !== items[at]?.id)) onReorder(next)
  }
  const keyMove = (event: React.KeyboardEvent, id: string) => {
    const direction = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
    if (!direction || disabled) return
    event.preventDefault()
    const ids = items.map((item) => item.id)
    const index = ids.indexOf(id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= ids.length) return
    ;[ids[index], ids[target]] = [ids[target]!, ids[index]!]
    onReorder(ids)
  }
  return <div ref={listRef} className={`drag-list${className ? ` ${className}` : ''}${drag ? ' dragging' : ''}`}>{shown.map((item) => <div key={item.id} data-drag-id={item.id} className={`drag-row${drag?.id === item.id ? ' lifted' : ''}`}>
    {render(item)}
    {items.length > 1 && <span className="drag-handle" role="button" tabIndex={disabled ? -1 : 0} aria-label="Перетащить, чтобы изменить порядок" aria-disabled={disabled} onPointerDown={(event) => start(event, item.id)} onPointerMove={move} onPointerUp={() => end(true)} onPointerCancel={() => end(false)} onKeyDown={(event) => keyMove(event, item.id)}>≡</span>}
  </div>)}</div>
}

export type { ThemePreference }

// «−» убирает с экрана, «+» ставит обратно. Знаки нарисованы: символы шрифта сидят на строке текста
// и в Safari на iPhone уезжали из центра круга.
export function LayoutToggle({ shown, label, onToggle }: { shown: boolean; label: string; onToggle: () => void }) {
  return <button type="button" className={`layout-toggle${shown ? ' shown' : ''}`} aria-label={label} onClick={() => { tap(4); onToggle() }}><span aria-hidden="true"><svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d={shown ? 'M2.5 6h7' : 'M2.5 6h7M6 2.5v7'}/></svg></span></button>
}

export const THEME_OPTIONS: SelectOption[] = [{ value: 'system', label: 'Как в системе' }, { value: 'light', label: 'Светлая' }, { value: 'dark', label: 'Тёмная' }]

// Строка «Внешний вид» коротко показывает выбранное: точку своего цвета и тему. Крупный текст виден и так;
// название цвета слышит экранный диктор.
export function AppearanceValue({ appearance }: { appearance: Appearance }) {
  const theme = THEME_OPTIONS.find((option) => option.value === appearance.theme)?.label
  return <><i className="accent-dot" aria-hidden="true"/><span className="sr-only">{`${accentInfo(appearance.accent).name} цвет, `}</span>{theme}</>
}

// Тема, свой цвет и размер текста — в одном шите. Выбор применяется сразу, на этом экране и на других устройствах
// человека; другие участники пространства его не видят.
export function AppearanceSheet({ appearance, onChange, onClose }: { appearance: Appearance; onChange: (patch: Partial<Appearance>) => void; onClose: () => void }) {
  const pick = (patch: Partial<Appearance>) => { tap(4); onChange(patch) }
  return <ListSheet title="Внешний вид" onClose={onClose}>
    <h3 id="appearance-theme">Тема</h3>
    <div className="segmented" role="group" aria-labelledby="appearance-theme">{THEME_OPTIONS.map((option) => <button type="button" key={option.value} className={appearance.theme === option.value ? 'selected' : undefined} aria-pressed={appearance.theme === option.value} onClick={() => pick({ theme: option.value as Appearance['theme'] })}>{option.label}</button>)}</div>
    <h3 id="appearance-accent">Цвет</h3>
    <div className="colors" role="group" aria-labelledby="appearance-accent">{ACCENTS.map((accent) => <button type="button" key={accent.id} aria-label={`Цвет: ${accent.name}`} aria-pressed={appearance.accent === accent.id} className={`accent-swatch${appearance.accent === accent.id ? ' selected' : ''}`} style={{ '--swatch': accent.light, '--swatch-dark': accent.dark } as React.CSSProperties} onClick={() => pick({ accent: accent.id })}/>)}</div>
    <h3 id="appearance-text">Размер текста</h3>
    <div className="segmented" role="group" aria-labelledby="appearance-text">{TEXT_SIZES.map((size) => <button type="button" key={size.id} className={appearance.textSize === size.id ? 'selected' : undefined} aria-pressed={appearance.textSize === size.id} onClick={() => pick({ textSize: size.id })}>{size.label}</button>)}</div>
    <p className="sheet-copy">Видно только вам — на любом вашем устройстве.</p>
    <button type="button" className="primary sheet-action" onClick={onClose}>Готово</button>
  </ListSheet>
}

// Какие блоки стоят на экранах: «−» убирает блок, «+» возвращает его в конец экрана, ≡ в аналитике меняет порядок.
// Из настроек открываются все экраны сразу («Мои экраны»), с самого экрана — только он. Меняется сразу и только у
// самого человека, на любом его устройстве.
export function ScreenBlocksSheet({ screens = BLOCK_SCREENS, settings, onChange, onClose }: { screens?: BlockScreen[]; settings?: AccountSettings; onChange: (patch: SettingsPatch<AccountSettings>) => void; onClose: () => void }) {
  const single = screens.length === 1 ? SCREENS[screens[0]!] : null
  return <ListSheet title={single ? `Экран «${single.title}»` : 'Мои экраны'} onClose={onClose}>
    {screens.map((screen) => {
      const info = SCREENS[screen]
      const blocks = blocksOf(screen, settings)
      const save = (next: Blocks) => {
        const patch: SettingsPatch<AccountSettings> = {}
        patch[info.setting] = toBlockLayout(next)
        onChange(patch)
      }
      const row = (block: BlockInfo, shown: boolean) => <>
        <LayoutToggle shown={shown} label={shown ? `Убрать «${block.name}» с экрана «${info.title}»` : `Вернуть «${block.name}» на экран «${info.title}»`} onToggle={() => save(shown ? hideBlock(blocks, block.id) : showBlock(blocks, block.id))}/>
        <span className="block-name"><b>{block.name}</b><small>{block.hint}</small></span>
      </>
      return <section key={screen} className="blocks-section" aria-label={`Экран «${info.title}»`}>
        {!single && <h3>{info.title}</h3>}
        {info.reorder
          ? <DragList className="blocks-list" items={blocks.shown} onReorder={(ids) => save(reorderBlocks(blocks, ids))} render={(block) => row(block, true)}/>
          : <div className="drag-list blocks-list">{blocks.shown.map((block) => <div key={block.id} className="drag-row">{row(block, true)}</div>)}</div>}
        {blocks.hidden.length > 0 && <div className="drag-list blocks-list">{blocks.hidden.map((block) => <div key={block.id} className="drag-row off">{row(block, false)}</div>)}</div>}
        <p className="blocks-fixed">{info.fixed}</p>
      </section>
    })}
    <p className="sheet-copy">Видно только вам — на любом вашем устройстве.</p>
    <button type="button" className="primary sheet-action" onClick={onClose}>Готово</button>
  </ListSheet>
}

// Экспорт CSV живёт в настройках: это действие раз в квартал, а не при каждом просмотре истории.
export function exportHistoryCsv(bootstrap: Bootstrap) {
  const expenses = bootstrap.expenses.filter((item) => !item.deletedAt).sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
  const blob = new Blob(['﻿', buildHistoryCsv(expenses, bootstrap.categories, bootstrap.currencies, bootstrap.tags ?? [])], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `moapp-history-${localDateKey(new Date())}.csv`
  link.hidden = true
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
  return expenses.length
}

export type SettingsSheet = 'categories' | 'tags' | 'appearance' | 'screens' | null

// Настройки — плоский список в три группы: «что это за пространство», «кто я и как у меня выглядит приложение»
// (это живёт в аккаунте и едет на любое устройство), «что на этом телефоне». Без сегментов и вложенных заголовков:
// строка = одно понятие, всё, что требует экрана, открывается шитом.
export function SettingsView({ user, workspace, workspaceId, bootstrap, setBootstrap, pendingCount, refreshPending, onLogout, appearance=DEFAULT_APPEARANCE, onAppearanceChange=()=>{}, onAccountSettingsChange=()=>{}, onSession, online, mods=null, onOpenMods=()=>{}, loadOlderExpenses }: { user: AuthenticatedSession; workspace:WorkspaceSummary; workspaceId:string; bootstrap:Bootstrap; setBootstrap:React.Dispatch<React.SetStateAction<Bootstrap>>; pendingCount:number; refreshPending:()=>void;onLogout:()=>void;appearance?:Appearance;onAppearanceChange?:(patch:Partial<Appearance>)=>void;onAccountSettingsChange?:(patch:SettingsPatch<AccountSettings>)=>void;onSession:(session:SessionState)=>Promise<void>;online:boolean;mods?:WorkspaceMod[]|null;onOpenMods?:()=>void;loadOlderExpenses?:()=>Promise<Expense[]> }) {
  const [sheet,setSheet]=useState<SettingsSheet>(null)
  const [editing,setEditing]=useState<Category|null>(null)
  const [adding,setAdding]=useState(false)
  const [editingTag,setEditingTag]=useState<Tag|null>(null)
  const [addingTag,setAddingTag]=useState(false)
  const [accessBusy,setAccessBusy]=useState(false)
  const {toast:notice,notify:setNotice,dismiss:hideNotice}=useToast()
  const accessNotice=useCallback((message:string,urgent=false)=>setNotice(message,undefined,urgent),[setNotice])
  const save=async(category:Category)=>{
    const previous=bootstrap.categories.find((item)=>item.id===category.id)
    const matchesOptimistic=(item:Category)=>item.version===category.version&&item.updatedAt===category.updatedAt&&item.name===category.name&&item.color===category.color&&item.emoji===category.emoji&&item.placement===category.placement&&item.sortOrder===category.sortOrder&&item.archivedAt===category.archivedAt
    setBootstrap((b)=>({...b,categories:[category,...b.categories.filter((x)=>x.id!==category.id)]}))
    try{
      const saved=previous?await updateCategory(workspaceId,category.id,category):await createCategory(workspaceId,category)
      // Сервер мог вернуть скрытую категорию с тем же именем вместо новой: в состоянии она уже есть, поэтому
      // оптимистичную строку убираем, а старую заменяем возвращённой.
      const restored=!previous&&saved.id!==category.id
      setBootstrap((b)=>{
        const optimistic=b.categories.find((x)=>x.id===category.id)
        if(optimistic&&!matchesOptimistic(optimistic))return b
        return{...b,categories:[saved,...b.categories.filter((x)=>x.id!==category.id&&x.id!==saved.id)]}
      })
      setEditing(null);setAdding(false)
      setNotice(category.archivedAt?'Категория скрыта'
        :restored?`Категория «${saved.name}» вернулась вместе со старыми расходами`
        :previous?.archivedAt?`Категория «${saved.name}» вернулась`
        :'Категория сохранена')
    }catch(error){
      setBootstrap((b)=>{
        const optimistic=b.categories.find((x)=>x.id===category.id)
        if(!optimistic||!matchesOptimistic(optimistic))return b
        return{...b,categories:previous?b.categories.map((x)=>x.id===category.id?previous:x):b.categories.filter((x)=>x.id!==category.id)}
      })
      const occupied=error instanceof ApiError&&error.code==='DUPLICATE'?(error.details as {current?:Category}|undefined)?.current:undefined
      setNotice(occupied?`Категория «${occupied.name}» уже есть`
        :error instanceof ApiError?error.message:'Не удалось сохранить категорию',undefined,true)
    }
    refreshPending()
  }
  // Скрытые видны только здесь: имя за ними остаётся занятым, поэтому вернуть их нужно уметь без повторного создания.
  const hiddenCategories=bootstrap.categories.filter((x)=>x.archivedAt).sort((a,b)=>a.name.localeCompare(b.name,'ru'))
  // Что стоит на «Расходе», у каждого своё и живёт в аккаунте: меняется сразу и без сети, как тема. Сами категории
  // и теги — общие, их правка идёт на сервер.
  const categoryTiles=categoryLayout(bootstrap.categories,bootstrap.settings?.categoryOrder)
  const activeCount=categoryTiles.shown.length+categoryTiles.more.length
  const tags=bootstrap.tags??[]
  const tagRow=tagLayout(tags,bootstrap.settings?.tagOrder)
  const saveLayout=(key:'categoryOrder'|'tagOrder',layout:Layout<{id:string}>)=>{
    const order=toScreenOrder(layout)
    const patch=key==='categoryOrder'?{categoryOrder:order}:{tagOrder:order}
    setBootstrap((b)=>({...b,settings:patchSettings(b.settings,patch)}))
    saveMemberSettings(user.user.id,workspaceId,patch)
  }
  const saveTag=async(name:string,color:string|null)=>{
    try{
      const saved=editingTag?await updateTag(workspaceId,editingTag.id,{name,color,version:editingTag.version}):await createTag(workspaceId,{name,color})
      setBootstrap((b)=>({...b,tags:[saved,...(b.tags??[]).filter((x)=>x.id!==saved.id)]}))
      setEditingTag(null);setAddingTag(false);setNotice(editingTag?'Тег сохранён':'Тег создан')
    }catch(error){
      setNotice(error instanceof ApiError?error.code==='DUPLICATE'?'Тег с таким названием уже есть':error.message:'Не удалось сохранить тег',undefined,true)
    }
    refreshPending()
  }
  const removeTag=async(tag:Tag)=>{
    try{
      await deleteTag(workspaceId,tag.id,tag.version)
      setBootstrap((b)=>({...b,tags:(b.tags??[]).filter((x)=>x.id!==tag.id),expenses:b.expenses.map((x)=>x.tagIds?.includes(tag.id)?{...x,tagIds:x.tagIds.filter((id)=>id!==tag.id)}:x)}))
      setEditingTag(null);setNotice('Тег удалён')
    }catch(error){setNotice(error instanceof ApiError?error.message:'Не удалось удалить тег',undefined,true)}
  }
  // Моды — одной строкой: сколько добавлено, а если ключ Bybit перестал работать — об этом, чтобы не искать внутри.
  const addedMods=mods?.filter((mod)=>mod.added)??[]
  const modsNeedAttention=addedMods.some((mod)=>mod.state?.status==='error')
  const modsValue=mods===null?(online?'…':'нужна сеть'):modsNeedAttention?'нужно обновить':addedMods.length?String(addedMods.length):'нет'
  const hiddenBlocks=hiddenBlockCount(user.settings)
  // «−» убирает с «Расхода» за «Ещё», «+» ставит обратно в конец ряда; ≡ меняет порядок внутри группы.
  const layoutToggle=(name:string,shown:boolean,move:()=>void)=><LayoutToggle shown={shown} label={shown?`Убрать «${name}» с «Расхода»`:`Поставить «${name}» на «Расход»`} onToggle={move}/>
  const categoryRow=(shown:boolean)=>(category:Category)=><>
    {layoutToggle(category.name,shown,()=>saveLayout('categoryOrder',shown?moveToMore(categoryTiles,category.id):moveToShown(categoryTiles,category.id)))}
    <CategoryMark category={category}/>
    <button type="button" className="category-name" disabled={!online} onClick={()=>setEditing(category)}>{category.name}</button>
  </>
  const tagLine=(shown:boolean)=>(tag:Tag)=><>
    {layoutToggle(tag.name,shown,()=>saveLayout('tagOrder',shown?moveToMore(tagRow,tag.id):moveToShown(tagRow,tag.id)))}
    <i style={{background:tag.color??'#a9afa5'}}/>
    <button type="button" className="category-name" disabled={!online} onClick={()=>setEditingTag(tag)}>{tag.name}</button>
  </>
  return <section className="page settings-page">
    <AccessSettings user={user} workspace={workspace} bootstrap={bootstrap} setBootstrap={setBootstrap} pendingCount={pendingCount} online={online} onSession={onSession} onNotice={accessNotice} onBusyChange={setAccessBusy}
      profileRows={<>
        <SettingsRow label="Внешний вид" value={<AppearanceValue appearance={appearance}/>} onClick={()=>setSheet('appearance')}/>
        <SettingsRow label="Мои экраны" value={hiddenBlocks?`убрано ${hiddenBlocks}`:'всё на месте'} onClick={()=>setSheet('screens')}/>
      </>}>
      <SettingsRow label="Категории" value={String(activeCount)} onClick={()=>setSheet('categories')}/>
      <SettingsRow label="Теги" value={tags.length?String(tags.length):'нет'} onClick={()=>setSheet('tags')}/>
      <SettingsRow label="Моды" value={modsValue} tone={modsNeedAttention?'warn':undefined} onClick={onOpenMods}/>
    </AccessSettings>
    <div className="settings-list" role="group" aria-labelledby="settings-device"><h2 id="settings-device">Этот телефон</h2><div className="settings-rows">
      <SettingsRow label="Экспорт в CSV" onClick={()=>{void (async()=>{
        // В файл идёт вся история: записи старше окна первичной загрузки сначала подтягиваются с сервера.
        try{const expenses=bootstrap.olderExpenses&&loadOlderExpenses?await loadOlderExpenses():bootstrap.expenses;setNotice(`Экспортировано расходов: ${exportHistoryCsv({...bootstrap,expenses})}`)}
        catch(reason){setNotice(reason instanceof ApiError?reason.message:'Не удалось подготовить файл экспорта',undefined,true)}
      })()}}/>
      <SettingsRow label="Выйти" tone="danger" disabled={accessBusy} onClick={onLogout}/>
    </div></div>
    {sheet==='categories'&&<ListSheet title="Категории" onClose={()=>setSheet(null)}>
      {activeCount>0&&<h3>Плитки на «Расходе»</h3>}
      <DragList className="layout-list" items={categoryTiles.shown} onReorder={(ids)=>saveLayout('categoryOrder',reorderGroup(categoryTiles,'shown',ids))} render={categoryRow(true)}/>
      {activeCount>0&&!categoryTiles.shown.length&&<p className="sheet-copy">Плиток нет: все категории за плиткой «Ещё».</p>}
      {categoryTiles.shown.length>ROOMY_TILES&&<p className="sheet-copy">На узком телефоне больше четырёх плиток помещаются с трудом, подписи обрежутся.</p>}
      {categoryTiles.more.length>0&&<h3>За плиткой «Ещё»</h3>}
      <DragList className="layout-list" items={categoryTiles.more} onReorder={(ids)=>saveLayout('categoryOrder',reorderGroup(categoryTiles,'more',ids))} render={categoryRow(false)}/>
      {!activeCount&&<p className="sheet-copy">Категорий пока нет.</p>}
      {hiddenCategories.length>0&&<><h3>Скрытые</h3>
        {hiddenCategories.map((category)=><div className="management-row hidden-category" key={category.id}>
          <CategoryMark category={category}/>
          <span>{category.name}<small>остаётся у старых расходов</small></span>
          <button type="button" disabled={!online} onClick={()=>void save({...category,archivedAt:null})}>Вернуть</button>
        </div>)}</>}
      <p className="sheet-copy">{`Плитки и их порядок — только ваши. Название, значок и цвет — общие для всех в «${workspace.name}»${online?'.':', их можно менять только при подключении к сети.'}`}</p>
      <button type="button" className="primary sheet-action" disabled={!online} onClick={()=>setAdding(true)}>Новая категория</button>
    </ListSheet>}
    {sheet==='tags'&&<ListSheet title="Теги" onClose={()=>setSheet(null)}>
      {tags.length>0&&<h3>В ряду на «Расходе»</h3>}
      <DragList className="layout-list" items={tagRow.shown} onReorder={(ids)=>saveLayout('tagOrder',reorderGroup(tagRow,'shown',ids))} render={tagLine(true)}/>
      {tags.length>0&&!tagRow.shown.length&&<p className="sheet-copy">В ряду пусто: все теги за «Ещё».</p>}
      {tagRow.more.length>0&&<h3>За «Ещё»</h3>}
      <DragList className="layout-list" items={tagRow.more} onReorder={(ids)=>saveLayout('tagOrder',reorderGroup(tagRow,'more',ids))} render={tagLine(false)}/>
      <p className="sheet-copy">{tags.length?'Тег — короткая пометка поверх категории, например «отпуск». Ряд и его порядок — только ваши, название и цвет — общие.':'Тегов пока нет. Тег — короткая пометка поверх категории, например «отпуск» или «вдвоём».'}</p>
      <button type="button" className="primary sheet-action" disabled={!online} onClick={()=>setAddingTag(true)}>Новый тег</button>
    </ListSheet>}
    {sheet==='appearance'&&<AppearanceSheet appearance={appearance} onChange={onAppearanceChange} onClose={()=>setSheet(null)}/>}
    {sheet==='screens'&&<ScreenBlocksSheet settings={user.settings} onChange={onAccountSettingsChange} onClose={()=>setSheet(null)}/>}
    {(editing||adding)&&<CategoryEditor category={editing} workspaceName={workspace.name} onClose={()=>{setEditing(null);setAdding(false)}} onSave={save}/>}
    {(editingTag||addingTag)&&<TagEditor tag={editingTag} onClose={()=>{setEditingTag(null);setAddingTag(false)}} onSave={saveTag} onDelete={editingTag?()=>removeTag(editingTag):undefined}/>}
    {notice&&<Toast toast={notice} onDismiss={hideNotice}/>}
  </section>
}

// Частые значки трат — в одно касание; любой другой эмодзи вводится в поле за ними.
export const EMOJI_CHOICES = ['🛒', '🍽️', '☕', '🏠', '🚕', '💊', '🎬', '👕', '🎁', '✈️']

// Редактор категории правит то, что общее для всех: название, значок и цвет. Стоит ли она плиткой на «Расходе»,
// каждый решает сам в списке категорий.
export function CategoryEditor({ category, workspaceName, onClose, onSave }:{category:Category|null;workspaceName:string;onClose:()=>void;onSave:(c:Category)=>Promise<void>}) {
  const now = new Date().toISOString()
  const [draft,setDraft]=useState<Category>(category?{...category,emoji:category.emoji??null}:{id:crypto.randomUUID(),name:'',color:TAG_COLORS[0]!,emoji:null,placement:'additional',sortOrder:999,createdAt:now,updatedAt:now,archivedAt:null,version:1})
  const [busy,setBusy]=useState(false)
  const [validation,setValidation]=useState('')
  const {confirm,confirmation}=useConfirm()
  const dialogRef=useDialog(onClose,!busy)
  const submit=async(next:Category)=>{
    const name=next.name.trim()
    if(!name&&!next.archivedAt){setValidation('Введите название категории.');return}
    setValidation('');setBusy(true)
    try{await onSave({...next,name:name||next.name})}finally{setBusy(false)}
  }
  const custom=draft.emoji&&!EMOJI_CHOICES.includes(draft.emoji)?draft.emoji:''
  // В поле всегда один значок: новый эмодзи заменяет прежний, буквы не проходят, пустое поле снимает значок.
  const typeEmoji=(value:string)=>{const emoji=lastEmoji(value);if(emoji)setDraft({...draft,emoji});else if(!value)setDraft({...draft,emoji:null})}
  return <><div className="sheet-backdrop" onMouseDown={()=>{if(!busy)onClose()}}><form ref={dialogRef as React.Ref<HTMLFormElement>} className="bottom-sheet editor" role="dialog" aria-modal="true" aria-labelledby="category-editor-title" noValidate onSubmit={(e)=>{e.preventDefault();void submit(draft)}} onMouseDown={(e)=>e.stopPropagation()}>
    <div className="sheet-handle"/><div className="sheet-title"><h2 id="category-editor-title">{category?'Категория':'Новая категория'}</h2><button type="button" className="icon-button" data-dialog-initial-focus disabled={busy} aria-label="Закрыть" onClick={onClose}>×</button></div>
    <label>Название<input maxLength={40} aria-invalid={Boolean(validation)} value={draft.name} onChange={(e)=>{setValidation('');setDraft({...draft,name:e.target.value})}}/></label>
    {validation&&<p className="form-error" role="alert">{validation}</p>}
    <fieldset><legend>Значок</legend><div className="emoji-choices">
      {EMOJI_CHOICES.map((emoji)=><button type="button" key={emoji} aria-label={`Значок ${emoji}`} aria-pressed={draft.emoji===emoji} className={draft.emoji===emoji?'selected':''} onClick={()=>setDraft({...draft,emoji})}>{emoji}</button>)}
      <input className={`emoji-input${custom?' selected':''}`} aria-label="Свой значок: любой эмодзи" placeholder="🙂" value={custom} onChange={(e)=>typeEmoji(e.target.value)}/>
      <button type="button" aria-label="Без значка" aria-pressed={!draft.emoji} className={`colors-none${draft.emoji?'':' selected'}`} onClick={()=>setDraft({...draft,emoji:null})}>—</button>
    </div></fieldset>
    <fieldset><legend>Цвет</legend><div className="colors">{TAG_COLORS.map((color,index)=><button aria-label={`Цвет: ${TAG_COLOR_NAMES[index] ?? color}`} aria-pressed={draft.color===color} type="button" key={color} className={draft.color===color?'selected':''} style={{background:color}} onClick={()=>setDraft({...draft,color})}/>)}</div></fieldset>
    <p className="sheet-copy">{`Название, значок и цвет общие для всех в «${workspaceName}». Плитки на «Расходе» каждый выбирает себе сам в списке категорий.`}</p>
    <button className="primary" disabled={busy}>{busy?'Сохраняем…':'Сохранить'}</button>
    {category&&<button type="button" className="danger-link" disabled={busy} onClick={()=>void (async()=>{if(await confirm({title:'Скрыть категорию?',message:'Она пропадёт из выбора, но останется у старых расходов. Вернуть её можно в списке категорий.',confirmLabel:'Скрыть',danger:true}))await submit({...draft,archivedAt:new Date().toISOString()})})()}>Скрыть</button>}
  </form></div>{confirmation}</>
}
