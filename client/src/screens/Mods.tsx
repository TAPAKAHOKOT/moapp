import { useRef, useState } from 'react'
import { WorkspaceApiError as ApiError, addMod, connectBybitCard, removeMod, syncBybitCard, uploadTbankStatement } from '../workspace-api'
import type { BybitCardState, BybitCardStatus, BybitRegion, ModId, TbankStatementResult, WorkspaceMod } from '../types'
import { CardMark, ChevronIcon, ListSheet, Select, tap, useConfirm, useDialog } from '../ui'
import type { Confirm } from '../ui'
import { formatRelativeTime } from '../format'

/*
 * Моды — карты и банки, которые пространство подключает по желанию. Сервер знает только их номера,
 * названия и пояснения живут здесь. Добавить и убрать мод может любой участник: пространство общее.
 * Убранный мод не трогает разбор — неразобранные операции остаются, их разбирают или убирают люди.
 */
export const MOD_INFO: Record<ModId, { name: string; about: string; removal: { title: string; message: string } }> = {
  'bybit-card': {
    name: 'Карта Bybit',
    about: 'Платежи по карте сами приходят в разбор — останется выбрать категорию.',
    removal: { title: 'Убрать карту Bybit?', message: 'Ключ забудется, новые платежи перестанут приходить. Неразобранные операции останутся в разборе, записанные расходы — в истории.' },
  },
  tbank: {
    name: 'Выписка Т‑Банка',
    about: 'Выписку с tbank.ru загружают файлом — траты встают в разбор.',
    removal: { title: 'Убрать выписку Т‑Банка?', message: 'Загружать выписки станет нельзя, пока мод не добавят снова. Неразобранные траты останутся в разборе, записанные расходы — в истории.' },
  },
}

const askRemoval = (confirm: Confirm, id: ModId) => confirm({ ...MOD_INFO[id].removal, confirmLabel: 'Убрать', danger: true })

/* Одна строка о ключе Bybit: её видно и в списке модов, и в шторке карты. */
export function bybitStateLine(state: BybitCardState | null | undefined): string {
  if (!state) return 'Проверяем подключение…'
  if (!state.connected) return 'Не подключена'
  if (state.status === 'error') return 'Подключена · нужно обновить'
  return state.lastSyncedAt ? `Подключена · обновлено ${formatRelativeTime(state.lastSyncedAt)}` : 'Подключена'
}

export const bybitRegions: Array<{id:BybitRegion;label:string}> = [
  {id:'global',label:'Global / Serbia'}, {id:'eu',label:'European Union'}, {id:'kz',label:'Kazakhstan'},
  {id:'ge',label:'Georgia'}, {id:'ae',label:'UAE'}, {id:'tr',label:'Turkey'}, {id:'nl',label:'Netherlands'}, {id:'id',label:'Indonesia'},
]

