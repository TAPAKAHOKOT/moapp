import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { WorkspaceApiError as ApiError, getAnalytics, saveMemberSettings } from '../workspace-api'
import { patchSettings } from '../settings'
import type { SettingsPatch } from '../settings'
import type { Accent, AccountSettings, AnalyticsData, AnalyticsPeriod, BlockLayout, Expense, Tag } from '../types'
import { chartColors } from '../appearance'
import { appTimeZone, cachedNumberFormat, convertExpense, countCalendarWeekdays, hasRate, localDateKey, monthDateRange, shiftDateKey, weekDateRange, weekdayFromDateKey, workspaceCurrency } from '../utils'
import { expenseTagNames } from '../history'
import { BREAKDOWN_REST, breakdownColors, categoryBreakdown, expenseGroupKeys } from '../breakdown'
import { ChevronIcon, CurrencySheet, DragList, EditBlock, RemoveBadge, prefersReducedMotion, tap } from '../ui'
import type { Theme } from '../ui'
import { formatAnalyticsAmount, formatCompactNumber, formatWeekRange, money, pluralRu } from '../format'
import type { Bootstrap } from '../format'
import { hideBlock, isShown, reorderBlocks, screenBlocks, showBlock, toBlockLayout } from '../screen-blocks'
import type { BlockScreen, Blocks } from '../screen-blocks'

export const AnalyticsChart = lazy(() => import('../AnalyticsCharts'))

export type { AnalyticsPeriod }

