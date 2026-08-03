import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArcElement, BarElement, CategoryScale, Chart as ChartJS, Filler, Legend,
  LinearScale, LineElement, PointElement, Tooltip,
} from 'chart.js'
import { Bar, Doughnut, Line } from 'react-chartjs-2'
import {
  ApiError, createCategory, discardOutboxIssues, getAnalytics, getBootstrap, getSession, login, logout,
  reorderCategories, submitExpenseOperation, syncOutbox, updateCategory,
} from './api'
import { cacheBootstrap, outboxStats, readCachedBootstrap } from './offline'
import type { AnalyticsData, Bootstrap, Category, Currency, Expense } from './types'
import { amountToMinor, applyKeypad, convertExpense, isoToLocalInput, localDateKey, localInputToIso, weekdayFromDateKey } from './utils'

ChartJS.register(ArcElement, BarElement, CategoryScale, Filler, Legend, LinearScale, LineElement, PointElement, Tooltip)

type Tab = 'entry' | 'history' | 'analytics' | 'settings'
const CHART_COLOR = '#758d69'
const EMPTY_FORM = { amount: '', currency: 'RSD', note: '', occurredAt: '' }

function money(amountMinor: number, currency: string, currencies: Currency[]) {
  const decimals = currencies.find((item) => item.code === currency)?.decimals ?? 2
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency, maximumFractionDigits: decimals }).format(amountMinor / 10 ** decimals)
}

function inputFromExpense(expense: Expense, currencies: Currency[]) {
  const decimals = currencies.find((item) => item.code === expense.currency)?.decimals ?? 2
  return {
    amount: String(expense.amountMinor / 10 ** decimals),
    currency: expense.currency,
    note: expense.note || '',
    occurredAt: isoToLocalInput(expense.occurredAt),
  }
}

function PinScreen({ onSuccess }: { onSuccess: () => void }) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const digits = ['1','2','3','4','5','6','7','8','9','0']
  const addDigit = (digit: string) => {
    setError('')
    setPin((value) => value.length < 128 ? `${value}${digit}` : value)
  }
  const eraseDigit = () => setPin((value) => value.slice(0, -1))
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!pin) return
    setBusy(true); setError('')
    try { await login(pin); onSuccess() }
    catch { setPin(''); setError('Не подошёл. Попробуйте ещё раз.') }
    finally { setBusy(false) }
  }
  return <main className="pin-screen">
    <div className="brand-mark" aria-hidden="true">m</div>
    <div className="pin-unlock">
      <div className="pin-copy"><p className="eyebrow">Общие расходы</p><h1>С возвращением</h1><p>Введите общий PIN, чтобы продолжить.</p></div>
      <form className="pin-form" onSubmit={submit}>
        <label className="sr-only" htmlFor="pin">PIN-код</label>
        <div className="pin-entry">
          <input id="pin" inputMode="none" autoComplete="off" type="password" value={pin} readOnly placeholder="PIN-код" aria-describedby={error ? 'pin-error' : undefined}/>
          {pin && <button type="button" className="pin-erase" onPointerDown={(event) => { event.preventDefault(); eraseDigit() }} onClick={(event) => { if (event.detail === 0) eraseDigit() }} aria-label="Удалить последнюю цифру">⌫</button>}
        </div>
        {error && <button type="button" id="pin-error" className="toast toast-error" role="alert" onClick={() => setError('')}>{error}</button>}
        <div className="pin-keypad" aria-label="Клавиатура PIN-кода">
          {digits.map((digit) => <button type="button" key={digit} onPointerDown={(event) => { event.preventDefault(); addDigit(digit) }} onClick={(event) => { if (event.detail === 0) addDigit(digit) }} disabled={busy}>{digit}</button>)}
        </div>
        <button className="primary pin-submit" disabled={busy || !pin}>{busy ? 'Проверяем…' : 'Войти'}</button>
      </form>
    </div>
  </main>
}

