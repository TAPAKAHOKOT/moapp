import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { WorkspaceApiError as ApiError, connectBybitCard, createCategory, createDeviceLink, createInvitation, createTag, deleteTag, disconnectBybitCard, getSession, leaveWorkspace, listInvitations, listMembers, listSessions, prepareInitialOrManualRecovery, removeMember, renameWorkspace, reorderCategories, reorderTags, revokeInvitation, revokeSession, syncBybitCard, transferOwnership, updateCategory, updateProfile, updateTag } from '../workspace-api'
import { clearWorkspaceOfflineData } from '../workspace-offline'
import { completeRotationSafely } from '../recovery-flow'
import type { AuthenticatedSession, BybitCardStatus, BybitRegion, Category, RecoveryPrepareResponse, SessionState, Tag, WorkspaceSummary } from '../types'
import { localDateKey } from '../utils'
import { buildHistoryCsv } from '../history'
import { ChevronIcon, ListSheet, Select, SelectSheet, TextSheet, Toast, copyText, tap, useConfirm, useDialog, useToast } from '../ui'
import type { SelectOption } from '../ui'
import { formatLinkLifetime, formatRelativeTime } from '../format'
import type { Bootstrap } from '../format'
import { TAG_COLORS, TAG_COLOR_NAMES, TagEditor, sortTags } from '../tags'
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
export function SettingsRow({ label, value, tone, disabled = false, onClick }: { label: string; value?: string; tone?: 'warn' | 'danger'; disabled?: boolean; onClick?: () => void }) {
  const className = `settings-row${tone ? ` ${tone}` : ''}`
  if (!onClick) return <div className={className}><span>{label}</span>{value !== undefined && <span className="settings-row-value"><span>{value}</span></span>}</div>
  return <button type="button" className={className} disabled={disabled} onClick={() => { tap(4); onClick() }}><span>{label}</span><span className="settings-row-value">{value !== undefined && <span>{value}</span>}{tone !== 'danger' && <ChevronIcon/>}</span></button>
}

export type AccessSheet = 'members' | 'devices' | 'workspace-name' | 'display-name' | null