export function AnalyticsView({ userId, workspaceId, bootstrap, setBootstrap = () => {}, theme, accent = 'sage', online, timeZone = appTimeZone(), blocks, period: savedPeriod, editing = false, onEditScreen = () => {}, onScreensChange = () => {} }: { userId: string; workspaceId: string; bootstrap: Bootstrap; setBootstrap?: React.Dispatch<React.SetStateAction<Bootstrap>>; theme: Theme; accent?: Accent; online: boolean; timeZone?: string
  /** Какие карточки человек оставил и в каком порядке, неделя или месяц — всё это помнит аккаунт. Карточки он
   *  убирает, возвращает и переставляет сам, в режиме «Настройка экрана» (`editing`). */
  blocks?: BlockLayout; period?: AnalyticsPeriod; editing?: boolean; onEditScreen?: (screen: BlockScreen) => void; onScreensChange?: (patch: SettingsPatch<AccountSettings>) => void }) {
  // Валюта аналитики — выбранная человеком (её помнит аккаунт), а пока он не выбирал, валюта пространства,
  // в том числе после её смены в настройках.
  const target = bootstrap.settings?.analyticsCurrency || workspaceCurrency(bootstrap)
  // Неделю или месяц аналитика открывает такими, какими их оставили, в том числе на другом устройстве.
  const [period, setPeriodState] = useState<AnalyticsPeriod>(savedPeriod ?? 'week')
  useEffect(() => { if (savedPeriod) setPeriodState(savedPeriod) }, [savedPeriod])
  const setPeriod = (next: AnalyticsPeriod) => {
    setPeriodState(next)
    if (next !== (savedPeriod ?? 'week')) onScreensChange({ analyticsPeriod: next })
  }
  const analyticsBlocks = useMemo(() => screenBlocks('analytics', blocks), [blocks])
  const pageRef = useRef<HTMLElement>(null)
  // Свёрнутые карточки стоят сразу под шапкой, поэтому настройка открывается с начала страницы.
  useEffect(() => {
    if (!editing) return
    const slot = pageRef.current?.closest<HTMLElement>('.page-slot')
    if (slot) slot.scrollTop = 0
  }, [editing])
  const [weekOffset, setWeekOffset] = useState(0)
  const [monthOffset, setMonthOffset] = useState(0)
  // Фокус на категории: тап по строке легенды сужает всё выше до неё и раскрывает её записи, второй тап возвращает всё.
  // Отдельного селекта нет — легенда и есть список категорий. Фокус живёт только до перезахода: сохранённый фильтр удивлял бы.
  const [focusedCategoryId,setFocusedCategoryId]=useState<string|null>(null)
  // Фокус на теге работает так же и вместе с фокусом на категории: «Подписки · #впн». UNTAGGED — записи без тегов.
  const [focusedTagId,setFocusedTagId]=useState<string|null>(null)
  const [allTagDetails,setAllTagDetails]=useState(false)
  const [currencySheet, setCurrencySheet] = useState(false)
  const [allDetails,setAllDetails]=useState(false)
  // Доля внутри раскрытой категории: тап по ней оставляет в списке только её записи, второй тап — все.
  const [groupKey,setGroupKey]=useState<string|null>(null)
  const [rateInfo,setRateInfo]=useState(false)
  const [remote,setRemote]=useState<{key:string;data:AnalyticsData;previousTotalMinor:number|null}|null>(null)
  const [analyticsOffline,setAnalyticsOffline]=useState(!online)
  const [analyticsLoading,setAnalyticsLoading]=useState(online)
  const [analyticsError,setAnalyticsError]=useState<string|null>(null)
  const [retryEpoch,setRetryEpoch]=useState(0)
  const today=localDateKey(new Date(),timeZone)
  const selectedWeek=weekDateRange(today,weekOffset)
  const selectedMonth=monthDateRange(today,monthOffset)
  // Фокус живёт в легенде: убрали карточку — фокус не действует, иначе итог сужался бы без видимой причины.
  const categoriesShown=isShown(analyticsBlocks,'categories')
  const tagsShown=isShown(analyticsBlocks,'tags')
  const categoryId=categoriesShown&&focusedCategoryId&&bootstrap.categories.some((category)=>category.id===focusedCategoryId)?focusedCategoryId:null
  const tagId=tagsShown&&(focusedTagId===UNTAGGED||focusedTagId&&(bootstrap.tags??[]).some((tag)=>tag.id===focusedTagId))?focusedTagId:null
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
  const requestKey=`${expenseRevision}:${from}:${analyticsTo}:${target}:${period}:${categoryId??'all'}:${tagId??'all'}:${timeZone}`
  const fallback=useMemo(()=>fallbackAnalytics(bootstrap,target,from,analyticsTo,categoryId,tagId),[bootstrap,target,from,analyticsTo,categoryId,tagId])
  const previousFallback=useMemo(()=>fallbackAnalytics(bootstrap,target,previousRange.from,previousTo,categoryId,tagId),[bootstrap,target,previousRange.from,previousTo,categoryId,tagId])
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
    const filter={categoryId:categoryId??undefined,tagId:tagId??undefined}
    Promise.all([getAnalytics(workspaceId,from,analyticsTo,target,filter,controller.signal),getAnalytics(workspaceId,previousRange.from,previousTo,target,filter,controller.signal)]).then(([result,previous])=>{
      if(!active)return
      const entry={data:result,previousTotalMinor:previous.totalMinor}
      cache.current.set(requestKey,entry)
      if(cache.current.size>40)cache.current.delete(cache.current.keys().next().value!)
      setRemote({key:requestKey,...entry});setAnalyticsOffline(false);setAnalyticsLoading(false)
    }).catch((reason)=>{if(active&&!controller.signal.aborted){setRemote(null);setAnalyticsOffline(true);setAnalyticsError(reason instanceof ApiError?reason.message:'Сервер аналитики недоступен');setAnalyticsLoading(false)}})
    return()=>{active=false;controller.abort()}
  },[workspaceId,from,analyticsTo,target,categoryId,tagId,previousRange.from,previousTo,requestKey,online,retryEpoch])
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
  useEffect(()=>{setAllDetails(false);setAllTagDetails(false);setGroupKey(null)},[period,from,categoryId,tagId])
  // Записи периода под обоими фокусами — из них раскрываются и категория, и тег.
  const focusedDetails=useMemo(()=>bootstrap.expenses.filter((expense)=>!expense.deletedAt&&!expense.voidedAt&&(!categoryId||expense.categoryId===categoryId)&&hasTag(expense,tagId,bootstrap.tags??[])).map((expense)=>({expense,date:localDateKey(expense.occurredAt)})).filter((item)=>item.date>=from&&item.date<=analyticsTo).sort((left,right)=>right.expense.occurredAt.localeCompare(left.expense.occurredAt)),[bootstrap.expenses,bootstrap.tags,categoryId,tagId,from,analyticsTo])
  const categoryDetails=categoryId?focusedDetails:[]
  const tagDetails=tagId?focusedDetails:[]
  const byTag=(data.tags??[]).filter((item)=>item.amountMinor>0).map((item)=>({...item,id:item.tagId??UNTAGGED,label:item.tagId?`#${item.name}`:'Без тега',value:item.amountMinor/divisor})).sort((left,right)=>Number(!left.tagId)-Number(!right.tagId))
  // Графики — в своём цвете человека; теги без цвета получают его оттенки.
  const chart=chartColors(accent,theme)
  const tagShades=breakdownColors(chart.line,byTag.filter((item)=>item.tagId).map((item)=>({key:item.id})))
  const tagColors=byTag.map((item)=>item.tagId?item.color||tagShades[byTag.filter((other)=>other.tagId).indexOf(item)]:'#a9afa5')
  const showTags=Boolean(tagId||byTag.some((item)=>item.tagId))
  const focusedColor=categoryId?bootstrap.categories.find((category)=>category.id===categoryId)?.color||'#a9afa5':'#a9afa5'
  const breakdown=useMemo(()=>categoryBreakdown(categoryDetails.filter(({expense})=>hasRate(bootstrap.rates,expense.currency,target,localDateKey(expense.occurredAt))).map(({expense})=>({expense,value:convertExpense(expense,target,bootstrap.currencies,bootstrap.rates)})),bootstrap.tags??[]),[categoryDetails,bootstrap.rates,bootstrap.currencies,bootstrap.tags,target])
  // Одна доля из одной записи повторяет саму запись — такую разбивку не показываем. «#кофе · 2 — 100%» уже говорит, на что ушли деньги.
  const groups=breakdown.groups.length>1||breakdown.groups[0]?.count>1?breakdown.groups:[]
  const groupColors=breakdownColors(focusedColor,groups)
  const groupTotal=groups.reduce((sum,group)=>sum+group.value,0)
  const activeGroup=groups.some((group)=>group.key===groupKey)?groupKey:null
  const inGroup=(expense:Expense)=>{if(!activeGroup)return true;const keys=expenseGroupKeys(expense,bootstrap.tags??[]).map((item)=>item.key);return activeGroup===BREAKDOWN_REST?keys.some((key)=>breakdown.rest.includes(key)):keys.includes(activeGroup)}
  const pickGroup=(key:string)=>{tap(4);setAllDetails(false);setGroupKey((current)=>current===key?null:key)}
  const donut=groups.length?groups.map((group,index)=>({name:group.label,value:group.value,color:groupColors[index]})):byCategory.map((x)=>({name:x.name,value:x.value,color:x.color||'#a9afa5'}))
  // Запись подписана тегом — своим словом. Название продавца из выписки карты («OPENAI *CHATGPT SUBSCR») —
  // подпись на крайний случай: она годится, только когда своего слова у записи нет.
  const detailCaption=(expense:Expense)=>{const names=expenseTagNames(expense,bootstrap.tags??[]);if(names.length)return ` · ${names.map((name)=>`#${name}`).join(' ')}`;return expense.note?` · ${expense.note}`:''}
  // В теге запись подписана категорией — тег и так известен; остальные теги и продавец помогают узнать запись.
  const tagCaption=(expense:Expense)=>{const others=expenseTagNames(expense,bootstrap.tags??[]).filter((name)=>tagId===UNTAGGED||(bootstrap.tags??[]).find((tag)=>tag.id===tagId)?.name!==name);return ` · ${[categoryName(expense.categoryId),others.map((name)=>`#${name}`).join(' '),others.length?'':expense.note??''].filter(Boolean).join(' · ')}`}
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
  const focusedTagLabel=tagId?tagId===UNTAGGED?'Без тега':`#${(bootstrap.tags??[]).find((tag)=>tag.id===tagId)?.name}`:null
  const focusedName=[categoryId?bootstrap.categories.find((category)=>category.id===categoryId)?.name:null,focusedTagLabel].filter(Boolean).join(' · ')||null
  const categoryName=(id:string)=>bootstrap.categories.find((category)=>category.id===id)?.name??''
  // О пересчёте валют говорим только когда он есть: в периоде встретились расходы не в валюте аналитики.
  const hasForeign=bootstrap.expenses.some((expense)=>{if(expense.deletedAt||expense.voidedAt||expense.currency===target)return false;const date=localDateKey(expense.occurredAt);return date>=from&&date<=analyticsTo})
  const focus=(id:string)=>{tap(4);setAllDetails(false);setRateInfo(false);setFocusedCategoryId((current)=>current===id?null:id)}
  const focusTag=(id:string)=>{tap(4);setAllTagDetails(false);setRateInfo(false);setFocusedTagId((current)=>current===id?null:id)}
  const detailRow=({expense,date}:{expense:Expense;date:string},caption:string)=><div key={expense.id} className="legend-detail"><span><b>{detailDate(date)}</b>{caption}</span><span className="legend-value"><b>{money(expense.amountMinor,expense.currency,bootstrap.currencies)}</b>{expense.currency!==target&&<small>≈ {formatAnalyticsAmount(convertExpense(expense,target,bootstrap.currencies,bootstrap.rates),target)}</small>}</span></div>
  // Пустое пространство и пустой период — разные случаи: в первом человек ещё не знает, что тут вообще будет.
  const anyExpenses=bootstrap.expenses.some((expense)=>!expense.deletedAt)
  const emptyPeriod=anyExpenses?'В этом периоде ещё нет расходов':'Появится после первых трат: сколько за месяц и на что'
  const chartColor=chart.line
  const chartText=theme==='dark'?'#b3b3ae':'#73776f'
  const chartGrid=theme==='dark'?'rgba(255,255,255,.06)':'rgba(32,37,31,.06)'
  const statusLine=analyticsOffline?<>{analyticsError?'Не удалось обновить. ':''}Показаны сохранённые данные на {new Date(bootstrap.serverTime).toLocaleString('ru-RU')}{online&&<button type="button" onClick={()=>setRetryEpoch((value)=>value+1)}>Повторить</button>}</>:data.missingCurrencies.length?`Нет курса: ${data.missingCurrencies.join(', ')} — эти расходы не посчитаны`:null
  return <section ref={pageRef} className={`page analytics${editing?' arranging':''}`}><div className={`analytics-progress${slowLoading?' on':''}`} aria-hidden="true"/><div className="analytics-fixed" inert={editing}><header className="page-header analytics-title"><div><p className="eyebrow">{focusedName??'Все расходы'}</p><h1>{cachedNumberFormat('ru-RU',{maximumFractionDigits:0}).format(shownTotal)}{hasForeign&&<button type="button" className="rate-info" aria-label="Как посчитана сумма" aria-expanded={rateInfo} onClick={()=>setRateInfo((value)=>!value)}>i</button>}</h1><p className="analytics-comparison">{formatAnalyticsAmount(shownPerDay,target)} в день · {data.expenseCount} {pluralRu(data.expenseCount,['операция','операции','операций'])}</p><p className="analytics-comparison">{comparisonLabel(total,previousTotal,partial,period)}</p></div><button className="currency-choice" onClick={()=>setCurrencySheet(true)}>{target}<ChevronIcon/></button></header>
    {rateInfo&&hasForeign&&<p className="rate-caption" role="note">Расходы в других валютах пересчитаны в {target} по курсу на день покупки.</p>}
    <div className="analytics-period" role="group" aria-label="Период аналитики"><button type="button" aria-pressed={period==='week'} className={period==='week'?'selected':''} onClick={()=>setPeriod('week')}>Неделя</button><button type="button" aria-pressed={period==='month'} className={period==='month'?'selected':''} onClick={()=>setPeriod('month')}>Месяц</button></div>
    {period==='week'&&<div className="week-navigator"><button type="button" onClick={()=>setWeekOffset((value)=>value-1)} aria-label="Предыдущая неделя">‹</button><div><b>{weekOffset===0?'Текущая неделя':weekOffset===-1?'Прошлая неделя':'Выбранная неделя'}</b><span>{weekRange}</span></div><button type="button" onClick={()=>setWeekOffset((value)=>Math.min(0,value+1))} disabled={weekOffset===0} aria-label="Следующая неделя">›</button></div>}
    {period==='month'&&<div className="week-navigator"><button type="button" onClick={()=>setMonthOffset((value)=>value-1)} aria-label="Предыдущий месяц">‹</button><div><b>{monthOffset===0?'Текущий месяц':monthOffset===-1?'Прошлый месяц':'Выбранный месяц'}</b><span>{monthLabel}</span></div><button type="button" onClick={()=>setMonthOffset((value)=>Math.min(0,value+1))} disabled={monthOffset===0} aria-label="Следующий месяц">›</button></div>}
    {statusLine&&<div className={`rate-caption${analyticsOffline?' cached':''}`} role="status">{statusLine}</div>}</div>
    {editing?<AnalyticsBlocksEditor blocks={analyticsBlocks} onChange={(next)=>onScreensChange({analyticsBlocks:toBlockLayout(next)})}/>:analyticsBlocks.shown.map((block)=>block.id==='trend'?<div key="trend" className="chart-card"><div><h2>Динамика</h2><p>{period==='week'?'Понедельник — воскресенье':'По дням выбранного месяца'}</p></div>{data.convertedCount?<div className="line-chart"><Suspense fallback={<ChartSkeleton/>}><AnalyticsChart kind="line" labels={days.map((d)=>new Date(`${d}T12:00`).toLocaleDateString('ru-RU',period==='week'?{weekday:'short'}:{day:'numeric',month:'short'}))} values={byDay} color={chartColor} fillColor={chart.fill} pointRadius={period==='week'?3:0} target={target} textColor={chartText} gridColor={chartGrid} maxTicksLimit={period==='week'?7:6}/></Suspense></div>:<AnalyticsEmpty>{data.expenseCount?'Нет курса для выбранной валюты':emptyPeriod}</AnalyticsEmpty>}</div>
      :block.id==='categories'?<div key="categories" className={`chart-card${byCategory.length?' split':''}`}><div><h2>Категории</h2><p>{categoryId?'Только эта категория':tagId?`Только ${focusedTagLabel}`:period==='week'?'За неделю':'За месяц'}</p></div>{byCategory.length?<><div className="donut-wrap"><Suspense fallback={<ChartSkeleton/>}><AnalyticsChart kind="doughnut" labels={donut.map((x)=>x.name)} values={donut.map((x)=>x.value)} colors={donut.map((x)=>x.color)} target={target}/></Suspense><span>{formatCompactNumber(total)}</span></div><div className="legend">{byCategory.map((x)=>{const focused=categoryId===x.categoryId;const rows=focused?categoryDetails.filter(({expense})=>inGroup(expense)):[];const shown=allDetails?rows:rows.slice(0,LEGEND_DETAIL_LIMIT);return <div key={x.categoryId} className={`legend-item${focused?' open':''}`}><button type="button" className="legend-row" aria-expanded={focused} onClick={()=>focus(x.categoryId)}><i style={{background:x.color||'#a9afa5'}}/><span>{x.name}</span><span className="legend-value"><b>{formatAnalyticsAmount(x.value,target)}</b><small className={focused?'ghost':undefined} aria-hidden={focused||undefined}>{Math.round(x.value/total*100)||0}%</small></span>{focused?<span className="legend-close" aria-hidden="true">×</span>:<ChevronIcon/>}</button>{focused&&<div className="legend-details">{groups.length>0&&<div className="legend-groups" role="group" aria-label="Из чего сложилась категория">{groups.map((group,index)=><button key={group.key} type="button" className={`legend-group${activeGroup===group.key?' selected':''}${activeGroup&&activeGroup!==group.key?' dim':''}`} aria-pressed={activeGroup===group.key} onClick={()=>pickGroup(group.key)}><i style={{background:groupColors[index]}}/><span>{group.label}{group.count>1&&<small> · {group.count}</small>}</span><span className="legend-value"><b>{formatAnalyticsAmount(group.value,target)}</b><small>{Math.round(group.value/(groupTotal||1)*100)}%</small></span></button>)}</div>}{rows.length?<>{shown.map((item)=>detailRow(item,detailCaption(item.expense)))}{rows.length>shown.length&&<button type="button" className="legend-more" onClick={()=>setAllDetails(true)}>Показать все · {rows.length}</button>}</>:<p className="legend-empty">На этом устройстве нет записей этой категории за период.</p>}</div>}</div>})}{categoryId&&<button type="button" className="legend-all" onClick={()=>focus(categoryId)}>Все категории</button>}</div></>:<AnalyticsEmpty>{emptyPeriod}</AnalyticsEmpty>}</div>
      :block.id==='tags'?(showTags&&<div key="tags" className={`chart-card${byTag.length?' split':''}`}><div><h2>Теги</h2><p>{tagId?'Только этот тег':categoryId?'В этой категории':period==='week'?'За неделю':'За месяц'}</p></div>{byTag.length?<><div className="donut-wrap"><Suspense fallback={<ChartSkeleton/>}><AnalyticsChart kind="doughnut" labels={byTag.map((x)=>x.label)} values={byTag.map((x)=>x.value)} colors={tagColors} target={target}/></Suspense><span>{formatCompactNumber(total)}</span></div><div className="legend tag-legend">{byTag.map((x,index)=>{const focused=tagId===x.id;const shown=allTagDetails?tagDetails:tagDetails.slice(0,LEGEND_DETAIL_LIMIT);return <div key={x.id} className={`legend-item${focused?' open':''}`}><button type="button" className="legend-row" aria-expanded={focused} onClick={()=>focusTag(x.id)}><i style={{background:tagColors[index]}}/><span>{x.label}</span><span className="legend-value"><b>{formatAnalyticsAmount(x.value,target)}</b><small className={focused?'ghost':undefined} aria-hidden={focused||undefined}>{Math.round(x.value/total*100)||0}%</small></span>{focused?<span className="legend-close" aria-hidden="true">×</span>:<ChevronIcon/>}</button>{focused&&<div className="legend-details">{tagDetails.length?<>{shown.map((item)=>detailRow(item,tagCaption(item.expense)))}{tagDetails.length>shown.length&&<button type="button" className="legend-more" onClick={()=>setAllTagDetails(true)}>Показать все · {tagDetails.length}</button>}</>:<p className="legend-empty">На этом устройстве нет записей с этим тегом за период.</p>}</div>}</div>})}{tagId&&<button type="button" className="legend-all" onClick={()=>focusTag(tagId)}>Все теги</button>}</div></>:<AnalyticsEmpty>{emptyPeriod}</AnalyticsEmpty>}</div>)
      :block.id==='weekdays'?(period==='month'&&<div key="weekdays" className="chart-card"><div><h2>По дням недели</h2><p>Средние траты за календарный день</p></div>{data.convertedCount?<div className="bar-chart"><Suspense fallback={<ChartSkeleton/>}><AnalyticsChart kind="bar" labels={['Пн','Вт','Ср','Чт','Пт','Сб','Вс']} values={weekdays} color={chartColor} target={target} textColor={chartText} gridColor={chartGrid}/></Suspense></div>:<AnalyticsEmpty>Недостаточно данных для сравнения</AnalyticsEmpty>}</div>)
      :null)}
    {anyExpenses&&!editing&&<button type="button" className="screen-setup" onClick={()=>onEditScreen('analytics')}>Настроить экран</button>}
    {currencySheet && <CurrencySheet currencies={bootstrap.currencies} used={[...new Set(bootstrap.expenses.filter((item)=>!item.deletedAt).map((item)=>item.currency))]} selected={target} onClose={()=>setCurrencySheet(false)} onSelect={(code)=>{setBootstrap((data)=>({...data,settings:patchSettings(data.settings,{analyticsCurrency:code})}));saveMemberSettings(userId,workspaceId,{analyticsCurrency:code});setCurrencySheet(false)}}/>}
  </section>
}

export const LEGEND_DETAIL_LIMIT=8

// Значки свёрнутых карточек: по ним карточку узнают, пока графики спрятаны на время настройки.
const BLOCK_ICONS:Record<string,React.ReactNode>={
  trend:<path d="M3 14l4.2-4.2 3.3 3 6.5-6.8"/>,
  categories:<><circle cx="10" cy="10" r="6.5"/><path d="M10 3.5V10l4.6 4.6"/></>,
  tags:<><path d="M3.5 4.3v4.9c0 .3.1.5.3.7l6.6 6.6c.4.4 1 .4 1.4 0l4.6-4.6c.4-.4.4-1 0-1.4L9.8 3.8c-.2-.2-.4-.3-.7-.3H4.3c-.4 0-.8.4-.8.8z"/><circle cx="7" cy="7" r=".9" fill="currentColor" stroke="none"/></>,
  weekdays:<path d="M4.5 16.5v-5M8.2 16.5v-9M11.8 16.5v-6.5M15.5 16.5v-11"/>,
}

// Режим «Настройка экрана»: карточки свёрнуты в плашки — значок, название и что в ней. «−» в углу убирает карточку,
// ≡ переставляет, убранные ждут внизу пунктиром и возвращаются в конец по касанию.
export function AnalyticsBlocksEditor({blocks,onChange}:{blocks:Blocks;onChange:(next:Blocks)=>void}) {
  return <div className="edit-cards" role="group" aria-label="Карточки аналитики">
    <DragList className="edit-card-list" items={blocks.shown} onReorder={(ids)=>onChange(reorderBlocks(blocks,ids))} render={(block)=><>
      <span className="block-icon" aria-hidden="true"><svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{BLOCK_ICONS[block.id]}</svg></span>
      <span className="block-name"><b>{block.name}</b><small>{block.hint}</small></span>
      <RemoveBadge name={block.name} onRemove={()=>onChange(hideBlock(blocks,block.id))}/>
    </>}/>
    {blocks.hidden.map((block)=><EditBlock key={block.id} name={block.name} hint={block.hint} shown={false} className="edit-card" onToggle={()=>onChange(showBlock(blocks,block.id))}/>)}
  </div>
}

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

// Одна строка при любых числах: «+3252% к тем же дням прошлого месяца» не должно переносить шапку.
export function comparisonLabel(total:number,previous:number,partial:boolean,period:AnalyticsPeriod) {
  const same=period==='week'?'за те же дни прошлой недели':'за те же дни прошлого месяца'
  const whole=period==='week'?'на прошлой неделе':'в прошлом месяце'
  const to=period==='week'?(partial?'к тем же дням прошлой недели':'к прошлой неделе'):(partial?'к тем же дням прошлого месяца':'к прошлому месяцу')
  const capital=(text:string)=>text.charAt(0).toUpperCase()+text.slice(1)
  if(previous===0)return total===0?`Как и ${partial?same:whole}`:`${capital(partial?same:whole)} — 0`
  const difference=Math.round(Math.abs(total-previous)/previous*100)
  if(difference===0)return `Как ${partial?same:whole}`
  return `${total>previous?'+':'−'}${difference}% ${to}`
}

export const UNTAGGED='none'

// Теги, которых уже нет, не считаются — как и на сервере, где связь с удалённым тегом исчезает.
function liveTagIds(expense:Pick<Expense,'tagIds'>,tags:Tag[]) {
  return [...new Set(expense.tagIds??[])].filter((id)=>tags.some((tag)=>tag.id===id))
}

export function hasTag(expense:Pick<Expense,'tagIds'>,tagId:string|null,tags:Tag[]) {
  if(!tagId)return true
  const ids=liveTagIds(expense,tags)
  return tagId===UNTAGGED?ids.length===0:ids.includes(tagId)
}

export function fallbackAnalytics(bootstrap:Bootstrap,target:string,from:string,to:string,categoryId:string|null,tagId:string|null=null):AnalyticsData {
  const decimals=bootstrap.currencies.find((currency)=>currency.code===target)?.decimals??2
  const categories=new Map(bootstrap.categories.map((category)=>[category.id,category]))
  const tags=bootstrap.tags??[]
  const periodExpenses=bootstrap.expenses.filter((expense)=>!expense.deletedAt&&!expense.voidedAt&&(!categoryId||expense.categoryId===categoryId)&&hasTag(expense,tagId,tags)).map((expense)=>({expense,date:localDateKey(expense.occurredAt)})).filter((item)=>item.date>=from&&item.date<=to)
  const canConvert=(expense:Expense)=>hasRate(bootstrap.rates,expense.currency,target,localDateKey(expense.occurredAt))
  const missingCurrencies=[...new Set(periodExpenses.filter(({expense})=>!canConvert(expense)).map(({expense})=>expense.currency))]
  const expenses=periodExpenses.filter(({expense})=>canConvert(expense)).map(({expense,date})=>({expense,date,amountMinor:Math.round(convertExpense(expense,target,bootstrap.currencies,bootstrap.rates)*(tagId&&tagId!==UNTAGGED?1/liveTagIds(expense,tags).length:1)*10**decimals)}))
  const tagTotals=new Map<string,{amountMinor:number;count:number}>()
  for(const item of expenses){const ids=tagId?[tagId]:liveTagIds(item.expense,tags);const keys=ids.length?ids:[UNTAGGED];for(const key of keys){const point=tagTotals.get(key)??{amountMinor:0,count:0};point.amountMinor+=Math.round(item.amountMinor/keys.length);point.count++;tagTotals.set(key,point)}}
  const sum=(items:typeof expenses)=>items.reduce((total,item)=>total+item.amountMinor,0)
  const dates=[...new Set(expenses.map((item)=>item.date))]
  return {currency:target,from,to,totalMinor:sum(expenses),expenseCount:periodExpenses.length,convertedCount:expenses.length,rateDate:bootstrap.rates.date,missingCurrencies,daily:dates.map((date)=>{const items=expenses.filter((item)=>item.date===date);return{date,amountMinor:sum(items),count:items.length}}),categories:[...categories.values()].map((category)=>{const items=expenses.filter((item)=>item.expense.categoryId===category.id);return{categoryId:category.id,name:category.name,color:category.color,amountMinor:sum(items),count:items.length}}),tags:[...tagTotals].map(([key,point])=>{const tag=tags.find((item)=>item.id===key);return{tagId:key===UNTAGGED?null:key,name:key===UNTAGGED?null:tag?.name??'',color:key===UNTAGGED?null:tag?.color??null,...point}}).sort((left,right)=>right.amountMinor-left.amountMinor),weekdays:Array.from({length:7},(_,weekday)=>{const items=expenses.filter((item)=>(weekdayFromDateKey(item.date)+1)%7===weekday);return{weekday,amountMinor:sum(items),count:items.length}}),calendar:dates.map((date)=>{const items=expenses.filter((item)=>item.date===date);return{date,amountMinor:sum(items),count:items.length}})}
}