function CurrencySheet({ currencies, selected, onClose, onSelect }: { currencies: Currency[]; selected: string; onClose: () => void; onSelect: (code: string) => void }) {
  const [query, setQuery] = useState('')
  const pinned = ['RSD', 'EUR', 'USD', 'RUB']
  const filtered = currencies.filter((currency) => `${currency.code} ${currency.name}`.toLowerCase().includes(query.toLowerCase()))
  return <div className="sheet-backdrop" onMouseDown={onClose}>
    <section className="bottom-sheet tall" role="dialog" aria-modal="true" aria-label="Выберите валюту" onMouseDown={(e) => e.stopPropagation()}>
      <div className="sheet-handle"/><div className="sheet-title"><h2>Валюта</h2><button className="icon-button" onClick={onClose} aria-label="Закрыть">×</button></div>
      <input className="search" type="search" placeholder="Код или название" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
      {!query && <div className="currency-pins">{pinned.filter((code) => currencies.some((c) => c.code === code)).map((code) => <button key={code} className={selected === code ? 'selected' : ''} onClick={() => onSelect(code)}>{code}</button>)}</div>}
      <div className="currency-list">{filtered.map((currency) => <button key={currency.code} onClick={() => onSelect(currency.code)}><span><b>{currency.code}</b><small>{currency.name}</small></span><span>{currency.symbol}</span></button>)}</div>
    </section>
  </div>
}

function Keypad({ onKey }: { onKey: (key: string) => void }) {
  return <div className="keypad" aria-label="Клавиатура суммы">{['1','2','3','4','5','6','7','8','9',',','0','⌫'].map((key) => <button key={key} onClick={() => onKey(key)} aria-label={key === '⌫' ? 'Удалить цифру' : key}>{key}</button>)}</div>
}

function CategorySheet({ categories, onClose, onPick }: { categories: Category[]; onClose: () => void; onPick: (category: Category) => void }) {
  return <div className="sheet-backdrop" onMouseDown={onClose}><section className="bottom-sheet" role="dialog" aria-modal="true" aria-label="Другие категории" onMouseDown={(e) => e.stopPropagation()}>
    <div className="sheet-handle"/><div className="sheet-title"><h2>Другое</h2><button className="icon-button" onClick={onClose} aria-label="Закрыть">×</button></div>
    <div className="category-grid">{categories.map((category) => <button key={category.id} onClick={() => onPick(category)}><i style={{ backgroundColor: category.color }}/><span>{category.name}</span></button>)}</div>
  </section></div>
}