// Карта Bybit в шите: одна строка состояния, одна главная кнопка, «Убрать мод» — текстом внизу. Ключ вставляет любой участник.
export function BybitSheet({ workspaceId, state, online, onStatus, onSynced=()=>{}, onRemove, onClose }: { workspaceId:string;state:BybitCardState|null;online:boolean;onStatus:(status:BybitCardStatus)=>void;onSynced?:()=>void;onRemove:()=>Promise<void>;onClose:()=>void }) {
  const [editing,setEditing]=useState(false)
  const [apiKey,setApiKey]=useState('')
  const [apiSecret,setApiSecret]=useState('')
  const [region,setRegion]=useState<BybitRegion>('global')
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const [feedback,setFeedback]=useState('')
  const {confirm,confirmation}=useConfirm()
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
  const remove=async()=>{
    if(!await askRemoval(confirm,'bybit-card'))return
    setBusy(true);setError('')
    try{await onRemove()}
    catch(reason){setError(reason instanceof ApiError?reason.message:'Не удалось убрать мод')}
    finally{setBusy(false)}
  }
  return <ListSheet title={MOD_INFO['bybit-card'].name} dismissible={!busy} onClose={onClose}>
    <div className="integration-title"><CardMark source="bybit-card"/><span><b>Bybit Card</b><small>{bybitStateLine(state)}</small></span>{state?.connected&&<i className={state.status==='error'?'error':'active'}/>}</div>
    {state?.connected?<>
      <p className="sheet-copy">Платежи попадают в историю начиная с {new Date(state.enabledAt!).toLocaleDateString('ru-RU',{day:'numeric',month:'long'})}. Более ранние не загружаются.</p>
      {state.lastError&&<p className="form-error" role="alert">{state.lastError}</p>}
      <button type="button" className="primary sheet-action" disabled={!online||busy} onClick={()=>void sync()}>{busy?'Обновляем…':'Обновить'}</button>
      {feedback&&<p className="inline-feedback" role="status">{feedback}</p>}
    </>:<>
      <p className="sheet-copy">Платежи по карте будут появляться в истории сами — останется выбрать категорию. Загружаются только платежи после подключения. Нужен отдельный ключ только для чтения с разрешением BitCard.</p>
      {!editing?<button type="button" className="primary sheet-action" disabled={!online||state===null||busy} onClick={()=>setEditing(true)}>Подключить</button>:<form className="integration-form" onSubmit={(event)=>void connect(event)}>
        <label>Регион аккаунта<Select label="Регион аккаунта" value={region} disabled={busy} onChange={(value)=>setRegion(value as BybitRegion)} options={bybitRegions.map((item)=>({value:item.id,label:item.label}))}/></label>
        {region==='eu'&&<small className="integration-meta">Для EU Bybit требует ключ, созданный через Connect to Third-Party Applications.</small>}
        <label>API key<input autoComplete="off" value={apiKey} disabled={busy} maxLength={256} onChange={(event)=>setApiKey(event.target.value)}/></label>
        <label>API secret<input type="password" autoComplete="new-password" value={apiSecret} disabled={busy} maxLength={512} onChange={(event)=>setApiSecret(event.target.value)}/></label>
        <button className="primary" disabled={busy||!online}>{busy?'Проверяем ключ…':'Подключить'}</button><button type="button" className="sheet-cancel" disabled={busy} onClick={()=>{setEditing(false);setError('')}}>Отмена</button>
      </form>}
    </>}
    {error&&<p className="form-error" role="alert">{error}</p>}
    {!editing&&<button type="button" className="danger-link sheet-action" disabled={!online||busy} onClick={()=>void remove()}>Убрать мод</button>}
    {confirmation}
  </ListSheet>
}

/* Выписка больше года‑двух операций — это сотни килобайт; сервер принимает до 8 МБ. */
const MAX_STATEMENT_BYTES = 8 * 1024 * 1024

/* Нынешняя выгрузка Т‑Банка в UTF‑8; старые файлы Тинькофф были в Windows‑1251 — их тоже читаем. */
export async function readStatementFile(file: File): Promise<string> {
  const bytes = await file.arrayBuffer()
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { return new TextDecoder('windows-1251').decode(bytes) }
}

export function statementFeedback(result: TbankStatementResult): string {
  const unread = result.skipped ? ` Не удалось прочитать строк: ${result.skipped}.` : ''
  if (result.imported) return `Новых трат: ${result.imported}${result.known ? ` · уже были: ${result.known}` : ''}.${unread}`
  return `${result.known ? 'Новых трат нет — всё уже загружено.' : 'В файле нет трат.'}${unread}`
}

/*
 * Т‑Банк не отдаёт операции личных карт по API, поэтому выписку загружают файлом. Траты встают в ту же
 * очередь разбора, что и у Bybit; то, что уже загружалось, узнаётся и не повторяется — периоды можно брать внахлёст.
 */
