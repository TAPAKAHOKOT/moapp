import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { WorkspaceApiError as ApiError, getAnalytics } from '../workspace-api'
import { getWorkspacePreference, setWorkspacePreference } from '../app-state'
import type { AnalyticsData, Expense } from '../types'
import { cachedNumberFormat, convertExpense, countCalendarWeekdays, hasRate, localDateKey, monthDateRange, shiftDateKey, weekDateRange, weekdayFromDateKey } from '../utils'
import { expenseTagNames } from '../history'
import { ChevronIcon, CurrencySheet, prefersReducedMotion, tap } from '../ui'
import type { Theme } from '../ui'
import { formatAnalyticsAmount, formatCompactNumber, formatWeekRange, money, pluralRu } from '../format'
import type { Bootstrap } from '../format'

export const AnalyticsChart = lazy(() => import('../AnalyticsCharts'))

export type AnalyticsPeriod = 'week' | 'month'

export const CHART_COLOR = '#758d69'

export function AnalyticsView({ userId, workspaceId, bootstrap, theme, online }: { userId: string; workspaceId: string; bootstrap: Bootstrap; theme: Theme; online: boolean }) {
  const [target, setTarget] = useState(getWorkspacePreference(userId, workspaceId, 'analytics-currency') || 'RSD')
  const [period, setPeriod] = useState<AnalyticsPeriod>('week')
  const [weekOffset, setWeekOffset] = useState(0)
  const [monthOffset, setMonthOffset] = useState(0)
  // Фокус на категории: тап по строке легенды сужает всё выше до неё и раскрывает её записи, второй тап возвращает всё.
  // Отдельного селекта нет — легенда и есть список категорий. Фокус живёт только до перезахода: сохранённый фильтр удивлял бы.
  const [focusedCategoryId,setFocusedCategoryId]=useState<string|null>(null)
  const [currencySheet, setCurrencySheet] = useState(false)
  const [allDetails,setAllDetails]=useState(false)
  const [rateInfo,setRateInfo]=useState(false)
  const [remote,setRemote]=useState<{key:string;data:AnalyticsData;previousTotalMinor:number|null}|null>(null)
  const [analyticsOffline,setAnalyticsOffline]=useState(!online)
  const [analyticsLoading,setAnalyticsLoading]=useState(online)
  const [analyticsError,setAnalyticsError]=useState<string|null>(null)
  const [retryEpoch,setRetryEpoch]=useState(0)
  const today=localDateKey(new Date())
  const selectedWeek=weekDateRange(today,weekOffset)
  const selectedMonth=monthDateRange(today,monthOffset)
  const categoryId=focusedCategoryId&&bootstrap.categories.some((category)=>category.id===focusedCategoryId)?focusedCategoryId:null
  const selectedRange=period==='week'?selectedWeek:selectedMonth
  const from=selectedRange.from
  // График обрывается на сегодняшнем дне: ещё не наступившие дни — не нули.
  const analyticsTo=selectedRange.to>today?today:selectedRange.to
  const periodDays=Math.round((new Date(`${analyticsTo}T12:00:00Z`).getTime()-new Date(`${from}T12:00:00Z`).getTime())/86400000)+1
  // Сравнение с прошлым периодом — за те же дни, пока текущий период не закончился; и для недели, и для месяца.
  const partial=analyticsTo<selectedRange.to
  const previousRange=period==='week'?weekDateRange(today,weekOffset-1):monthDateRange(today,monthOffset-1)
  const previousSameDays=shiftDateKey(previousRange.from,periodDays-1)
  const previousTo=partial&&previousSameDays<previousRange.to?previousSameDays:previousRange.to
  const expenseRevision=bootstrap.expenses.map((expense)=>`${expense.id}:${expense.version}:${expense.updatedAt}:${expense.deletedAt||''}:${expense.voidedAt||''}:${expense.amountMinor}:${expense.currency}:${expense.categoryId}:${expense.occurredAt}`).join('|')
  const requestKey=`${expenseRevision}:${from}:${analyticsTo}:${target}:${period}:${categoryId??'all'}`
  const fallback=useMemo(()=>fallbackAnalytics(bootstrap,target,from,analyticsTo,categoryId),[bootstrap,target,from,analyticsTo,categoryId])
  const previousFallback=useMemo(()=>fallbackAnalytics(bootstrap,target,previousRange.from,previousTo,categoryId),[bootstrap,target,previousRange.from,previousTo,categoryId])
  // Ответы сервера запоминаются по ключу периода: возврат к уже виденной неделе не ждёт сети. Пока ответа нет,
  // показан локальный расчёт по тем же курсам дня, так что число не меняется дважды.
  const cache=useRef(new Map<string,{data:AnalyticsData;previousTotalMinor:number|null}>())
  useEffect(()=>{
    let active=true;const controller=new AbortController()
    setAnalyticsError(null)
    if(!online){setAnalyticsOffline(true);setAnalyticsLoading(false);setRemote(null);return()=>controller.abort()}
    const cached=cache.current.get(requestKey)
    if(cached){setRemote({key:requestKey,...cached});setAnalyticsOffline(false);setAnalyticsLoading(false);return()=>controller.abort()}
    setAnalyticsLoading(true)
    Promise.all([getAnalytics(workspaceId,from,analyticsTo,target,categoryId??undefined,controller.signal),getAnalytics(workspaceId,previousRange.from,previousTo,target,categoryId??undefined,controller.signal)]).then(([result,previous])=>{
      if(!active)return
      const entry={data:result,previousTotalMinor:previous.totalMinor}
      cache.current.set(requestKey,entry)
      if(cache.current.size>40)cache.current.delete(cache.current.keys().next().value!)
      setRemote({key:requestKey,...entry});setAnalyticsOffline(false);setAnalyticsLoading(false)
    }).catch((reason)=>{if(active&&!controller.signal.aborted){setRemote(null);setAnalyticsOffline(true);setAnalyticsError(reason instanceof ApiError?reason.message:'Сервер аналитики недоступен');setAnalyticsLoading(false)}})
    return()=>{active=false;controller.abort()}
  },[workspaceId,from,analyticsTo,target,categoryId,previousRange.from,previousTo,requestKey,online,retryEpoch])
  // Индикатор загрузки появляется только если сервер думает дольше 300 мс, и не трогает раскладку.
  const [slowLoading,setSlowLoading]=useState(false)
  useEffect(()=>{if(!analyticsLoading){setSlowLoading(false);return}const timer=setTimeout(()=>setSlowLoading(true),300);return()=>clearTimeout(timer)},[analyticsLoading])
  const data=remote?.key===requestKey?remote.data:fallback
  const previousTotalMinor=remote?.key===requestKey?remote.previousTotalMinor:previousFallback.totalMinor
  const decimals=bootstrap.currencies.find((currency)=>currency.code===target)?.decimals??2
  const divisor=10**decimals
  const days=Array.from({length:periodDays},(_,index)=>shiftDateKey(from,index))
  const dailyMap=new Map(data.daily.map((point)=>[point.date,point.amountMinor/divisor]))
  const byDay=days.map((date)=>dailyMap.get(date)||0)
  const byCategory=data.categories.filter((item)=>item.amountMinor>0).map((item)=>({...item,value:item.amountMinor/divisor}))
  useEffect(()=>{setAllDetails(false)},[period,from,categoryId])
  const categoryDetails=useMemo(()=>categoryId?bootstrap.expenses.filter((expense)=>!expense.deletedAt&&!expense.voidedAt&&expense.categoryId===categoryId).map((expense)=>({expense,date:localDateKey(expense.occurredAt)})).filter((item)=>item.date>=from&&item.date<=analyticsTo).sort((left,right)=>right.expense.occurredAt.localeCompare(left.expense.occurredAt)):[],[bootstrap.expenses,categoryId,from,analyticsTo])
  const detailCaption=(expense:Expense)=>{if(expense.note)return ` · ${expense.note}`;const names=expenseTagNames(expense,bootstrap.tags??[]);return names.length?` · ${names.map((name)=>`#${name}`).join(' ')}`:''}
  const detailDate=(date:string)=>new Date(`${date}T12:00:00Z`).toLocaleDateString('ru-RU',{timeZone:'UTC',day:'numeric',month:'short'}).replace('.','')
  const serverWeekdays=new Map(data.weekdays.map((point)=>[point.weekday,point.amountMinor/divisor]))
  const weekdayCounts=countCalendarWeekdays(from,analyticsTo)
  const weekdays=[1,2,3,4,5,6,0].map((day)=>Math.round((serverWeekdays.get(day)||0)/(weekdayCounts[day]||1)))
  const total=data.totalMinor/divisor
  const previousTotal=(previousTotalMinor??0)/divisor
  const elapsedDays=Math.max(1,periodDays)
  const shownTotal=useTweenedNumber(total)
  const shownPerDay=useTweenedNumber(total/elapsedDays)
  const weekRange=formatWeekRange(selectedWeek.from,selectedWeek.to)
  const monthLabel=new Date(`${selectedMonth.from}T12:00:00Z`).toLocaleDateString('ru-RU',{timeZone:'UTC',month:'long',year:'numeric'})
  const focusedName=categoryId?bootstrap.categories.find((category)=>category.id===categoryId)?.name:null
  // О пересчёте валют говорим только когда он есть: в периоде встретились расходы не в валюте аналитики.
  const hasForeign=bootstrap.expenses.some((expense)=>{if(expense.deletedAt||expense.voidedAt||expense.currency===target)return false;const date=localDateKey(expense.occurredAt);return date>=from&&date<=analyticsTo})
  const focus=(id:string)=>{tap(4);setAllDetails(false);setRateInfo(false);setFocusedCategoryId((current)=>current===id?null:id)}
  const chartColor=theme==='dark'?'#b1cfa3':CHART_COLOR
  const chartText=theme==='dark'?'#b3b3ae':'#73776f'
  const chartGrid=theme==='dark'?'rgba(255,255,255,.06)':'rgba(32,37,31,.06)'
  const statusLine=analyticsOffline?<>{analyticsError?'Не удалось обновить. ':''}Показаны сохранённые данные на {new Date(bootstrap.serverTime).toLocaleString('ru-RU')}{online&&<button type="button" onClick={()=>setRetryEpoch((value)=>value+1)}>Повторить</button>}</>:data.missingCurrencies.length?`Нет курса: ${data.missingCurrencies.join(', ')} — эти расходы не посчитаны`:null
  return <section className="page analytics"><div className={`analytics-progress${slowLoading?' on':''}`} aria-hidden="true"/><header className="page-header analytics-title"><div>{focusedName&&<p className="eyebrow">{focusedName}</p>}<h1>{cachedNumberFormat('ru-RU',{maximumFractionDigits:0}).format(shownTotal)}{hasForeign&&<button type="button" className="rate-info" aria-label="Как посчитана сумма" aria-expanded={rateInfo} onClick={()=>setRateInfo((value)=>!value)}>i</button>}</h1><p className="analytics-comparison">{formatAnalyticsAmount(shownPerDay,target)} в день · {data.expenseCount} {pluralRu(data.expenseCount,['операция','операции','операций'])}</p><p className="analytics-comparison">{comparisonLabel(total,previousTotal,partial,period)}</p></div><button className="currency-choice" onClick={()=>setCurrencySheet(true)}>{target}<ChevronIcon/></button></header>
    {rateInfo&&hasForeign&&<p className="rate-caption" role="note">Расходы в других валютах пересчитаны в {target} по курсу на день покупки.</p>}
    <div className="analytics-period" role="group" aria-label="Период аналитики"><button type="button" aria-pressed={period==='week'} className={period==='week'?'selected':''} onClick={()=>setPeriod('week')}>Неделя</button><button type="button" aria-pressed={period==='month'} className={period==='month'?'selected':''} onClick={()=>setPeriod('month')}>Месяц</button></div>
    {period==='week'&&<div className="week-navigator"><button type="button" onClick={()=>setWeekOffset((value)=>value-1)} aria-label="Предыдущая неделя">‹</button><div><b>{weekOffset===0?'Текущая неделя':weekOffset===-1?'Прошлая неделя':'Выбранная неделя'}</b><span>{weekRange}</span></div><button type="button" onClick={()=>setWeekOffset((value)=>Math.min(0,value+1))} disabled={weekOffset===0} aria-label="Следующая неделя">›</button></div>}
    {period==='month'&&<div className="week-navigator"><button type="button" onClick={()=>setMonthOffset((value)=>value-1)} aria-label="Предыдущий месяц">‹</button><div><b>{monthOffset===0?'Текущий месяц':monthOffset===-1?'Прошлый месяц':'Выбранный месяц'}</b><span>{monthLabel}</span></div><button type="button" onClick={()=>setMonthOffset((value)=>Math.min(0,value+1))} disabled={monthOffset===0} aria-label="Следующий месяц">›</button></div>}
    {statusLine&&<div className={`rate-caption${analyticsOffline?' cached':''}`} role="status">{statusLine}</div>}
    <div className="chart-card"><div><h2>Динамика</h2><p>{period==='week'?'Понедельник — воскресенье':'По дням выбранного месяца'}</p></div>{data.convertedCount?<div className="line-chart"><Suspense fallback={<ChartSkeleton/>}><AnalyticsChart kind="line" labels={days.map((d)=>new Date(`${d}T12:00`).toLocaleDateString('ru-RU',period==='week'?{weekday:'short'}:{day:'numeric',month:'short'}))} values={byDay} color={chartColor} fillColor={theme==='dark'?'rgba(177,207,163,.14)':'rgba(117,141,105,.12)'} pointRadius={period==='week'?3:0} target={target} textColor={chartText} gridColor={chartGrid} maxTicksLimit={period==='week'?7:6}/></Suspense></div>:<AnalyticsEmpty>{data.expenseCount?'Нет курса для выбранной валюты':'В этом периоде ещё нет расходов'}</AnalyticsEmpty>}</div>
    <div className={`chart-card${byCategory.length?' split':''}`}><div><h2>Категории</h2><p>{categoryId?'Тап по строке возвращает все категории':period==='week'?'За выбранную неделю · тап по строке покажет записи':'За выбранный месяц · тап по строке покажет записи'}</p></div>{byCategory.length?<><div className="donut-wrap"><Suspense fallback={<ChartSkeleton/>}><AnalyticsChart kind="doughnut" labels={byCategory.map((x)=>x.name)} values={byCategory.map((x)=>x.value)} colors={byCategory.map((x)=>x.color||'#a9afa5')} target={target}/></Suspense><span>{formatCompactNumber(total)}</span></div><div className="legend">{byCategory.map((x)=>{const focused=categoryId===x.categoryId;const rows=focused?categoryDetails:[];const shown=allDetails?rows:rows.slice(0,LEGEND_DETAIL_LIMIT);return <div key={x.categoryId} className={`legend-item${focused?' open':''}`}><button type="button" className="legend-row" aria-expanded={focused} onClick={()=>focus(x.categoryId)}><i style={{background:x.color||'#a9afa5'}}/><span>{x.name}</span><span className="legend-value"><b>{formatAnalyticsAmount(x.value,target)}</b><small className={focused?'ghost':undefined} aria-hidden={focused||undefined}>{Math.round(x.value/total*100)||0}%</small></span>{focused?<span className="legend-close" aria-hidden="true">×</span>:<ChevronIcon/>}</button>{focused&&<div className="legend-details">{rows.length?<>{shown.map(({expense,date})=><div key={expense.id} className="legend-detail"><span><b>{detailDate(date)}</b>{detailCaption(expense)}</span><span className="legend-value"><b>{money(expense.amountMinor,expense.currency,bootstrap.currencies)}</b>{expense.currency!==target&&<small>≈ {formatAnalyticsAmount(convertExpense(expense,target,bootstrap.currencies,bootstrap.rates),target)}</small>}</span></div>)}{rows.length>shown.length&&<button type="button" className="legend-more" onClick={()=>setAllDetails(true)}>Показать все · {rows.length}</button>}</>:<p className="legend-empty">На этом устройстве нет записей этой категории за период.</p>}</div>}</div>})}{categoryId&&<button type="button" className="legend-all" onClick={()=>focus(categoryId)}>Все категории</button>}</div></>:<AnalyticsEmpty>Категории появятся после первого расхода</AnalyticsEmpty>}</div>
    {period==='month'&&<div className="chart-card"><div><h2>По дням недели</h2><p>Средние траты за календарный день</p></div>{data.convertedCount?<div className="bar-chart"><Suspense fallback={<ChartSkeleton/>}><AnalyticsChart kind="bar" labels={['Пн','Вт','Ср','Чт','Пт','Сб','Вс']} values={weekdays} color={chartColor} target={target} textColor={chartText} gridColor={chartGrid}/></Suspense></div>:<AnalyticsEmpty>Недостаточно данных для сравнения</AnalyticsEmpty>}</div>}
    {currencySheet && <CurrencySheet currencies={bootstrap.currencies} used={[...new Set(bootstrap.expenses.filter((item)=>!item.deletedAt).map((item)=>item.currency))]} selected={target} onClose={()=>setCurrencySheet(false)} onSelect={(code)=>{setTarget(code);setWorkspacePreference(userId, workspaceId, 'analytics-currency', code);setCurrencySheet(false)}}/>}
  </section>
}

export const LEGEND_DETAIL_LIMIT=8

export function AnalyticsEmpty({children}:{children:string}) {
  return <div className="analytics-empty"><span>⌁</span><p>{children}</p></div>
}

export function ChartSkeleton() {
  return <div className="chart-skeleton" role="status" aria-label="Загружаем график"><i/><i/><i/><i/><i/></div>
}

// Число в шапке аналитики доезжает до нового значения за четверть секунды, а не прыгает. Первое значение — сразу.
export function useTweenedNumber(value:number,duration=250) {
  const [shown,setShown]=useState(value)
  const shownRef=useRef(value)
  useEffect(()=>{
    const from=shownRef.current
    if(from===value)return
    if(prefersReducedMotion()||!Number.isFinite(from)||!Number.isFinite(value)||typeof requestAnimationFrame!=='function'){shownRef.current=value;setShown(value);return}
    const started=performance.now()
    let frame=0
    const tick=(now:number)=>{
      const progress=Math.min(1,(now-started)/duration)
      const eased=1-Math.pow(1-progress,3)
      const next=progress<1?from+(value-from)*eased:value
      shownRef.current=next;setShown(next)
      if(progress<1)frame=requestAnimationFrame(tick)
    }
    frame=requestAnimationFrame(tick)
    return()=>cancelAnimationFrame(frame)
  },[value,duration])
  return shown
}

export function comparisonLabel(total:number,previous:number,partial:boolean,period:AnalyticsPeriod) {
  const words=period==='week'
    ?{sameDays:'за те же дни прошлой недели',whole:'на прошлой неделе',levelSame:'На уровне тех же дней прошлой недели',levelWhole:'На уровне прошлой недели',noneSame:'За те же дни прошлой недели расходов не было',noneWhole:'На прошлой неделе расходов не было'}
    :{sameDays:'за те же дни прошлого месяца',whole:'в прошлом месяце',levelSame:'На уровне тех же дней прошлого месяца',levelWhole:'На уровне прошлого месяца',noneSame:'За те же дни прошлого месяца расходов не было',noneWhole:'В прошлом месяце расходов не было'}
  const comparison=partial?words.sameDays:words.whole
  if(previous===0)return total===0?`Как и ${comparison}`:partial?words.noneSame:words.noneWhole
  const difference=Math.round(Math.abs(total-previous)/previous*100)
  if(difference===0)return partial?words.levelSame:words.levelWhole
  return `На ${difference}% ${total>previous?'больше':'меньше'}, чем ${comparison}`
}

export function fallbackAnalytics(bootstrap:Bootstrap,target:string,from:string,to:string,categoryId:string|null):AnalyticsData {
  const decimals=bootstrap.currencies.find((currency)=>currency.code===target)?.decimals??2
  const categories=new Map(bootstrap.categories.map((category)=>[category.id,category]))
  const periodExpenses=bootstrap.expenses.filter((expense)=>!expense.deletedAt&&!expense.voidedAt&&(!categoryId||expense.categoryId===categoryId)).map((expense)=>({expense,date:localDateKey(expense.occurredAt)})).filter((item)=>item.date>=from&&item.date<=to)
  const canConvert=(expense:Expense)=>hasRate(bootstrap.rates,expense.currency,target,localDateKey(expense.occurredAt))
  const missingCurrencies=[...new Set(periodExpenses.filter(({expense})=>!canConvert(expense)).map(({expense})=>expense.currency))]
  const expenses=periodExpenses.filter(({expense})=>canConvert(expense)).map(({expense,date})=>({expense,date,amountMinor:Math.round(convertExpense(expense,target,bootstrap.currencies,bootstrap.rates)*10**decimals)}))
  const sum=(items:typeof expenses)=>items.reduce((total,item)=>total+item.amountMinor,0)
  const dates=[...new Set(expenses.map((item)=>item.date))]
  return {currency:target,from,to,totalMinor:sum(expenses),expenseCount:periodExpenses.length,convertedCount:expenses.length,rateDate:bootstrap.rates.date,missingCurrencies,daily:dates.map((date)=>{const items=expenses.filter((item)=>item.date===date);return{date,amountMinor:sum(items),count:items.length}}),categories:[...categories.values()].map((category)=>{const items=expenses.filter((item)=>item.expense.categoryId===category.id);return{categoryId:category.id,name:category.name,color:category.color,amountMinor:sum(items),count:items.length}}),weekdays:Array.from({length:7},(_,weekday)=>{const items=expenses.filter((item)=>(weekdayFromDateKey(item.date)+1)%7===weekday);return{weekday,amountMinor:sum(items),count:items.length}}),calendar:dates.map((date)=>{const items=expenses.filter((item)=>item.date===date);return{date,amountMinor:sum(items),count:items.length}})}
}