function EntryView({ bootstrap, setBootstrap, currentId, setCurrentId, refreshPending }: {
  bootstrap: Bootstrap; setBootstrap: React.Dispatch<React.SetStateAction<Bootstrap>>; currentId: string | null; setCurrentId: (id: string | null) => void; refreshPending: () => void
}) {
  const activeExpenses = useMemo(() => bootstrap.expenses.filter((item) => !item.deletedAt).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)), [bootstrap.expenses])
  const currentIndex = currentId ? activeExpenses.findIndex((item) => item.id === currentId) : -1
  const current = currentIndex >= 0 ? activeExpenses[currentIndex] : null
  const [form, setForm] = useState(EMPTY_FORM)
  const [categorySheet, setCategorySheet] = useState(false)
  const [currencySheet, setCurrencySheet] = useState(false)
  const [showNote, setShowNote] = useState(false)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState('')
  const touchStart = useRef<number | null>(null)

  useEffect(() => {
    setForm(current ? inputFromExpense(current, bootstrap.currencies) : { ...EMPTY_FORM, currency: localStorage.getItem('moapp:last-currency') || 'RSD' })
    setShowNote(Boolean(current?.note))
  }, [currentId]) // eslint-disable-line react-hooks/exhaustive-deps

  const key = (value: string) => setForm((previous) => ({ ...previous, amount: applyKeypad(previous.amount, value, bootstrap.currencies.find((item) => item.code === previous.currency)?.decimals ?? 2) }))

  const buildExpense = (categoryId: string): Expense => {
    const now = new Date().toISOString()
    return {
      id: current?.id || crypto.randomUUID(), amountMinor: amountToMinor(form.amount, form.currency, bootstrap.currencies), currency: form.currency,
      categoryId, note: form.note.trim() || null, occurredAt: form.occurredAt ? localInputToIso(form.occurredAt) : now,
      createdAt: current?.createdAt || now, updatedAt: now, version: current ? current.version + 1 : 1, deletedAt: null, pending: !navigator.onLine,
    }
  }

  const chooseCategory = async (category: Category) => {
    if (!form.amount || Number(form.amount) <= 0) { setToast('Сначала введите сумму'); return }
    setSaving(true); setCategorySheet(false)
    const expense = buildExpense(category.id)
    const previousExpenses = bootstrap.expenses
    setBootstrap((data) => ({ ...data, expenses: [expense, ...data.expenses.filter((item) => item.id !== expense.id)] }))
    try {
      const result = await submitExpenseOperation(current ? 'updateExpense' : 'createExpense', expense)
      if (result?.expense) setBootstrap((data) => ({ ...data, expenses: data.expenses.map((item) => item.id === expense.id ? result.expense! : item) }))
      else if (!result) setBootstrap((data) => ({ ...data, expenses: data.expenses.map((item) => item.id === expense.id ? { ...item, pending:true } : item) }))
      setToast(result?.status === 'conflict' ? 'Конфликт: выберите действие сверху' : current ? 'Изменения сохранены' : 'Расход добавлен')
      if (!current) { setCurrentId(null); setForm({ ...EMPTY_FORM, currency: form.currency }) }
      refreshPending()
    } catch (error) { setBootstrap((data) => ({ ...data, expenses: previousExpenses })); setToast(error instanceof ApiError ? error.message : 'Не удалось сохранить') }
    finally { setSaving(false) }
  }

  const remove = async () => {
    if (!current || !window.confirm('Удалить этот расход?')) return
    const previousExpenses = bootstrap.expenses
    const deleted = { ...current, deletedAt: new Date().toISOString(), pending: !navigator.onLine }
    setBootstrap((data) => ({ ...data, expenses: data.expenses.map((item) => item.id === current.id ? deleted : item) }))
    setCurrentId(null)
    try { await submitExpenseOperation('deleteExpense', current); setToast('Расход удалён') }
    catch (error) { setBootstrap((data) => ({ ...data, expenses: previousExpenses })); setCurrentId(current.id); setToast(error instanceof ApiError ? error.message : 'Не удалось удалить') }
    refreshPending()
  }

  const move = (direction: 'older' | 'newer') => {
    if (direction === 'older') {
      if (!current && activeExpenses[0]) setCurrentId(activeExpenses[0].id)
      else if (currentIndex >= 0 && activeExpenses[currentIndex + 1]) setCurrentId(activeExpenses[currentIndex + 1].id)
    } else {
      if (currentIndex > 0) setCurrentId(activeExpenses[currentIndex - 1].id)
      else setCurrentId(null)
    }
  }

  const main = bootstrap.categories.filter((item) => !item.archivedAt && item.placement === 'main').sort((a,b) => a.sortOrder-b.sortOrder)
  const additional = bootstrap.categories.filter((item) => !item.archivedAt && item.placement === 'additional').sort((a,b) => a.sortOrder-b.sortOrder)
  return <section className="entry-view">
    <header className="topline"><div><p className="eyebrow">{current ? 'Редактирование' : 'Новый расход'}</p><span>{current ? new Date(current.occurredAt).toLocaleString('ru-RU', { timeZone:'Europe/Belgrade', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : 'Сегодня'}</span></div><div className="record-count">{current ? `${currentIndex + 1} / ${activeExpenses.length}` : '＋'}</div></header>
    <div key={currentId || 'new'} className="swipe-area" onPointerDown={(e) => touchStart.current = e.clientX} onPointerUp={(e) => { if (touchStart.current === null) return; const dx=e.clientX-touchStart.current; if (Math.abs(dx)>55) move(dx < 0 ? 'older':'newer'); touchStart.current=null }}>
      <div className="amount-row"><input aria-label="Сумма" value={form.amount} readOnly placeholder="0"/><button onClick={() => setCurrencySheet(true)}>{form.currency}<span>⌄</span></button></div>
      <p className="swipe-hint">← старые расходы <span>свайп</span> новый →</p>
    </div>
    <Keypad onKey={key}/>
    {current && <div className="edit-fields"><label>Дата и время<input type="datetime-local" value={form.occurredAt} onChange={(e) => setForm({...form, occurredAt:e.target.value})}/></label></div>}
    <div className="categories"><p>Категория</p><div className="main-categories">{main.map((category) => <button disabled={saving} key={category.id} onClick={() => chooseCategory(category)}><i style={{backgroundColor:category.color}}/><span>{category.name}</span></button>)}<button onClick={() => setCategorySheet(true)}><i className="dots">•••</i><span>Другое</span></button></div></div>
    <div className="note-block">{!showNote ? <button className="text-button" onClick={() => setShowNote(true)}>＋ Добавить заметку</button> : <label>Заметка <span>необязательно</span><input autoFocus maxLength={200} placeholder="Например, IKEA" value={form.note} onChange={(e) => setForm({...form,note:e.target.value})}/></label>}</div>
    {current && <button className="danger-link" onClick={remove}>Удалить расход</button>}
    {categorySheet && <CategorySheet categories={additional} onClose={() => setCategorySheet(false)} onPick={chooseCategory}/>}
    {currencySheet && <CurrencySheet
      currencies={bootstrap.currencies}
      selected={form.currency}
      onClose={() => setCurrencySheet(false)}
      onSelect={(currency) => {
        setForm({...form,currency})
        localStorage.setItem('moapp:last-currency',currency)
        setCurrencySheet(false)
      }}
    />}
    {toast && <button className="toast" onClick={() => setToast('')}>{toast}</button>}
  </section>
}

function HistoryView({ bootstrap, edit }: { bootstrap: Bootstrap; edit: (id: string) => void }) {
  const [query, setQuery] = useState('')
  const categoryMap = new Map(bootstrap.categories.map((category) => [category.id, category]))
  const expenses = bootstrap.expenses.filter((item) => !item.deletedAt && `${categoryMap.get(item.categoryId)?.name} ${item.currency}`.toLowerCase().includes(query.toLowerCase())).sort((a,b) => b.occurredAt.localeCompare(a.occurredAt))
  const grouped = expenses.reduce<Record<string, Expense[]>>((result, item) => { (result[localDateKey(item.occurredAt)] ||= []).push(item); return result }, {})
  const groups = Object.entries(grouped)
  return <section className="page"><header className="page-header"><p className="eyebrow">Все записи</p><h1>История</h1></header><input className="search" type="search" placeholder="Категория или валюта" value={query} onChange={(e) => setQuery(e.target.value)}/>
    <div className="history-list">{groups.map(([date, items]) => <div key={date} className="history-day"><div className="history-date"><span>{new Date(`${date}T12:00:00Z`).toLocaleDateString('ru-RU',{timeZone:'Europe/Belgrade',day:'numeric',month:'long'})}</span><b>{items?.length}</b></div>{items?.map((expense) => { const category=categoryMap.get(expense.categoryId); return <button key={expense.id} onClick={() => edit(expense.id)}><i style={{backgroundColor:category?.color}}/><span><b>{category?.name || 'Архивная категория'}</b><small>{new Date(expense.occurredAt).toLocaleTimeString('ru-RU',{timeZone:'Europe/Belgrade',hour:'2-digit',minute:'2-digit'})}{expense.note ? ` · ${expense.note}`:''}</small></span><strong>{money(expense.amountMinor,expense.currency,bootstrap.currencies)}</strong>{expense.pending && <em>●</em>}</button>})}</div>)}</div>
  </section>
}

function AnalyticsView({ bootstrap }: { bootstrap: Bootstrap }) {
  const [target, setTarget] = useState(localStorage.getItem('moapp:analytics-currency') || 'RSD')
  const [currencySheet, setCurrencySheet] = useState(false)
  const [remote,setRemote]=useState<AnalyticsData|null>(null)
  const [analyticsOffline,setAnalyticsOffline]=useState(!navigator.onLine)
  const [analyticsLoading,setAnalyticsLoading]=useState(navigator.onLine)
  const today=localDateKey(new Date())
  const from=bootstrap.expenses.length?bootstrap.expenses.map((expense)=>localDateKey(expense.occurredAt)).sort()[0]!:today.slice(0,8)+'01'
  const fallback=useMemo(()=>fallbackAnalytics(bootstrap,target,from,today),[bootstrap,target,from,today])
  useEffect(()=>{let active=true;if(!navigator.onLine){setAnalyticsOffline(true);setAnalyticsLoading(false);setRemote(null);return}setAnalyticsLoading(true);getAnalytics(from,today,target).then((result)=>{if(active){setRemote(result);setAnalyticsOffline(false);setAnalyticsLoading(false)}}).catch(()=>{if(active){setRemote(null);setAnalyticsOffline(true);setAnalyticsLoading(false)}});return()=>{active=false}},[from,today,target])
  const data=remote||fallback
  const decimals=bootstrap.currencies.find((currency)=>currency.code===target)?.decimals??2
  const divisor=10**decimals
  const end=new Date(`${today}T12:00:00Z`)
  const days=Array.from({length:30},(_,index)=>{const date=new Date(end);date.setUTCDate(date.getUTCDate()-29+index);return date.toISOString().slice(0,10)})
  const dailyMap=new Map(data.daily.map((point)=>[point.date,point.amountMinor/divisor]))
  const byDay=days.map((date)=>dailyMap.get(date)||0)
  const byCategory=data.categories.filter((item)=>item.amountMinor>0).map((item)=>({...item,value:item.amountMinor/divisor}))
  const serverWeekdays=new Map(data.weekdays.map((point)=>[point.weekday,point.amountMinor/divisor]))
  const weekdays=[1,2,3,4,5,6,0].map((day)=>serverWeekdays.get(day)||0)
  const total=data.totalMinor/divisor
  const chartOptions = { responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{x:{grid:{display:false},ticks:{maxTicksLimit:6}},y:{display:false}} }
  return <section className="page analytics"><header className="page-header analytics-title"><div><p className="eyebrow">Все расходы</p><h1>{new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}).format(total)} <small>{target}</small></h1></div><button className="currency-choice" onClick={()=>setCurrencySheet(true)}>{target}⌄</button></header>
    <p className="rate-caption">{analyticsLoading?'Обновляем аналитику…':analyticsOffline?'Офлайн-оценка по последнему сохранённому курсу':data.rateDate?`Исторические курсы с ${new Date(`${data.rateDate}T12:00:00Z`).toLocaleDateString('ru-RU')}`:'Курсы обновляются'}{data.missingCurrencies.length?` · без ${data.missingCurrencies.join(', ')}`:''}</p>
    <div className="chart-card"><div><h2>Динамика</h2><p>Последние 30 дней</p></div><div className="line-chart"><Line data={{labels:days.map((d)=>new Date(`${d}T12:00`).toLocaleDateString('ru-RU',{day:'numeric',month:'short'})),datasets:[{data:byDay,borderColor:CHART_COLOR,backgroundColor:'rgba(117,141,105,.12)',fill:true,tension:.38,pointRadius:0,borderWidth:2}]}} options={chartOptions}/></div></div>
    <div className="chart-card split"><div><h2>Категории</h2><p>За всё время</p></div><div className="donut-wrap"><Doughnut data={{labels:byCategory.map((x)=>x.name),datasets:[{data:byCategory.map((x)=>x.value),backgroundColor:byCategory.map((x)=>x.color||'#a9afa5'),borderWidth:0,spacing:3}]}} options={{responsive:true,maintainAspectRatio:false,cutout:'72%',plugins:{legend:{display:false}}}}/><span>{byCategory.length}</span></div><div className="legend">{byCategory.slice(0,5).map((x)=><div key={x.categoryId}><i style={{background:x.color||'#a9afa5'}}/><span>{x.name}</span><b>{Math.round(x.value/total*100)||0}%</b></div>)}</div></div>
    <div className="chart-card"><div><h2>По дням недели</h2><p>Когда тратим больше</p></div><div className="bar-chart"><Bar data={{labels:['Пн','Вт','Ср','Чт','Пт','Сб','Вс'],datasets:[{data:weekdays,backgroundColor:CHART_COLOR,borderRadius:6,borderSkipped:false}]}} options={chartOptions}/></div></div>
    <Heatmap points={data.calendar.map((point)=>({date:point.date,value:point.amountMinor/divisor}))}/>
    {currencySheet && <CurrencySheet currencies={bootstrap.currencies} selected={target} onClose={()=>setCurrencySheet(false)} onSelect={(code)=>{setTarget(code);localStorage.setItem('moapp:analytics-currency',code);setCurrencySheet(false)}}/>}
  </section>
}