export function TbankSheet({ workspaceId, online, onImported, onOpenReview, onRemove, onClose }: { workspaceId:string;online:boolean;onImported:(result:TbankStatementResult)=>void;onOpenReview:()=>void;onRemove:()=>Promise<void>;onClose:()=>void }) {
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const [result,setResult]=useState<TbankStatementResult|null>(null)
  const inputRef=useRef<HTMLInputElement>(null)
  const {confirm,confirmation}=useConfirm()
  const upload=async(file:File)=>{
    setError('');setResult(null)
    if(file.size>MAX_STATEMENT_BYTES)return setError('Файл больше 8 МБ. Выгрузите период покороче.')
    setBusy(true)
    try{const next=await uploadTbankStatement(workspaceId,await readStatementFile(file));setResult(next);onImported(next);tap(8)}
    catch(reason){setError(reason instanceof ApiError?reason.message:'Не удалось загрузить выписку')}
    finally{setBusy(false)}
  }
  const remove=async()=>{
    if(!await askRemoval(confirm,'tbank'))return
    setBusy(true);setError('')
    try{await onRemove()}
    catch(reason){setError(reason instanceof ApiError?reason.message:'Не удалось убрать мод')}
    finally{setBusy(false)}
  }
  return <ListSheet title={MOD_INFO.tbank.name} dismissible={!busy} onClose={onClose}>
    <div className="integration-title"><CardMark source="tbank"/><span><b>Т‑Банк</b><small>Операции загружаются файлом</small></span></div>
    <p className="sheet-copy">На tbank.ru с компьютера: «Операции» → «Выгрузка операций» → CSV. Загрузите файл сюда — траты встанут в разбор. Периоды можно брать внахлёст: уже загруженное не повторится.</p>
    <input ref={inputRef} type="file" accept=".csv,text/csv" hidden onChange={(event)=>{const file=event.target.files?.[0];event.target.value='';if(file)void upload(file)}}/>
    {result?.imported
      ?<button type="button" className="primary sheet-action" onClick={()=>{onClose();onOpenReview()}}>Разобрать</button>
      :<button type="button" className="primary sheet-action" disabled={!online||busy} onClick={()=>inputRef.current?.click()}>{busy?'Загружаем…':'Выбрать файл'}</button>}
    {result&&<p className="inline-feedback" role="status">{statementFeedback(result)}</p>}
    {result?.imported?<button type="button" className="sheet-cancel sheet-action" disabled={!online||busy} onClick={()=>inputRef.current?.click()}>{busy?'Загружаем…':'Загрузить ещё файл'}</button>:null}
    {!online&&<p className="sheet-copy">Выписка загружается только при подключении к сети.</p>}
    {error&&<p className="form-error" role="alert">{error}</p>}
    <button type="button" className="danger-link sheet-action" disabled={!online||busy} onClick={()=>void remove()}>Убрать мод</button>
    {confirmation}
  </ListSheet>
}

/* Каталог — моды, которых в пространстве ещё нет. После «Добавить» сразу открывается шторка мода: подключить или загрузить. */
function ModCatalogSheet({ mods, online, onAdd, onClose }: { mods:WorkspaceMod[];online:boolean;onAdd:(id:ModId)=>Promise<void>;onClose:()=>void }) {
  const [busy,setBusy]=useState<ModId|null>(null)
  const [error,setError]=useState('')
  const available=mods.filter((mod)=>!mod.added)
  const add=async(id:ModId)=>{
    setBusy(id);setError('')
    try{await onAdd(id)}
    catch(reason){setError(reason instanceof ApiError?reason.message:'Не удалось добавить мод');setBusy(null)}
  }
  return <ListSheet title="Каталог модов" dismissible={!busy} onClose={onClose}>
    {available.map((mod)=><div className="mod-offer" key={mod.id}>
      <CardMark source={mod.id}/>
      <span><b>{MOD_INFO[mod.id].name}</b><small>{MOD_INFO[mod.id].about}</small></span>
      <button type="button" disabled={!online||Boolean(busy)} onClick={()=>void add(mod.id)}>{busy===mod.id?'Добавляем…':'Добавить'}</button>
    </div>)}
    {!available.length&&<p className="sheet-copy">Все моды уже добавлены.</p>}
    {!online&&<p className="sheet-copy">Моды добавляются только при подключении к сети.</p>}
    {error&&<p className="form-error" role="alert">{error}</p>}
  </ListSheet>
}

