import { useEffect, useRef, useState } from 'react'
import { WorkspaceApiError as ApiError, classifyBybitCardTransaction, ignoreBybitCardTransaction, listBybitCardTransactions, undoBybitCardTransaction } from '../workspace-api'
import type { BybitCardStatus, BybitCardTransaction, Category, Currency, Expense, Tag } from '../types'
import { Toast, tap, useConfirm, useDialog, useToast } from '../ui'
import { amountNumber, amountSize } from '../format'
import { ExtrasRow, NoteSheet, TAG_COLORS, createTagOrReuse } from '../tags'
import { CategorySheet, CategoryTiles, saveButtonLabel } from './Entry'

export type ReviewAction={transaction:BybitCardTransaction;expense?:Expense;categoryId?:string;comment:string;tagIds:string[]}

export function BybitReviewView({ workspaceId, categories, currencies, tags=[], onTag=()=>{}, online, onExpense, onExpenseUndo, onStatus, pendingCount=0, active=true }: {workspaceId:string;categories:Category[];currencies:Currency[];tags?:Tag[];onTag?:(tag:Tag)=>void;online:boolean;onExpense:(expense:Expense)=>void;onExpenseUndo:(expenseId:string)=>void;onStatus:(status:Partial<BybitCardStatus>&Pick<BybitCardStatus,'pendingCount'>)=>void;pendingCount?:number;active?:boolean}) {
  const [items,setItems]=useState<BybitCardTransaction[]>([])
  const [comment,setComment]=useState('')
  const [noteSheet,setNoteSheet]=useState(false)
  const [selectedCategoryId,setSelectedCategoryId]=useState<string|null>(null)
  const [categorySheet,setCategorySheet]=useState(false)
  const [selectedTagIds,setSelectedTagIds]=useState<string[]>([])
  const [loading,setLoading]=useState(true)
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const {toast:notice,notify,dismiss}=useToast()
  const {confirm,confirmation}=useConfirm()
  const current=items[0]
  // Ряд категорий повторяет расход: основные плитками, остальные — в шите за «Ещё N».
  const main=categories.filter((item)=>!item.archivedAt&&item.placement==='main').sort((a,b)=>a.sortOrder-b.sortOrder)
  const additional=categories.filter((item)=>!item.archivedAt&&item.placement==='additional').sort((a,b)=>a.sortOrder-b.sortOrder)
  useEffect(()=>{const controller=new AbortController();setLoading(true);listBybitCardTransactions(workspaceId,controller.signal).then((result)=>{setItems(result.transactions);onStatus({pendingCount:result.pendingCount})}).catch((reason)=>{if(!controller.signal.aborted)setError(reason instanceof ApiError?reason.message:'Не удалось загрузить операции')}).finally(()=>{if(!controller.signal.aborted)setLoading(false)});return()=>controller.abort()},[workspaceId]) // eslint-disable-line react-hooks/exhaustive-deps
  // A sync elsewhere (Settings, the server scheduler) can add or settle items while this view is mounted.
  // Re-read the queue when the tab is opened or the known count outgrows what is loaded, merging so the
  // item under review, the local order and the draft note survive; only the server's newest state wins per item.
  const refreshing=useRef(false)
  useEffect(()=>{
    if(loading||busy||!online||!active||refreshing.current)return
    const controller=new AbortController();refreshing.current=true
    listBybitCardTransactions(workspaceId,controller.signal).then((result)=>{
      if(controller.signal.aborted)return
      const fresh=new Map(result.transactions.map((item)=>[item.id,item]))
      setItems((value)=>{const kept=value.filter((item)=>fresh.has(item.id)).map((item)=>fresh.get(item.id)!);const seen=new Set(kept.map((item)=>item.id));return [...kept,...result.transactions.filter((item)=>!seen.has(item.id))]})
      onStatus({pendingCount:result.pendingCount})
    }).catch(()=>{/* the queue already on screen stays usable; the next trigger retries */}).finally(()=>{refreshing.current=false})
    return()=>{controller.abort();refreshing.current=false}
  },[active,pendingCount,workspaceId]) // eslint-disable-line react-hooks/exhaustive-deps
  const resetDraft=()=>{setComment('');setSelectedCategoryId(null);setSelectedTagIds([]);setCategorySheet(false);setNoteSheet(false)}
  const removeCurrent=(transaction:BybitCardTransaction,pendingCount:number)=>{setItems((value)=>value.filter((item)=>item.id!==transaction.id));resetDraft();onStatus({pendingCount})}
  const undo=async(action:ReviewAction)=>{
    if(busy||!online)return;setBusy(true);setError('')
    try{const result=await undoBybitCardTransaction(workspaceId,action.transaction.id,action.expense);if(result.undoneExpenseId)onExpenseUndo(result.undoneExpenseId);setItems((value)=>[result.transaction,...value.filter((item)=>item.id!==result.transaction.id)]);setComment(action.comment);setSelectedCategoryId(action.categoryId??null);setSelectedTagIds(action.tagIds);onStatus({pendingCount:result.pendingCount});tap(6)}
    catch(reason){setError(reason instanceof ApiError?reason.message:'Не удалось отменить последнее действие')}
    finally{setBusy(false)}
  }
  const classify=async(categoryId:string)=>{
    if(!current||busy||!online)return;const transaction=current;const action:ReviewAction={transaction,categoryId,comment,tagIds:selectedTagIds};setSelectedCategoryId(categoryId);setBusy(true);setError('')
    try{const result=await classifyBybitCardTransaction(workspaceId,transaction.id,categoryId,comment,selectedTagIds);action.expense=result.expense;onExpense(result.expense);removeCurrent(transaction,result.pendingCount);notify('Расход добавлен',{label:'Отменить',run:()=>void undo(action)});tap(8)}
    catch(reason){setError(reason instanceof ApiError?reason.message:'Не удалось сохранить расход')}
    finally{setBusy(false)}
  }
  const ignore=async()=>{
    if(!current||busy||!online||!await confirm({title:'Это не расход?',message:'Операция исчезнет из очереди и не попадёт в историю. Сразу после этого её можно вернуть.',confirmLabel:'Это не расход',danger:true}))return
    const transaction=current;const action:ReviewAction={transaction,comment,categoryId:selectedCategoryId??undefined,tagIds:selectedTagIds};setBusy(true);setError('');try{const result=await ignoreBybitCardTransaction(workspaceId,transaction.id);removeCurrent(transaction,result.pendingCount);notify('Операция не записана как расход',{label:'Вернуть',run:()=>void undo(action)})}catch(reason){setError(reason instanceof ApiError?reason.message:'Не удалось пропустить операцию')}finally{setBusy(false)}
  }
  // «Пропустить» просто ставит операцию в конец очереди: отдельного понятия «отложено» нет.
  const skip=()=>{if(!current||busy||items.length<2)return;setItems((value)=>[...value.slice(1),value[0]!]);resetDraft();tap(5)}
  const save=current?saveButtonLabel({amount:String(current.amountMinor/10**(currencies.find((item)=>item.code===current.currency)?.decimals??2)),currency:current.currency,categoryId:selectedCategoryId,editing:false,dirty:true,currencies}):null
  return <><section className="page bybit-review-page" aria-labelledby="bybit-review-title">
    <h1 className="sr-only" id="bybit-review-title">Операции с карты Bybit</h1>
    {loading?<p className="management-state" role="status">Загружаем операции…</p>:current?(()=>{const amountText=amountNumber(current.amountMinor,current.currency,currencies);return <>
      <header className="topline review-topline"><div><p className="eyebrow">В очереди · {items.length}</p><p className="review-date">{new Date(current.occurredAt).toLocaleString('ru-RU',{weekday:'short',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'})}</p></div></header>
      <div className="amount-row"><output className="amount-value" data-size={amountSize(amountText)} aria-label="Сумма">{amountText}</output><span className="review-currency">{current.currency}</span></div>
      <div className="review-scroll">
      {/* Мерчант и предупреждение делят слот постоянной высоты: очередь разбирают пачкой, и
          кнопка сохранения не должна ездить от операции к операции. */}
      <div className="review-operation">
        <article className="review-merchant">
          <span className="bybit-mark">B</span><div><h3>{current.merchantName||'Без названия продавца'}</h3><p>{current.type==='atm'?'Снятие наличных':current.merchantCategory||'Покупка'}{current.merchantCity?` · ${[current.merchantCity,current.merchantCountry].filter(Boolean).join(', ')}`:''}</p></div>
        </article>
        {!current.settled&&<p className="review-pending-note">Ожидает списания · сумма может уточниться после расчёта</p>}
      </div>
      <CategoryTiles main={main} additional={additional} selectedId={selectedCategoryId} disabled={busy} onPick={(category)=>{tap(6);setSelectedCategoryId(category.id);setCategorySheet(false)}} onMore={()=>setCategorySheet(true)}/>
      <ExtrasRow tags={tags} selected={selectedTagIds} note={comment} disabled={busy} online={online} onChange={setSelectedTagIds} onNote={()=>setNoteSheet(true)} onCreate={(name)=>createTagOrReuse(workspaceId,name,TAG_COLORS[tags.length%TAG_COLORS.length]??null,onTag)}/>
      </div>
      <button type="button" className="primary review-save" disabled={busy||!online||!save?.canSave} onClick={()=>{if(selectedCategoryId)void classify(selectedCategoryId)}}>{busy?'Сохраняем…':save?.label}</button>
      <div className="review-secondary"><button type="button" disabled={busy||items.length<2} onClick={skip}>Пропустить</button><button type="button" disabled={busy||!online} onClick={()=>void ignore()}>Это не расход</button></div>
      {categorySheet&&<CategorySheet categories={additional} selectedId={selectedCategoryId??undefined} onClose={()=>setCategorySheet(false)} onPick={(category)=>{setSelectedCategoryId(category.id);setCategorySheet(false)}}/>}
      {noteSheet&&<NoteSheet value={comment} onClose={()=>setNoteSheet(false)} onSave={(note)=>{setComment(note);setNoteSheet(false)}}/>}
    </>})():<div className="review-done"><span>✓</span><h3>Всё разобрано</h3><p>Новые операции появятся после следующего обновления.</p></div>}
    {!online&&<p className="management-state" role="status">Без сети можно только просматривать операции. Категория сохранится после подключения.</p>}
    {error&&<p className="form-error" role="alert">{error}</p>}
  </section>{notice&&<Toast toast={notice} onDismiss={dismiss}/>} {confirmation}</>
}

// Очередь операций с карты открывается поверх истории и закрывается обратно в неё: это входящие, а не вкладка.
export function ReviewOverlay({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const dialogRef = useDialog(onClose)
  return <div ref={dialogRef as React.Ref<HTMLDivElement>} className="review-overlay" role="dialog" aria-modal="true" aria-labelledby="review-overlay-title">
    <header className="review-overlay-head"><button type="button" className="icon-button" data-dialog-initial-focus onClick={onClose} aria-label="Закрыть">×</button><h2 id="review-overlay-title">Операции с карты</h2><span/></header>
    {children}
  </div>
}