function fallbackAnalytics(bootstrap:Bootstrap,target:string,from:string,to:string):AnalyticsData {
  const decimals=bootstrap.currencies.find((currency)=>currency.code===target)?.decimals??2
  const categories=new Map(bootstrap.categories.map((category)=>[category.id,category]))
  const expenses=bootstrap.expenses.filter((expense)=>!expense.deletedAt).map((expense)=>({expense,date:localDateKey(expense.occurredAt),amountMinor:Math.round(convertExpense(expense,target,bootstrap.currencies,bootstrap.rates)*10**decimals)}))
  const sum=(items:typeof expenses)=>items.reduce((total,item)=>total+item.amountMinor,0)
  const dates=[...new Set(expenses.map((item)=>item.date))]
  return {currency:target,from,to,totalMinor:sum(expenses),expenseCount:expenses.length,convertedCount:expenses.length,rateDate:bootstrap.rates.date,missingCurrencies:[],daily:dates.map((date)=>{const items=expenses.filter((item)=>item.date===date);return{date,amountMinor:sum(items),count:items.length}}),categories:[...categories.values()].map((category)=>{const items=expenses.filter((item)=>item.expense.categoryId===category.id);return{categoryId:category.id,name:category.name,color:category.color,amountMinor:sum(items),count:items.length}}),weekdays:Array.from({length:7},(_,weekday)=>{const items=expenses.filter((item)=>(weekdayFromDateKey(item.date)+1)%7===weekday);return{weekday,amountMinor:sum(items),count:items.length}}),calendar:dates.map((date)=>{const items=expenses.filter((item)=>item.date===date);return{date,amountMinor:sum(items),count:items.length}})}
}