type ModSheet = ModId | 'catalog' | null

// Страница модов: добавленные моды строками, каждая открывает шторку своего мода; внизу — каталог.
export function ModsView({ workspaceId, mods, online, onMods, onBybitStatus, onBybitSynced=()=>{}, onStatementImported=()=>{}, onOpenReview=()=>{} }: { workspaceId:string;mods:WorkspaceMod[]|null;online:boolean;onMods:(mods:WorkspaceMod[])=>void;onBybitStatus:(status:BybitCardStatus)=>void;onBybitSynced?:()=>void;onStatementImported?:(pendingCount:number)=>void;onOpenReview?:()=>void }) {
  const [sheet,setSheet]=useState<ModSheet>(null)
  const added=mods?.filter((mod)=>mod.added)??[]
  const bybit=mods?.find((mod)=>mod.id==='bybit-card')
  const add=async(id:ModId)=>{onMods(await addMod(workspaceId,id));tap(6);setSheet(id)}
  const remove=async(id:ModId)=>{onMods(await removeMod(workspaceId,id));setSheet(null)}
  const status=(mod:WorkspaceMod)=>mod.id==='bybit-card'?bybitStateLine(mod.state):'Операции загружаются файлом'
  return <section className="page mods-page">
    <p className="mods-intro">Моды подключают карты и банки: их траты сами встают в разбор, останется выбрать категорию.</p>
    {mods===null
      ?<p className="management-state" role="status">{online?'Загружаем…':'Моды видны при подключении к сети.'}</p>
      :<>
        {added.length>0&&<div className="settings-list"><div className="settings-rows">{added.map((mod)=><button type="button" className="mod-row" key={mod.id} onClick={()=>{tap(4);setSheet(mod.id)}}>
          <CardMark source={mod.id}/>
          <span><b>{MOD_INFO[mod.id].name}</b><small className={mod.state?.status==='error'?'warn':undefined}>{status(mod)}</small></span>
          <ChevronIcon/>
        </button>)}</div></div>}
        {!added.length&&<p className="management-state">Модов пока нет.</p>}
        {added.length<mods.length&&<button type="button" className="primary mods-add" disabled={!online} onClick={()=>setSheet('catalog')}>Добавить мод</button>}
      </>}
    {sheet==='catalog'&&mods&&<ModCatalogSheet mods={mods} online={online} onAdd={add} onClose={()=>setSheet(null)}/>}
    {sheet==='bybit-card'&&<BybitSheet workspaceId={workspaceId} state={bybit?.state??null} online={online} onStatus={onBybitStatus} onSynced={onBybitSynced} onRemove={()=>remove('bybit-card')} onClose={()=>setSheet(null)}/>}
    {sheet==='tbank'&&<TbankSheet workspaceId={workspaceId} online={online} onImported={(result)=>onStatementImported(result.pendingCount)} onOpenReview={onOpenReview} onRemove={()=>remove('tbank')} onClose={()=>setSheet(null)}/>}
  </section>
}

/* Моды открываются отдельной страницей поверх вкладок, как разбор поверх истории. */
export function ModsOverlay({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const dialogRef = useDialog(onClose)
  return <div ref={dialogRef as React.Ref<HTMLDivElement>} className="review-overlay mods-overlay" role="dialog" aria-modal="true" aria-labelledby="mods-overlay-title">
    <header className="review-overlay-head"><button type="button" className="icon-button" data-dialog-initial-focus onClick={onClose} aria-label="Закрыть">×</button><h2 id="mods-overlay-title">Моды</h2><span/></header>
    {children}
  </div>
}
