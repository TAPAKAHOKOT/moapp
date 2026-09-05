import { useCallback, useEffect, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { WorkspaceApiError as ApiError, allowWorkspaceMutations, describeOutboxIssue, isLinkInvalid, legacyClaim, prepareInitialOrManualRecovery, prepareRecovery, previewDeviceLink, previewInvitation, previewRecovery } from '../workspace-api'
import { readOutbox } from '../workspace-offline'
import { AccessFlowError, acceptDeviceWithProbe, acceptInvitationWithProbe, createIdentityWithProbe, generateAttemptToken } from '../access-flow'
import { completeRecoverySafely, completeRotationSafely } from '../recovery-flow'
import type { AuthenticatedSession, CapabilityIntent, Expense, RecoveryPrepareResponse, SessionState, WorkspaceOutboxItem, WorkspaceSummary } from '../types'
import { isoToLocalInput } from '../utils'
import { copyText, useConfirm, useDialog, useOnlineStatus } from '../ui'
import { formatEntryDate, money } from '../format'
import type { Bootstrap } from '../format'

export function outboxActionLabel(type: WorkspaceOutboxItem['type']) {
  if(type==='createExpense')return 'Добавление расхода'
  if(type==='updateExpense')return 'Изменение расхода'
  return 'Удаление расхода'
}

export type IssueSummary = { amount: string | null; category: string; when: string; note: string }

export function describeExpenseLike(source: Partial<Pick<Expense, 'amountMinor' | 'currency' | 'categoryId' | 'note' | 'occurredAt'>>, bootstrap: Bootstrap): IssueSummary {
  return {
    amount: source.amountMinor !== undefined && source.currency ? money(source.amountMinor, source.currency, bootstrap.currencies) : null,
    category: bootstrap.categories.find((category) => category.id === source.categoryId)?.name ?? 'Категория не найдена',
    when: source.occurredAt ? formatEntryDate(isoToLocalInput(source.occurredAt)) : '',
    note: source.note ?? '',
  }
}

// Удаление несёт только id и версию, поэтому детали берём из локальной копии расхода или серверной версии.
export function summarizeOutboxItem(item: WorkspaceOutboxItem, bootstrap: Bootstrap): IssueSummary {
  const payload = item.payload as Partial<Pick<Expense, 'id' | 'amountMinor' | 'currency' | 'categoryId' | 'note' | 'occurredAt'>>
  if (payload.amountMinor !== undefined) return describeExpenseLike(payload, bootstrap)
  const source = bootstrap.expenses.find((expense) => expense.id === payload.id) ?? item.current
  return source ? describeExpenseLike(source, bootstrap) : { amount: null, category: '', when: '', note: '' }
}

export function retryLabel(item: WorkspaceOutboxItem) {
  if (item.status !== 'conflict') return 'Отправить ещё раз'
  return item.type === 'deleteExpense' ? 'Удалить всё равно' : 'Сохранить мою версию'
}

export const isOutboxIssue = (item: WorkspaceOutboxItem) => item.status === 'conflict' || item.status === 'failed'

export function SyncIssuesSheet({ userId, workspaceId, bootstrap, online, onClose, onRetry, onDiscard }: { userId: string; workspaceId: string; bootstrap: Bootstrap; online: boolean; onClose: () => void; onRetry: (operationId: string) => Promise<string | null>; onDiscard: (operationIds?: string[]) => Promise<void> }) {
  const [items,setItems]=useState<WorkspaceOutboxItem[]>([])
  const [loading,setLoading]=useState(true)
  const [busy,setBusy]=useState<string|null>(null)
  const [error,setError]=useState('')
  const [notice,setNotice]=useState('')
  const dialogRef=useDialog(onClose,busy===null)
  const {confirm,confirmation}=useConfirm()
  const reload=useCallback(async()=>{
    try{const all=await readOutbox(userId,workspaceId);setItems(all.filter(isOutboxIssue).sort((left,right)=>left.createdAt.localeCompare(right.createdAt)))}
    catch{setError('Не удалось прочитать очередь отправки.')}
    finally{setLoading(false)}
  },[userId,workspaceId])
  useEffect(()=>{void reload()},[reload])
  const retry=async(item:WorkspaceOutboxItem)=>{
    setBusy(item.operationId);setError('');setNotice('')
    try{const message=await onRetry(item.operationId);if(message)setNotice(message)}
    catch(reason){setError(reason instanceof Error?reason.message:'Не удалось отправить изменение')}
    finally{await reload();setBusy(null)}
  }
  const discardOne=async(item:WorkspaceOutboxItem)=>{
    if(!await confirm({title:'Отменить это изменение?',message:'Ваша версия расхода удалится, останется та, что на сервере.',confirmLabel:'Отменить изменение',danger:true}))return
    setBusy(item.operationId);setError('');setNotice('')
    try{await onDiscard([item.operationId]);setNotice('Изменение отменено, показана версия с сервера.')}
    catch(reason){setError(reason instanceof Error?reason.message:'Не удалось отменить изменение')}
    finally{await reload();setBusy(null)}
  }
  const discardAll=async()=>{
    if(!await confirm({title:'Отменить все проблемные изменения?',message:'Ваши версии этих расходов удалятся, останутся те, что на сервере.',confirmLabel:'Отменить изменения',danger:true}))return
    setBusy('all');setError('');setNotice('')
    try{await onDiscard()}
    catch(reason){setError(reason instanceof Error?reason.message:'Не удалось очистить проблемные изменения');await reload();setBusy(null)}
  }
  return <><div className="sheet-backdrop" onMouseDown={()=>{if(busy===null)onClose()}}><section ref={dialogRef} className="bottom-sheet sync-issues-sheet" role="dialog" aria-modal="true" aria-labelledby="sync-issues-title" onMouseDown={(event)=>event.stopPropagation()}>
    <div className="sheet-handle"/><div className="sheet-title"><h2 id="sync-issues-title">Не отправлено</h2><button type="button" className="icon-button" data-dialog-initial-focus disabled={busy!==null} onClick={onClose} aria-label="Закрыть">×</button></div>
    <p>Эти изменения остались только на этом телефоне: сервер их не принял. Их можно отправить ещё раз или отменить — тогда вернётся версия с сервера.</p>
    {loading&&<p className="management-state" role="status">Проверяем очередь…</p>}
    <div className="sync-issue-list">{items.map((item)=>{
      const summary=summarizeOutboxItem(item,bootstrap)
      const server=item.current&&item.type!=='createExpense'?describeExpenseLike(item.current,bootstrap):null
      const itemBusy=busy===item.operationId
      return <div key={item.operationId} className="sync-issue">
        <div className="sync-issue-head"><b>{outboxActionLabel(item.type)}</b><small>{new Date(item.createdAt).toLocaleString('ru-RU',{dateStyle:'short',timeStyle:'short'})}</small></div>
        {summary.amount&&<div className="sync-issue-expense"><strong>{summary.amount}</strong><span>{summary.category}{summary.when?` · ${summary.when}`:''}{summary.note?` · ${summary.note}`:''}</span></div>}
        <p className="sync-issue-reason">{describeOutboxIssue(item)}</p>
        {server&&<p className="sync-issue-server">На сервере сейчас: {item.current?.deletedAt?'расход удалён':`${server.amount ?? '—'} · ${server.category}${server.when?` · ${server.when}`:''}`}</p>}
        <div className="sync-issue-actions"><button type="button" className="primary" disabled={!online||busy!==null} onClick={()=>void retry(item)}>{itemBusy?'Отправляем…':retryLabel(item)}</button><button type="button" className="sheet-cancel" disabled={!online||busy!==null} onClick={()=>void discardOne(item)}>Отменить</button></div>
      </div>})}</div>
    {!loading&&!items.length&&!error&&<p className="management-state" role="status">Проблемных изменений уже нет.</p>}
    {notice&&<p className="management-state" role="status">{notice}</p>}
    {!online&&<p className="form-error" role="status">Подключитесь к интернету, чтобы отправить или отменить изменения.</p>}
    {error&&<p className="form-error" role="alert">{error}</p>}
    {items.length>1&&<button type="button" className="danger-link" disabled={!online||busy!==null||loading} onClick={()=>void discardAll()}>{busy==='all'?'Обновляем…':'Отменить все'}</button>}
    <button type="button" className="sheet-cancel" disabled={busy!==null} onClick={onClose}>Закрыть</button>
  </section></div>{confirmation}</>
}

export function CreateWorkspaceSheet({ existing, onClose, onCreate }: { existing: boolean; onClose: () => void; onCreate: (id: string, name: string, displayName?: string) => Promise<void> }) {
  const [name,setName]=useState(''); const [displayName,setDisplayName]=useState(''); const [busy,setBusy]=useState(false); const [validation,setValidation]=useState('')
  const stableId = useRef(crypto.randomUUID())
  const dialogRef=useDialog(onClose,!busy)
  const submit=()=>{if(!name.trim()||!existing&&!displayName.trim()){setValidation(!existing&&!displayName.trim()?'Введите ваше имя.':'Введите название пространства.');return}setValidation('');setBusy(true);void onCreate(stableId.current,name.trim(),existing?undefined:displayName.trim()).finally(()=>setBusy(false))}
  return <div className="sheet-backdrop" onMouseDown={()=>{if(!busy)onClose()}}><form ref={dialogRef as React.Ref<HTMLFormElement>} className="bottom-sheet editor" role="dialog" aria-modal="true" aria-labelledby="create-workspace-title" noValidate onMouseDown={(event)=>event.stopPropagation()} onSubmit={(event)=>{event.preventDefault();submit()}}><div className="sheet-handle"/><div className="sheet-title"><h2 id="create-workspace-title">Создать пространство</h2><button type="button" className="icon-button" data-dialog-initial-focus disabled={busy} aria-label="Закрыть" onClick={onClose}>×</button></div>{!existing&&<label>Как вас называть<input maxLength={80} placeholder="Например, Ваня" aria-invalid={Boolean(validation&&!displayName.trim())} value={displayName} onChange={(event)=>{setValidation('');setDisplayName(event.target.value)}}/></label>}<label>Название пространства<input maxLength={80} placeholder="Например, Дом или Поездка" aria-invalid={Boolean(validation&&!name.trim())} value={name} onChange={(event)=>{setValidation('');setName(event.target.value)}}/></label>{validation&&<p className="form-error" role="alert">{validation}</p>}<button className="primary" disabled={busy}>{busy?'Создаём…':'Создать пространство'}</button><button type="button" className="sheet-cancel" disabled={busy} onClick={onClose}>Отмена</button></form></div>
}

export function WorkspaceSwitcher({ items, active, runtimes, online = navigator.onLine, onSelect, onCreate }: { items: WorkspaceSummary[]; active: string; runtimes: Record<string, import('../types').WorkspaceRuntime>; online?: boolean; onSelect: (id: string) => void; onCreate: () => void }) {
  const close=()=>onSelect(active)
  const dialogRef=useDialog(close)
  return <div className="sheet-backdrop" onMouseDown={close}><section ref={dialogRef} className="bottom-sheet" role="dialog" aria-modal="true" aria-labelledby="workspace-switcher-title" onMouseDown={(event)=>event.stopPropagation()}><div className="sheet-handle"/><div className="sheet-title"><h2 id="workspace-switcher-title">Пространства</h2><button type="button" className="icon-button" onClick={close} aria-label="Закрыть">×</button></div>{items.map((item)=>{const runtime=runtimes[item.id];const disabled=!online&&!runtime?.bootstrap;return <button type="button" data-dialog-initial-focus={item.id===active||undefined} aria-pressed={item.id===active} className="workspace-option" key={item.id} disabled={disabled} onClick={()=>onSelect(item.id)}><span>{item.name}<small>{item.role==='owner'?'Владелец':'Участник'} {runtime?.outbox.total?`· ${runtime.outbox.total} ждут`:''}</small></span>{item.id===active?'✓':disabled?'Нет офлайн-кэша':''}</button>})}<button type="button" className="primary" disabled={!online} onClick={onCreate}>Создать пространство</button></section></div>
}

// Ссылка доступа — единственный способ вернуться к расходам без этого телефона. Одно действие: поделиться или
// скопировать; после удачного сохранения ссылка подтверждается сама, а «сохранено» сообщает тост у родителя.
// Сырой URL показывается только когда ни копирование, ни системное меню не сработали.
export function RecoverySave({ prepared, complete, close, allowLater = true, mode = 'initial' }: { prepared: RecoveryPrepareResponse; complete: () => Promise<void | boolean>; close: () => void; allowLater?: boolean; mode?: 'initial' | 'rotation' | 'public' }) {
  const [busy,setBusy]=useState(false); const [error,setError]=useState(''); const [feedback,setFeedback]=useState(''); const [feedbackError,setFeedbackError]=useState(false); const [savedOnce,setSavedOnce]=useState(false)
  const dialogRef=useDialog(close,allowLater&&!busy)
  const canShare=typeof navigator.share==='function'
  const finish = async () => {
    setBusy(true); setError('')
    try {
      const done = await complete()
      if (done !== false) close()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось подтвердить. Ссылка остаётся на экране — не закрывайте его.')
    } finally { setBusy(false) }
  }
  const copyRecovery=async()=>{
    try{await copyText(prepared.recoveryUrl);setFeedbackError(false);setFeedback('Ссылка скопирована');setSavedOnce(true)}
    catch(reason){setFeedbackError(true);setFeedback(reason instanceof Error?reason.message:'Не удалось скопировать ссылку');return}
    await finish()
  }
  const shareRecovery=async()=>{
    if(!canShare){await copyRecovery();return}
    try{await navigator.share({title:'Ссылка доступа moapp',url:prepared.recoveryUrl});setFeedbackError(false);setFeedback('');setSavedOnce(true)}
    catch(reason){if(!(reason instanceof DOMException&&reason.name==='AbortError')){setFeedbackError(true);setFeedback('Не удалось поделиться ссылкой')}return}
    await finish()
  }
  const warning = mode === 'initial'
    ? 'Это единственный способ вернуться к расходам, если телефон потеряется. Отправьте её себе в Заметки или в менеджер паролей: показать эту ссылку снова будет нельзя — только заменить новой. Любой, у кого она есть, получит полный доступ.'
    : mode === 'public'
      ? 'Сохраните новую ссылку прежде чем продолжить: старая перестанет работать, а все прежние устройства будут отключены.'
      : 'Старая ссылка сразу перестанет работать. Любой, у кого есть новая, получит полный доступ.'
  return <div className="sheet-backdrop" onMouseDown={()=>{if(allowLater&&!busy)close()}}><section ref={dialogRef} className="bottom-sheet access-sheet" role="dialog" aria-modal="true" aria-labelledby="recovery-save-title" onMouseDown={(event)=>event.stopPropagation()}>
    <div className="sheet-handle"/><h2 id="recovery-save-title">Сохраните ссылку доступа</h2><p className="sheet-copy">{warning}</p>
    <div className="qr"><QRCodeSVG value={prepared.recoveryUrl} size={150}/></div>
    {(feedbackError||error)&&<code className="access-link">{prepared.recoveryUrl}</code>}
    {feedback&&<p className="inline-feedback" role={feedbackError?'alert':'status'}>{feedback}</p>}
    {error&&<p className="form-error" role="alert">{error}</p>}
    {canShare
      ? <><button type="button" className="primary" data-dialog-initial-focus disabled={busy} onClick={()=>void shareRecovery()}>{busy?'Подтверждаем…':'Поделиться'}</button><button type="button" className="sheet-cancel" disabled={busy} onClick={()=>void copyRecovery()}>Скопировать</button></>
      : <button type="button" className="primary" data-dialog-initial-focus disabled={busy} onClick={()=>void copyRecovery()}>{busy?'Подтверждаем…':'Скопировать'}</button>}
    {error&&savedOnce&&<button type="button" className="sheet-cancel" disabled={busy} onClick={()=>void finish()}>Повторить</button>}
    {allowLater&&<button type="button" className="sheet-cancel" disabled={busy} onClick={close}>Позже</button>}
  </section></div>
}

export function LegacyClaimFlow({ hydrate, cancel }: { hydrate: (session: SessionState) => Promise<void>; cancel: () => void }) {
  const [name,setName]=useState(''); const [pin,setPin]=useState(''); const [busy,setBusy]=useState(false); const [error,setError]=useState(''); const attempt=useRef<string>(generateAttemptToken())
  const claim=async(event: React.FormEvent)=>{event.preventDefault();if(!name.trim()||!pin.trim()){setError(!name.trim()?'Введите ваше имя.':'Введите общий PIN.');return}setBusy(true);setError('');try{await hydrate(await legacyClaim(pin,name.trim(),attempt.current))}catch(reason){setError(reason instanceof ApiError&&reason.code==='CLAIM_IN_PROGRESS'?'Перенос уже выполняется в другой вкладке.':'PIN не подошёл или попытка временно ограничена.')}finally{setBusy(false)}}
  return <main className="empty-state"><div className="brand-mark">m</div><p className="eyebrow">Существующие расходы</p><h1>Перенести данные</h1><p>Укажите имя и действующий общий PIN. Затем нужно будет сохранить ссылку доступа.</p><form noValidate onSubmit={claim}><label>Ваше имя<input aria-invalid={Boolean(error&&!name.trim())} value={name} onChange={(event)=>{setError('');setName(event.target.value)}}/></label><label>Общий PIN<input aria-invalid={Boolean(error&&!pin.trim())} type="password" value={pin} onChange={(event)=>{setError('');setPin(event.target.value)}}/></label>{error&&<p className="form-error" role="alert">{error}</p>}<button className="primary" disabled={busy}>{busy?'Проверяем…':'Продолжить'}</button><button type="button" className="sheet-cancel" disabled={busy} onClick={cancel}>Назад</button></form></main>
}

export function RestrictedRecovery({ session, hydrate }: { session: AuthenticatedSession; hydrate: (session: SessionState) => Promise<void> }) {
  const [prepared,setPrepared]=useState<RecoveryPrepareResponse|null>(null); const [publicRecovery,setPublicRecovery]=useState(false); const [error,setError]=useState(''); const started=useRef(false)
  useEffect(()=>{if(started.current)return;started.current=true;void prepareInitialOrManualRecovery().then(setPrepared,(reason)=>setError(reason instanceof ApiError?reason.message:'Не удалось подготовить ссылку доступа'))},[])
  if(prepared)return <RecoverySave key={prepared.completionToken} prepared={prepared} mode={publicRecovery?'public':'initial'} allowLater={false} close={()=>{}} complete={async()=>{
    const outcome=publicRecovery
      ?await completeRecoverySafely({prepared,targetUserId:session.user.id})
      :await completeRotationSafely({prepared,targetUserId:session.user.id})
    if(outcome.status==='completed'){await hydrate(outcome.session);return}
    if(outcome.status==='replacement-active-needs-recovery'){
      setPrepared(await prepareRecovery(outcome.replacementToken));setPublicRecovery(true);return false
    }
    throw new Error(outcome.status==='rotation-stale'?'Параллельно была сохранена другая ссылка доступа.':'Не удалось подтвердить ссылку. Не закрывайте экран и повторите попытку.')
  }}/>
  return <main className="empty-state"><div className="brand-mark">m</div><h1>Сохраните ссылку доступа</h1><p role={error?'alert':'status'}>{error||'Готовим ссылку доступа…'}</p></main>
}

export function CapabilityScreen({ intent, session, knownUserId, finish, close, resolveIdentityConflict }: {
  intent: CapabilityIntent
  session: SessionState | null
  knownUserId: string | null
  finish: (session: SessionState, workspaceId?: string) => Promise<void>
  close: () => void
  resolveIdentityConflict: (targetUserId: string | null) => Promise<void>
}) {
  const [copy,setCopy]=useState('Проверяем ссылку…')
  const [name,setName]=useState('')
  const [error,setError]=useState('')
  const [ready,setReady]=useState(false)
  const [busy,setBusy]=useState(false)
  const [conflict,setConflict]=useState(false)
  const [targetUserId,setTargetUserId]=useState<string|null>(null)
  const [workspaceTarget,setWorkspaceTarget]=useState<string|null>(null)
  const [prepared,setPrepared]=useState<RecoveryPrepareResponse|null>(null)
  const online=useOnlineStatus()
  const {confirm,confirmation}=useConfirm()
  const attempt=useRef(generateAttemptToken())
  const activeUserId=session?.authenticated?session.user.id:knownUserId
  const sessionKey=session?.authenticated?`${session.user.id}:${session.currentSessionId}`:'guest'

  useEffect(()=>{
    let active=true
    setReady(false);setError('');setConflict(false);setTargetUserId(null);setWorkspaceTarget(null)
    const preview=async()=>{
      try{
        if(intent.kind==='invite'){
          const value=await previewInvitation(intent.token)
          if(!active)return
          setWorkspaceTarget(value.workspace.id);setCopy(`Присоединиться к «${value.workspace.name}»`)
          if(knownUserId&&!session?.authenticated){setConflict(true);setError('На этом телефоне уже есть другой профиль. Сначала войдите в него по ссылке доступа или удалите его данные.')}
        }else if(intent.kind==='device'){
          const value=await previewDeviceLink(intent.token)
          if(!active)return
          setTargetUserId(value.targetUserId);setCopy(`Подключить устройство к профилю «${value.displayName}»`)
          if(activeUserId&&activeUserId!==value.targetUserId){setConflict(true);setError('Ссылка от другого профиля. Чтобы продолжить, нужно выйти из текущего — его данные удалятся с этого телефона.')}
        }else{
          const value=await previewRecovery(intent.token)
          if(!active)return
          setTargetUserId(value.targetUserId);setCopy(`Вернуть доступ к профилю «${value.displayName}»`)
          if(activeUserId&&activeUserId!==value.targetUserId){setConflict(true);setError('Ссылка от другого профиля. Чтобы продолжить, нужно выйти из текущего — его данные удалятся с этого телефона.')}
        }
        if(active)setReady(true)
      }catch(reason){
        if(!active)return
        if(reason instanceof ApiError&&reason.code==='IDENTITY_CONFLICT'){
          setConflict(true);setError('Ссылка от другого профиля. Чтобы продолжить, нужно выйти из текущего.')
        }else setError(reason instanceof ApiError&&isLinkInvalid(reason)?'Ссылка недействительна или больше не действует.':'Не удалось проверить ссылку.')
      }
    }
    void preview()
    return()=>{active=false}
  },[activeUserId,intent,knownUserId,session?.authenticated,sessionKey])

  const proceed=async()=>{
    if(!ready||busy||conflict)return
    setBusy(true);setError('')
    try{
      if(intent.kind==='invite'){
        if(!workspaceTarget)throw new Error('Не удалось определить пространство')
        let current=session
        if(!current?.authenticated){current=await createIdentityWithProbe(name);allowWorkspaceMutations()}
        const accepted=await acceptInvitationWithProbe(intent.token,workspaceTarget)
        await finish(accepted,workspaceTarget)
        return
      }
      if(intent.kind==='device'){
        if(!targetUserId)throw new Error('Не удалось определить профиль')
        await finish(await acceptDeviceWithProbe(intent.token,attempt.current,targetUserId))
        return
      }
      if(!targetUserId)throw new Error('Не удалось определить профиль')
      setPrepared(await prepareRecovery(intent.token))
    }catch(reason){
      if((reason instanceof ApiError&&reason.code==='IDENTITY_CONFLICT')||(reason instanceof AccessFlowError&&reason.code==='IDENTITY_CONFLICT')){
        setConflict(true);setError('Ссылка от другого профиля. Чтобы продолжить, нужно выйти из текущего.')
      }else setError(reason instanceof ApiError||reason instanceof Error?reason.message:'Не удалось продолжить')
    }
    finally{setBusy(false)}
  }

  const completePublicRecovery=async():Promise<void|boolean>=>{
    if(!prepared||!targetUserId)return false
    const outcome=await completeRecoverySafely({prepared,targetUserId})
    if(outcome.status==='completed'){await finish(outcome.session);return}
    if(outcome.status==='replacement-active-needs-recovery'){
      const next=await prepareRecovery(outcome.replacementToken)
      setPrepared(next)
      setError('Ответ сервера потерялся. Сохраните показанную новую ссылку и подтвердите её ещё раз.')
      return false
    }
    if(outcome.status==='rotation-stale')throw new Error('Параллельно была завершена другая замена ссылки. Используйте последнюю подтверждённую ссылку.')
    throw new Error('Не удалось подтвердить ссылку. Не удаляйте показанную и повторите с активного устройства.')
  }

  if(prepared)return <RecoverySave key={prepared.completionToken} prepared={prepared} mode="public" allowLater={false} close={close} complete={completePublicRecovery}/>
  return <><main className="empty-state"><div className="brand-mark">m</div><p className="eyebrow">Безопасная ссылка</p><h1>{intent.kind==='invite'?'Приглашение':intent.kind==='device'?'Новое устройство':'Ссылка доступа'}</h1><p>{error||copy}</p>
    {intent.kind==='invite'&&!session?.authenticated&&!conflict&&<label>Как вас называть<input placeholder="Например, Ваня" aria-invalid={Boolean(error&&!name.trim())} value={name} onChange={(event)=>{setError('');setName(event.target.value)}}/></label>}
    {conflict?<button type="button" className="primary danger" disabled={!online||busy} onClick={()=>void (async()=>{if(!await confirm({title:'Выйти из текущего профиля?',message:'Его данные удалятся с этого телефона.',confirmLabel:'Выйти и продолжить',danger:true}))return;setBusy(true);void resolveIdentityConflict(targetUserId).catch((reason)=>setError(reason instanceof Error?reason.message:'Не удалось выйти')).finally(()=>setBusy(false))})()}>{busy?'Выходим…':'Выйти и продолжить'}</button>:<button type="button" className="primary" disabled={!ready||busy||intent.kind==='invite'&&!session?.authenticated&&!name.trim()} onClick={()=>void proceed()}>{busy?'Проверяем…':intent.kind==='invite'?'Присоединиться':intent.kind==='device'?'Подключить':'Вернуть доступ'}</button>}
    <button className="sheet-cancel" disabled={busy} onClick={close}>Закрыть</button>
  </main>{confirmation}</>
}