function Heatmap({ points }: { points:{date:string;value:number}[] }) {
  const values = new Map(points.map((point)=>[point.date,point.value]))
  const max=Math.max(...values.values(),1)
  const today=localDateKey(new Date());const start=new Date(`${today}T12:00:00Z`);start.setUTCDate(start.getUTCDate()-363-weekdayFromDateKey(today))
  const days=Array.from({length:371},(_,index)=>{const d=new Date(start);d.setUTCDate(d.getUTCDate()+index);return d})
  return <div className="chart-card heatmap-card"><div><h2>Календарь расходов</h2><p>Последние 12 месяцев</p></div><div className="heatmap-scroll"><div className="heatmap">{days.map((date)=>{const key=date.toISOString().slice(0,10);const value=values.get(key)||0;const level=value===0?0:Math.max(1,Math.ceil(value/max*4));return <span key={key} className={`level-${level}`} title={`${date.toLocaleDateString('ru-RU',{timeZone:'Europe/Belgrade'})}: ${Math.round(value)}`}/>})}</div></div><div className="heat-legend"><span>Меньше</span>{[0,1,2,3,4].map((level)=><i key={level} className={`level-${level}`}/>)}<span>Больше</span></div></div>
}

function SettingsView({ bootstrap, setBootstrap, refreshPending, onLogout }: { bootstrap:Bootstrap; setBootstrap:React.Dispatch<React.SetStateAction<Bootstrap>>; refreshPending:()=>void;onLogout:()=>void }) {
  const [editing,setEditing]=useState<Category|null>(null)
  const [adding,setAdding]=useState(false)
  const [notice,setNotice]=useState('')
  const colors=['#819978','#d98f70','#d2ad62','#7d9db4','#aa8aaf','#797d72']
  const save=async(category:Category)=>{const previous=bootstrap.categories;setBootstrap((b)=>({...b,categories:[category,...b.categories.filter((x)=>x.id!==category.id)]}));try{const saved=bootstrap.categories.some((x)=>x.id===category.id)?await updateCategory(category):await createCategory(category);setBootstrap((b)=>({...b,categories:b.categories.map((x)=>x.id===category.id?saved:x)}));setEditing(null);setAdding(false);setNotice('Категория сохранена')}catch(error){setBootstrap((b)=>({...b,categories:previous}));setNotice(error instanceof ApiError?error.message:'Не удалось сохранить категорию')}refreshPending()}
  const move=async(category:Category,direction:-1|1)=>{const previous=bootstrap.categories;const group=bootstrap.categories.filter((x)=>x.placement===category.placement&&!x.archivedAt).sort((a,b)=>a.sortOrder-b.sortOrder);const index=group.findIndex((x)=>x.id===category.id),next=index+direction;if(next<0||next>=group.length)return;[group[index],group[next]]=[group[next],group[index]];const groupIds=group.map((x)=>x.id);const ids=bootstrap.categories.filter((x)=>!x.archivedAt).sort((a,b)=>a.placement.localeCompare(b.placement)||a.sortOrder-b.sortOrder).map((x)=>x.id);const ordered=ids.filter((id)=>!groupIds.includes(id));if(category.placement==='main')ordered.unshift(...groupIds);else ordered.push(...groupIds);setBootstrap((b)=>({...b,categories:b.categories.map((x)=>{const order=groupIds.indexOf(x.id);return order>=0?{...x,sortOrder:order}:x})}));try{const result=await reorderCategories(ordered);const fresh=new Map(result.categories.map((x)=>[x.id,x]));setBootstrap((b)=>({...b,categories:b.categories.map((x)=>fresh.get(x.id)||x)}))}catch(error){setBootstrap((b)=>({...b,categories:previous}));setNotice(error instanceof ApiError?error.message:'Не удалось изменить порядок')}refreshPending()}
  const groups:[Category['placement'],string][]=[['main','Основные'],['additional','Дополнительные']]
  return <section className="page"><header className="page-header settings-title"><div><p className="eyebrow">Настройки</p><h1>Категории</h1></div><button className="add-button" onClick={()=>setAdding(true)}>＋</button></header><p className="page-intro">Настройте быстрые кнопки и их порядок. Категории меняются только онлайн; архивные останутся в истории.</p>{notice&&<button className="toast" onClick={()=>setNotice('')}>{notice}</button>}
    {groups.map(([placement,title])=><div className="settings-group" key={placement}><h2>{title}</h2>{bootstrap.categories.filter((x)=>x.placement===placement&&!x.archivedAt).sort((a,b)=>a.sortOrder-b.sortOrder).map((category)=><div className="category-row" key={category.id}><i style={{background:category.color}}/><button className="category-name" onClick={()=>setEditing(category)}>{category.name}</button><button onClick={()=>move(category,-1)} aria-label="Выше">↑</button><button onClick={()=>move(category,1)} aria-label="Ниже">↓</button></div>)}</div>)}
    {(editing||adding)&&<CategoryEditor category={editing} colors={colors} onClose={()=>{setEditing(null);setAdding(false)}} onSave={save}/>}
    <div className="settings-group"><h2>Это устройство</h2><p className="page-intro">Для работы без интернета расходы и сессия доверенно сохраняются в этом браузере. Не используйте эту функцию на общем устройстве.</p><button className="danger-link" onClick={onLogout}>Выйти и удалить локальные данные</button></div>
  </section>
}