// Две группы строк — «Пространство» и «Профиль»; списки участников и устройств живут в шитах, на первом уровне только счётчик.
export function AccessSettings({ user, workspace, pendingCount, online, onSession, onNotice, onBusyChange, children }: {
  user: AuthenticatedSession
  workspace: WorkspaceSummary
  pendingCount: number
  online: boolean
  onSession: (session: SessionState) => Promise<void>
  onNotice: (message: string, urgent?: boolean) => void
  onBusyChange: (busy: boolean) => void
  children?: React.ReactNode
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

  const otherDevices = devices.filter((item) => !item.current)
  const busy = Boolean(busyAction)
  const listState = loading
    ? <p className="management-state" role="status">Загружаем…</p>
    : loadError ? <p className="management-state" role="status"><span>{loadError}</span>{online && <button type="button" onClick={() => void refresh()}>Повторить</button>}</p> : null
  return <>
    <div className="settings-list" role="group" aria-labelledby="settings-space"><h2 id="settings-space">Пространство</h2><div className="settings-rows">
      <SettingsRow label="Название пространства" value={workspace.name} onClick={owner ? () => setSheet('workspace-name') : undefined} disabled={!online}/>
      <SettingsRow label="Участники" value={loading ? '…' : owner ? `${members.length} · пригласить` : String(members.length)} onClick={() => setSheet('members')}/>
      {children}
    </div></div>
    <div className="settings-list" role="group" aria-labelledby="settings-profile"><h2 id="settings-profile">Профиль</h2><div className="settings-rows">
      <SettingsRow label="Ваше имя" value={user.user.displayName} onClick={() => setSheet('display-name')} disabled={!online}/>
      <SettingsRow label="Ссылка доступа" value={busyAction === 'recovery' ? 'Готовим…' : user.user.recoveryConfigured ? 'сохранена' : 'не сохранена'} tone={user.user.recoveryConfigured ? undefined : 'warn'} onClick={() => void rotateRecovery()} disabled={!online || busy}/>
      <SettingsRow label="Другие устройства" value={loading ? '…' : otherDevices.length ? String(otherDevices.length) : 'нет'} onClick={() => setSheet('devices')}/>
    </div></div>
    {sheet === 'workspace-name' && <TextSheet title="Название пространства" value={workspace.name} placeholder="Например, Дом или Поездка" onClose={() => setSheet(null)} onSave={saveWorkspaceName}/>}
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

export const bybitRegions: Array<{id:BybitRegion;label:string}> = [
  {id:'global',label:'Global / Serbia'}, {id:'eu',label:'European Union'}, {id:'kz',label:'Kazakhstan'},
  {id:'ge',label:'Georgia'}, {id:'ae',label:'UAE'}, {id:'tr',label:'Turkey'}, {id:'nl',label:'Netherlands'}, {id:'id',label:'Indonesia'},
]

// Карта Bybit в шите: одна строка состояния, одна кнопка «Обновить», «Отключить» — текстом внизу.
export function BybitSheet({ workspace, workspaceId, status, online, onStatus, onSynced=()=>{}, onClose }: { workspace:WorkspaceSummary;workspaceId:string;status:BybitCardStatus|null;online:boolean;onStatus:(status:BybitCardStatus)=>void;onSynced?:()=>void;onClose:()=>void }) {
  const [editing,setEditing]=useState(false)
  const [apiKey,setApiKey]=useState('')
  const [apiSecret,setApiSecret]=useState('')
  const [region,setRegion]=useState<BybitRegion>('global')
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const [feedback,setFeedback]=useState('')
  const {confirm,confirmation}=useConfirm()
  const manage=workspace.role==='owner'&&status?.canManage!==false
  const connect=async(event:React.FormEvent)=>{
    event.preventDefault();if(!apiKey.trim()||!apiSecret.trim())return setError('Введите API key и secret.')
    setBusy(true);setError('')
    try{
      const next=await connectBybitCard(workspaceId,apiKey.trim(),apiSecret.trim(),region)
      onStatus(next);setApiKey('');setApiSecret('');setEditing(false)
    }catch(reason){setError(reason instanceof ApiError?reason.message:'Не удалось подключить карту')}
    finally{setBusy(false)}
  }
  // Сервер не ходит в Bybit чаще раза в минуту; кнопка обязана сказать об этом, иначе нажатие выглядит сломанным.
  const sync=async()=>{
    setBusy(true);setError('');setFeedback('')
    try{
      const result=await syncBybitCard(workspaceId);onStatus(result);onSynced()
      setFeedback(result.throttled?'Уже актуально: обновлялось меньше минуты назад':result.imported?`Новых операций: ${result.imported}`:'Новых операций нет')
    }catch(reason){setError(reason instanceof ApiError?reason.message:'Не удалось обновить операции')}
    finally{setBusy(false)}
  }
  const disconnect=async()=>{
    if(!await confirm({title:'Отключить карту?',message:'Неразобранные операции пропадут. Уже сохранённые расходы останутся в истории.',confirmLabel:'Отключить',danger:true}))return
    setBusy(true);setError('')
    try{await disconnectBybitCard(workspaceId);onStatus({connected:false,canManage:true,pendingCount:0});setEditing(false)}
    catch(reason){setError(reason instanceof ApiError?reason.message:'Не удалось отключить карту')}
    finally{setBusy(false)}
  }
  const state=status===null?'Проверяем подключение…':status.connected?status.status==='error'?'Подключена · нужно обновить':status.lastSyncedAt?`Подключена · обновлено ${formatRelativeTime(status.lastSyncedAt)}`:'Подключена':'Не подключена'
  return <ListSheet title="Карта Bybit" dismissible={!busy} onClose={onClose}>
    <div className="integration-title"><span className="bybit-mark">B</span><span><b>Bybit Card</b><small>{state}</small></span>{status?.connected&&<i className={status.status==='error'?'error':'active'}/>}</div>
    {status?.connected?<>
      <p className="sheet-copy">Платежи попадают в историю начиная с {new Date(status.enabledAt!).toLocaleDateString('ru-RU',{day:'numeric',month:'long'})}. Более ранние не загружаются.</p>
      {status.lastError&&<p className="form-error" role="alert">{status.lastError}</p>}
      <button type="button" className="primary sheet-action" disabled={!online||busy} onClick={()=>void sync()}>{busy?'Обновляем…':'Обновить'}</button>
      {feedback&&<p className="inline-feedback" role="status">{feedback}</p>}
      {manage&&<button type="button" className="danger-link sheet-action" disabled={!online||busy} onClick={()=>void disconnect()}>Отключить</button>}
    </>:manage?<>
      <p className="sheet-copy">Платежи по карте будут появляться в истории сами — останется выбрать категорию. Загружаются только платежи после подключения. Нужен отдельный ключ только для чтения с разрешением BitCard.</p>
      {!editing?<button type="button" className="primary sheet-action" disabled={!online||status===null} onClick={()=>setEditing(true)}>Подключить</button>:<form className="integration-form" onSubmit={(event)=>void connect(event)}>
        <label>Регион аккаунта<Select label="Регион аккаунта" value={region} disabled={busy} onChange={(value)=>setRegion(value as BybitRegion)} options={bybitRegions.map((item)=>({value:item.id,label:item.label}))}/></label>
        {region==='eu'&&<small className="integration-meta">Для EU Bybit требует ключ, созданный через Connect to Third-Party Applications.</small>}
        <label>API key<input autoComplete="off" value={apiKey} disabled={busy} maxLength={256} onChange={(event)=>setApiKey(event.target.value)}/></label>
        <label>API secret<input type="password" autoComplete="new-password" value={apiSecret} disabled={busy} maxLength={512} onChange={(event)=>setApiSecret(event.target.value)}/></label>
        <button className="primary" disabled={busy||!online}>{busy?'Проверяем ключ…':'Подключить'}</button><button type="button" className="sheet-cancel" disabled={busy} onClick={()=>{setEditing(false);setError('')}}>Отмена</button>
      </form>}
    </>:<p className="sheet-copy">Подключить карту может владелец пространства.</p>}
    {error&&<p className="form-error" role="alert">{error}</p>}
    {confirmation}
  </ListSheet>
}

// Порядок в списке меняется перетаскиванием за ручку ≡ (или стрелками с клавиатуры) — вместо двух стрелок на каждую строку.
// На iOS ручке нужен touch-action: none, иначе Safari отдаёт жест прокрутке и обрывает указатель.
export function DragList<T extends { id: string }>({ items, disabled = false, onReorder, render }: { items: T[]; disabled?: boolean; onReorder: (ids: string[]) => void; render: (item: T) => React.ReactNode }) {
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
  return <div ref={listRef} className={`drag-list${drag ? ' dragging' : ''}`}>{shown.map((item) => <div key={item.id} data-drag-id={item.id} className={`drag-row${drag?.id === item.id ? ' lifted' : ''}`}>
    {render(item)}
    {items.length > 1 && <span className="drag-handle" role="button" tabIndex={disabled ? -1 : 0} aria-label="Перетащить, чтобы изменить порядок" aria-disabled={disabled} onPointerDown={(event) => start(event, item.id)} onPointerMove={move} onPointerUp={() => end(true)} onPointerCancel={() => end(false)} onKeyDown={(event) => keyMove(event, item.id)}>≡</span>}
  </div>)}</div>
}

export type ThemePreference = 'system' | 'light' | 'dark'

export const THEME_OPTIONS: SelectOption[] = [{ value: 'system', label: 'Как в системе' }, { value: 'light', label: 'Светлая' }, { value: 'dark', label: 'Тёмная' }]

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

export type SettingsSheet = 'categories' | 'tags' | 'bybit' | 'theme' | null

// Настройки — плоский список в три группы: «что это за пространство», «кто я», «что на этом телефоне».
// Без сегментов и вложенных заголовков: строка = одно понятие, всё, что требует экрана, открывается шитом.
export function SettingsView({ user, workspace, workspaceId, bootstrap, setBootstrap, pendingCount, refreshPending, onLogout, theme, onThemeChange, onSession, online, bybitStatus=null, onBybitStatus=()=>{}, onBybitSynced=()=>{} }: { user: AuthenticatedSession; workspace:WorkspaceSummary; workspaceId:string; bootstrap:Bootstrap; setBootstrap:React.Dispatch<React.SetStateAction<Bootstrap>>; pendingCount:number; refreshPending:()=>void;onLogout:()=>void;theme:ThemePreference;onThemeChange:(theme:ThemePreference)=>void;onSession:(session:SessionState)=>Promise<void>;online:boolean;bybitStatus?:BybitCardStatus|null;onBybitStatus?:(status:BybitCardStatus)=>void;onBybitSynced?:()=>void }) {
  const [sheet,setSheet]=useState<SettingsSheet>(null)
  const [editing,setEditing]=useState<Category|null>(null)
  const [adding,setAdding]=useState(false)
  const [reordering,setReordering]=useState(false)
  const [editingTag,setEditingTag]=useState<Tag|null>(null)
  const [addingTag,setAddingTag]=useState(false)
  const [accessBusy,setAccessBusy]=useState(false)
  const {toast:notice,notify:setNotice,dismiss:hideNotice}=useToast()
  const accessNotice=useCallback((message:string,urgent=false)=>setNotice(message,undefined,urgent),[setNotice])
  const save=async(category:Category)=>{
    const previous=bootstrap.categories.find((item)=>item.id===category.id)
    const matchesOptimistic=(item:Category)=>item.version===category.version&&item.updatedAt===category.updatedAt&&item.name===category.name&&item.color===category.color&&item.placement===category.placement&&item.sortOrder===category.sortOrder&&item.archivedAt===category.archivedAt
    setBootstrap((b)=>({...b,categories:[category,...b.categories.filter((x)=>x.id!==category.id)]}))
    try{
      const saved=previous?await updateCategory(workspaceId,category.id,category):await createCategory(workspaceId,category)
      setBootstrap((b)=>({...b,categories:b.categories.map((x)=>x.id===category.id&&matchesOptimistic(x)?saved:x)}))
      setEditing(null);setAdding(false);setNotice(category.archivedAt?'Категория скрыта':'Категория сохранена')
    }catch(error){
      setBootstrap((b)=>{
        const optimistic=b.categories.find((x)=>x.id===category.id)
        if(!optimistic||!matchesOptimistic(optimistic))return b
        return{...b,categories:previous?b.categories.map((x)=>x.id===category.id?previous:x):b.categories.filter((x)=>x.id!==category.id)}
      })
      setNotice(error instanceof ApiError?error.message:'Не удалось сохранить категорию',undefined,true)
    }
    refreshPending()
  }
  const activeCategories=bootstrap.categories.filter((x)=>!x.archivedAt).sort((a,b)=>a.placement.localeCompare(b.placement)||a.sortOrder-b.sortOrder)
  const mainCategories=activeCategories.filter((x)=>x.placement==='main')
  const otherCategories=activeCategories.filter((x)=>x.placement==='additional')
  // Порядок внутри одной группы: сервер принимает полный список активных категорий, поэтому вторая группа идёт как есть.
  const reorderGroup=async(placement:Category['placement'],ids:string[])=>{
    if(!online||reordering)return
    setReordering(true)
    const previousOrder=new Map(activeCategories.map((item)=>[item.id,item.sortOrder]))
    const optimisticOrder=new Map(ids.map((id,order)=>[id,order]))
    const ordered=placement==='main'?[...ids,...otherCategories.map((x)=>x.id)]:[...mainCategories.map((x)=>x.id),...ids]
    setBootstrap((b)=>({...b,categories:b.categories.map((x)=>optimisticOrder.has(x.id)?{...x,sortOrder:optimisticOrder.get(x.id)!}:x)}))
    try{
      const result=await reorderCategories(workspaceId,ordered);const fresh=new Map(result.categories.map((x)=>[x.id,x]))
      setBootstrap((b)=>({...b,categories:b.categories.map((x)=>optimisticOrder.get(x.id)===x.sortOrder?(fresh.get(x.id)||x):x)}))
    }catch(error){
      setBootstrap((b)=>({...b,categories:b.categories.map((x)=>optimisticOrder.get(x.id)===x.sortOrder?{...x,sortOrder:previousOrder.get(x.id)!}:x)}))
      setNotice(error instanceof ApiError?error.message:'Не удалось изменить порядок',undefined,true)
    }
    refreshPending()
    setReordering(false)
  }
  const tags=sortTags(bootstrap.tags??[])
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
  const reorderTagList=async(ids:string[])=>{
    if(!online||reordering)return
    setReordering(true)
    const previous=new Map(tags.map((x)=>[x.id,x.sortOrder]))
    setBootstrap((b)=>({...b,tags:(b.tags??[]).map((x)=>{const at=ids.indexOf(x.id);return at>=0?{...x,sortOrder:at}:x})}))
    try{const result=await reorderTags(workspaceId,ids);setBootstrap((b)=>({...b,tags:result.tags}))}
    catch(error){setBootstrap((b)=>({...b,tags:(b.tags??[]).map((x)=>previous.has(x.id)?{...x,sortOrder:previous.get(x.id)!}:x)}));setNotice(error instanceof ApiError?error.message:'Не удалось изменить порядок тегов',undefined,true)}
    setReordering(false)
  }
  const bybitValue=bybitStatus===null?(online?'…':'нужна сеть'):bybitStatus.connected?(bybitStatus.status==='error'?'нужно обновить':'подключена'):'не подключена'
  const categoryRow=(category:Category)=><><i style={{background:category.color??'#a9afa5'}}/><button type="button" className="category-name" disabled={!online||reordering} onClick={()=>setEditing(category)}>{category.name}</button></>
  return <section className="page settings-page">
    <AccessSettings user={user} workspace={workspace} pendingCount={pendingCount} online={online} onSession={onSession} onNotice={accessNotice} onBusyChange={setAccessBusy}>
      <SettingsRow label="Категории" value={String(activeCategories.length)} onClick={()=>setSheet('categories')}/>
      <SettingsRow label="Теги" value={tags.length?String(tags.length):'нет'} onClick={()=>setSheet('tags')}/>
      <SettingsRow label="Карта Bybit" value={bybitValue} onClick={()=>setSheet('bybit')}/>
    </AccessSettings>
    <div className="settings-list" role="group" aria-labelledby="settings-device"><h2 id="settings-device">Этот телефон</h2><div className="settings-rows">
      <SettingsRow label="Тема" value={THEME_OPTIONS.find((option)=>option.value===theme)?.label} onClick={()=>setSheet('theme')}/>
      <SettingsRow label="Экспорт в CSV" onClick={()=>{try{setNotice(`Экспортировано расходов: ${exportHistoryCsv(bootstrap)}`)}catch{setNotice('Не удалось подготовить файл экспорта',undefined,true)}}}/>
      <SettingsRow label="Выйти" tone="danger" disabled={accessBusy||reordering} onClick={onLogout}/>
    </div></div>
    {sheet==='categories'&&<ListSheet title="Категории" onClose={()=>setSheet(null)}>
      {mainCategories.length>0&&<h3>На главном экране</h3>}
      <DragList items={mainCategories} disabled={!online||reordering} onReorder={(ids)=>void reorderGroup('main',ids)} render={categoryRow}/>
      {otherCategories.length>0&&<h3>{mainCategories.length?'За плиткой «Ещё»':'Категории'}</h3>}
      <DragList items={otherCategories} disabled={!online||reordering} onReorder={(ids)=>void reorderGroup('additional',ids)} render={categoryRow}/>
      {!activeCategories.length&&<p className="sheet-copy">Категорий пока нет.</p>}
      <p className="sheet-copy">{online?'Порядок меняется перетаскиванием за ≡. Скрытые категории остаются у старых расходов.':'Категории меняются только при подключении к сети.'}</p>
      <button type="button" className="primary sheet-action" disabled={!online} onClick={()=>setAdding(true)}>Новая категория</button>
    </ListSheet>}
    {sheet==='tags'&&<ListSheet title="Теги" onClose={()=>setSheet(null)}>
      <DragList items={tags} disabled={!online||reordering} onReorder={(ids)=>void reorderTagList(ids)} render={(tag)=><><i style={{background:tag.color??'#a9afa5'}}/><button type="button" className="category-name" disabled={!online||reordering} onClick={()=>setEditingTag(tag)}>{tag.name}</button></>}/>
      <p className="sheet-copy">{tags.length?'Тег — короткая пометка поверх категории, например «отпуск». Один расход может нести несколько тегов.':'Тегов пока нет. Тег — короткая пометка поверх категории, например «отпуск» или «вдвоём».'}</p>
      <button type="button" className="primary sheet-action" disabled={!online} onClick={()=>setAddingTag(true)}>Новый тег</button>
    </ListSheet>}
    {sheet==='bybit'&&<BybitSheet workspace={workspace} workspaceId={workspaceId} status={bybitStatus} online={online} onStatus={onBybitStatus} onSynced={onBybitSynced} onClose={()=>setSheet(null)}/>}
    {sheet==='theme'&&<SelectSheet title="Тема" value={theme} options={THEME_OPTIONS} searchable={false} onClose={()=>setSheet(null)} onSelect={(value)=>{setSheet(null);onThemeChange(value as ThemePreference)}}/>}
    {(editing||adding)&&<CategoryEditor category={editing} mainCount={mainCategories.length} onClose={()=>{setEditing(null);setAdding(false)}} onSave={save}/>}
    {(editingTag||addingTag)&&<TagEditor tag={editingTag} onClose={()=>{setEditingTag(null);setAddingTag(false)}} onSave={saveTag} onDelete={editingTag?()=>removeTag(editingTag):undefined}/>}
    {notice&&<Toast toast={notice} onDismiss={hideNotice}/>}
  </section>
}

// Редактор категории: вместо «Размещение: Основные / Дополнительные» — переключатель «Показывать на главном экране».
export function CategoryEditor({ category, mainCount, onClose, onSave }:{category:Category|null;mainCount:number;onClose:()=>void;onSave:(c:Category)=>Promise<void>}) {
  const now = new Date().toISOString()
  const [draft,setDraft]=useState<Category>(category||{id:crypto.randomUUID(),name:'',color:TAG_COLORS[0]!,placement:'additional',sortOrder:999,createdAt:now,updatedAt:now,archivedAt:null,version:1})
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
  const onMain=draft.placement==='main'
  const othersOnMain=mainCount-(category?.placement==='main'?1:0)
  return <><div className="sheet-backdrop" onMouseDown={()=>{if(!busy)onClose()}}><form ref={dialogRef as React.Ref<HTMLFormElement>} className="bottom-sheet editor" role="dialog" aria-modal="true" aria-labelledby="category-editor-title" noValidate onSubmit={(e)=>{e.preventDefault();void submit(draft)}} onMouseDown={(e)=>e.stopPropagation()}><div className="sheet-handle"/><div className="sheet-title"><h2 id="category-editor-title">{category?'Категория':'Новая категория'}</h2><button type="button" className="icon-button" data-dialog-initial-focus disabled={busy} aria-label="Закрыть" onClick={onClose}>×</button></div><label>Название<input maxLength={40} aria-invalid={Boolean(validation)} value={draft.name} onChange={(e)=>{setValidation('');setDraft({...draft,name:e.target.value})}}/></label>{validation&&<p className="form-error" role="alert">{validation}</p>}<fieldset><legend>Цвет</legend><div className="colors">{TAG_COLORS.map((color,index)=><button aria-label={`Цвет: ${TAG_COLOR_NAMES[index] ?? color}`} aria-pressed={draft.color===color} type="button" key={color} className={draft.color===color?'selected':''} style={{background:color}} onClick={()=>setDraft({...draft,color})}/>)}</div></fieldset><label className="switch-row"><span><b>Показывать на главном экране</b><small>{onMain?`Плиткой рядом с клавиатурой${othersOnMain>=3?' — уже тесно, плиток больше четырёх не помещается':''}`:'Иначе — за плиткой «Ещё»'}</small></span><input type="checkbox" role="switch" checked={onMain} disabled={busy} onChange={(e)=>setDraft({...draft,placement:e.target.checked?'main':'additional'})}/></label><button className="primary" disabled={busy}>{busy?'Сохраняем…':'Сохранить'}</button>{category&&<button type="button" className="danger-link" disabled={busy} onClick={()=>void (async()=>{if(await confirm({title:'Скрыть категорию?',message:'Она пропадёт из выбора, но останется у старых расходов.',confirmLabel:'Скрыть',danger:true}))await submit({...draft,archivedAt:new Date().toISOString()})})()}>Скрыть</button>}</form></div>{confirmation}</>
}