function CategoryEditor({ category, colors, onClose, onSave }:{category:Category|null;colors:string[];onClose:()=>void;onSave:(c:Category)=>void}) {
  const [draft,setDraft]=useState<Category>(category||{id:crypto.randomUUID(),name:'',color:colors[0],placement:'additional',sortOrder:999,archivedAt:null,version:1})
  return <div className="sheet-backdrop" onMouseDown={onClose}><form className="bottom-sheet editor" onSubmit={(e)=>{e.preventDefault();onSave(draft)}} onMouseDown={(e)=>e.stopPropagation()}><div className="sheet-handle"/><div className="sheet-title"><h2>{category?'Изменить':'Новая категория'}</h2><button type="button" className="icon-button" onClick={onClose}>×</button></div><label>Название<input required autoFocus maxLength={40} value={draft.name} onChange={(e)=>setDraft({...draft,name:e.target.value})}/></label><fieldset><legend>Цвет</legend><div className="colors">{colors.map((color)=><button aria-label={color} type="button" key={color} className={draft.color===color?'selected':''} style={{background:color}} onClick={()=>setDraft({...draft,color})}/>)}</div></fieldset><label>Размещение<select value={draft.placement} onChange={(e)=>setDraft({...draft,placement:e.target.value as Category['placement']})}><option value="main">Основные</option><option value="additional">Дополнительные</option></select></label><button className="primary">Сохранить</button>{category&&<button type="button" className="danger-link" onClick={()=>onSave({...draft,archivedAt:new Date().toISOString()})}>Архивировать</button>}</form></div>
}

const tabs:{id:Tab;label:string;icon:string}[]=[{id:'entry',label:'Расход',icon:'＋'},{id:'history',label:'История',icon:'≡'},{id:'analytics',label:'Аналитика',icon:'⌁'},{id:'settings',label:'Настройки',icon:'⚙'}]

export default function App() {
  const [auth,setAuth]=useState<'checking'|'locked'|'ok'>('checking')
  const [bootstrap,setBootstrap]=useState<Bootstrap|null>(null)
  const [tab,setTab]=useState<Tab>('entry')
  const [currentId,setCurrentId]=useState<string|null>(null)
  const [offline,setOffline]=useState(!navigator.onLine)
  const [pending,setPending]=useState({total:0,conflicts:0,failed:0})
  const [error,setError]=useState('')
  const refreshPending=()=>outboxStats().then(setPending)
  const load=async()=>{setError('');try{let stats=await outboxStats();setPending(stats);if(navigator.onLine&&stats.total&&!stats.conflicts&&!stats.failed){await syncOutbox(refreshPending);stats=await outboxStats();setPending(stats)}if(stats.conflicts||stats.failed){const cached=await readCachedBootstrap();if(cached){setBootstrap(cached);setOffline(!navigator.onLine);return}}const result=await getBootstrap();setBootstrap(result.data);setOffline(result.offline);refreshPending()}catch(error){if(error instanceof ApiError&&error.status===401){localStorage.removeItem('moapp:known-session');setAuth('locked');return}setError('Не удалось загрузить данные. Откройте приложение один раз с интернетом.')}}
  useEffect(()=>{getSession().then((s)=>setAuth(s.authenticated?'ok':'locked')).catch((error)=>setAuth(error instanceof ApiError&&error.status===401?'locked':localStorage.getItem('moapp:known-session')?'ok':'locked'))},[])
  useEffect(()=>{if(auth==='ok')load()},[auth]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(()=>{if(bootstrap)void cacheBootstrap(bootstrap)},[bootstrap])
  useEffect(()=>{const online=()=>{setOffline(false);load()};const off=()=>setOffline(true);const unauthorized=()=>{localStorage.removeItem('moapp:known-session');setAuth('locked')};window.addEventListener('online',online);window.addEventListener('offline',off);window.addEventListener('moapp:unauthorized',unauthorized);return()=>{window.removeEventListener('online',online);window.removeEventListener('offline',off);window.removeEventListener('moapp:unauthorized',unauthorized)}},[]) // eslint-disable-line react-hooks/exhaustive-deps
  if(auth==='checking')return <div className="splash"><div className="brand-mark">m</div></div>
  if(auth==='locked')return <PinScreen onSuccess={()=>setAuth('ok')}/>
  if(error)return <><div className="splash"><div className="brand-mark">m</div><p>Ожидаем подключение…</p></div><button className="toast toast-error toast-action" role="alert" onClick={load}>{error} · Повторить</button></>
  if(!bootstrap)return <div className="splash"><div className="brand-mark">m</div><p>Загружаем расходы…</p></div>
  const updateBootstrap = setBootstrap as React.Dispatch<React.SetStateAction<Bootstrap>>
  const edit=(id:string)=>{setCurrentId(id);setTab('entry')}
  const resolveIssues=async()=>{if(!window.confirm('Отбросить локальные конфликтующие изменения и загрузить актуальные данные с сервера?'))return;await discardOutboxIssues();await load()}
  const signOut=async()=>{if(!window.confirm('Выйти и удалить сохранённые на этом устройстве расходы и очередь?'))return;await logout();setBootstrap(null);setAuth('locked')}
  return <div className="app-shell">
    {(offline||pending.total>0)&&(pending.conflicts||pending.failed?<button className="sync-status attention" onClick={resolveIssues}><span>{pending.conflicts?`Конфликт: ${pending.conflicts} · решить`:`Ошибка: ${pending.failed} · решить`}</span><i/></button>:<div className="sync-status"><span>{offline?'Офлайн':`Синхронизация: ${pending.total}`}</span><i/></div>)}
    <main className="content">{tab==='entry'&&<EntryView bootstrap={bootstrap} setBootstrap={updateBootstrap} currentId={currentId} setCurrentId={setCurrentId} refreshPending={refreshPending}/>} {tab==='history'&&<HistoryView bootstrap={bootstrap} edit={edit}/>} {tab==='analytics'&&<AnalyticsView bootstrap={bootstrap}/>} {tab==='settings'&&<SettingsView bootstrap={bootstrap} setBootstrap={updateBootstrap} refreshPending={refreshPending} onLogout={signOut}/>}</main>
    <nav className="bottom-nav" aria-label="Основная навигация">{tabs.map((item)=><button key={item.id} className={tab===item.id?'active':''} onClick={()=>{setTab(item.id);if(item.id==='entry')setCurrentId(null)}}><span>{item.icon}</span><small>{item.label}</small></button>)}</nav>
  </div>
}
