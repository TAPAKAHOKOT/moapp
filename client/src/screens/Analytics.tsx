import { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { WorkspaceApiError as ApiError, getAnalytics, saveMemberSettings } from '../workspace-api'
import { patchSettings } from '../settings'
import type { SettingsPatch } from '../settings'
import type { Accent, AccountSettings, AnalyticsData, AnalyticsPeriod, AnalyticsRange, BlockLayout, Expense, Tag } from '../types'
import { chartColors } from '../appearance'
import { appTimeZone, cachedNumberFormat, convertExpense, countCalendarWeekdays, hasRate, localDateKey, monthDateRange, shiftDateKey, startOfWeekDateKey, weekDateRange, weekdayFromDateKey, workspaceCurrency } from '../utils'
import { expenseTagNames } from '../history'
import { BREAKDOWN_REST, breakdownColors, categoryBreakdown, expenseGroupKeys } from '../breakdown'
import { CategoryMark, ChevronIcon, CurrencySheet, DragList, EditBlock, RemoveBadge, prefersReducedMotion, tap, useFlip, useHold } from '../ui'
import type { Theme } from '../ui'
import { formatAnalyticsAmount, formatCompactNumber, formatDateRange, formatWeekRange, money, pluralRu } from '../format'
import type { Bootstrap } from '../format'
import { hideBlock, isShown, isSmall, reorderBlocks, screenBlocks, showBlock, toBlockLayout, toggleSize } from '../screen-blocks'
import type { BlockScreen, Blocks } from '../screen-blocks'
import { CalendarSheet } from './History'

export const AnalyticsChart = lazy(() => import('../AnalyticsCharts'))

export type { AnalyticsPeriod }

// Вкладка не размонтируется, пока открыто пространство, поэтому она не должна перерисовываться от чужих изменений
// состояния приложения — только от своих данных и колбэков (все они стабильны у родителя).
export const AnalyticsView = memo(function AnalyticsView({ userId, workspaceId, bootstrap, setBootstrap = () => {}, theme, accent = 'sage', online, timeZone = appTimeZone(), today = localDateKey(new Date(), timeZone), blocks, period: savedPeriod, range: savedRange, editing = false, onEditScreen = () => {}, onScreensChange = () => {} }: { userId: string; workspaceId: string; bootstrap: Bootstrap; setBootstrap?: React.Dispatch<React.SetStateAction<Bootstrap>>; theme: Theme; accent?: Accent; online: boolean; timeZone?: string
  /** Сегодняшний день по календарю телефона. Его ведёт приложение: мемоизированный экран сам после полуночи не
   *  перерисуется, и без этого «Текущая неделя» осталась бы вчерашней. */
  today?: string
  /** Какие карточки человек оставил и в каком порядке, неделя, месяц или свои даты — всё это помнит аккаунт.
   *  Карточки он убирает, возвращает и переставляет сам, в режиме «Настройка экрана» (`editing`). */
  blocks?: BlockLayout; period?: AnalyticsPeriod; range?: AnalyticsRange; editing?: boolean; onEditScreen?: (screen: BlockScreen, how?: 'hold' | 'tap') => void; onScreensChange?: (patch: SettingsPatch<AccountSettings>) => void }) {
  // Валюта аналитики — выбранная человеком (её помнит аккаунт), а пока он не выбирал, валюта пространства,
  // в том числе после её смены в настройках.
  const target = bootstrap.settings?.analyticsCurrency || workspaceCurrency(bootstrap)
  // Неделю, месяц или свои даты аналитика открывает такими, какими их оставили, в том числе на другом устройстве.
  const [periodChoice, setPeriodChoice] = useState<AnalyticsPeriod>(savedPeriod ?? 'week')
  useEffect(() => { if (savedPeriod) setPeriodChoice(savedPeriod) }, [savedPeriod])
  const [range, setRange] = useState<AnalyticsRange | null>(savedRange ?? null)
  useEffect(() => { if (savedRange) setRange(savedRange) }, [savedRange])
  const period: AnalyticsPeriod = periodChoice === 'range' && !range ? 'week' : periodChoice
  const [rangeSheet, setRangeSheet] = useState(false)
  // «Даты» открывают запомненные даты, а пока их нет — календарь. Нажатие на уже выбранные «Даты» тоже открывает
  // календарь: так даты меняют.
  const setPeriod = (next: AnalyticsPeriod) => {
    if (next === 'range' && (!range || period === 'range')) { tap(4); setRangeSheet(true); return }
    setPeriodChoice(next)
    if (next !== (savedPeriod ?? 'week')) onScreensChange({ analyticsPeriod: next })
  }
  const pickRange = (from: string, to: string) => {
    const next = { from, to }
    setRangeSheet(false); setRange(next); setPeriodChoice('range')
    onScreensChange({ analyticsPeriod: 'range', analyticsRange: next })
  }
  // Стрелки листают свои даты отрезками той же длины: перед «3–17 сент.» — 15 дней до них.
  const shiftRange = (direction: number) => {
    if (!range) return
    const offset = spanDays(range.from, range.to) * direction
    const next = { from: shiftDateKey(range.from, offset), to: shiftDateKey(range.to, offset) }
    setRange(next)
    onScreensChange({ analyticsRange: next })
  }
  const analyticsBlocks = useMemo(() => screenBlocks('analytics', blocks), [blocks])
  const pageRef = useRef<HTMLElement | null>(null)
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
  const selectedWeek=weekDateRange(today,weekOffset)
  const selectedMonth=monthDateRange(today,monthOffset)
  // Фокус живёт в легенде большой карточки: убрали карточку или сделали маленькой — фокус не действует, иначе итог
  // сужался бы без видимой причины.
  const categoriesShown=isShown(analyticsBlocks,'categories')&&!isSmall(analyticsBlocks,'categories')
  const tagsShown=isShown(analyticsBlocks,'tags')&&!isSmall(analyticsBlocks,'tags')
  const categoryId=categoriesShown&&focusedCategoryId&&bootstrap.categories.some((category)=>category.id===focusedCategoryId)?focusedCategoryId:null
  const tagId=tagsShown&&(focusedTagId===UNTAGGED||focusedTagId&&(bootstrap.tags??[]).some((tag)=>tag.id===focusedTagId))?focusedTagId:null
  const selectedRange=period==='week'?selectedWeek:period==='month'?selectedMonth:range??selectedWeek
  const from=selectedRange.from
  // График обрывается на сегодняшнем дне: ещё не наступившие дни — не нули. От дат целиком в будущем остаётся их первый день.
  const analyticsTo=selectedRange.to<=today?selectedRange.to:from>today?from:today
  const periodDays=spanDays(from,analyticsTo)
  const periodLength=spanDays(from,selectedRange.to)
  // Сравнение с прошлым периодом — за те же дни, пока текущий период не закончился; и для недели, и для месяца.
  // Свои даты сравниваются с таким же числом дней прямо перед ними.
  const partial=analyticsTo<selectedRange.to
  const previousRange=period==='week'?weekDateRange(today,weekOffset-1):period==='month'?monthDateRange(today,monthOffset-1):{from:shiftDateKey(from,-periodLength),to:shiftDateKey(from,-1)}
  const previousSameDays=shiftDateKey(previousRange.from,periodDays-1)
  const previousFrom=period==='range'?shiftDateKey(from,-periodDays):previousRange.from
  const previousTo=period==='range'?previousRange.to:partial&&previousSameDays<previousRange.to?previousSameDays:previousRange.to
  // Расчёт опирается только на расходы, курсы и справочники пространства. Рядом в тех же данных лежат личные
  // настройки — фильтры «Истории», последняя валюта, — и их смена не должна заново проходить по всем расходам.
  const source=useMemo<AnalyticsSource>(()=>({expenses:bootstrap.expenses,categories:bootstrap.categories,tags:bootstrap.tags,currencies:bootstrap.currencies,rates:bootstrap.rates}),[bootstrap.expenses,bootstrap.categories,bootstrap.tags,bootstrap.currencies,bootstrap.rates])
  const expenseRevision=useMemo(()=>expensesRevision(bootstrap.expenses),[bootstrap.expenses])
  const requestKey=`${expenseRevision}:${from}:${analyticsTo}:${target}:${period}:${categoryId??'all'}:${tagId??'all'}:${timeZone}`
  const fallback=useMemo(()=>fallbackAnalytics(source,target,from,analyticsTo,categoryId,tagId),[source,target,from,analyticsTo,categoryId,tagId])
  const previousFallback=useMemo(()=>fallbackAnalytics(source,target,previousFrom,previousTo,categoryId,tagId),[source,target,previousFrom,previousTo,categoryId,tagId])
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
    Promise.all([getAnalytics(workspaceId,from,analyticsTo,target,filter,controller.signal),getAnalytics(workspaceId,previousFrom,previousTo,target,filter,controller.signal)]).then(([result,previous])=>{
      if(!active)return
      const entry={data:result,previousTotalMinor:previous.totalMinor}
      cache.current.set(requestKey,entry)
      if(cache.current.size>40)cache.current.delete(cache.current.keys().next().value!)
      setRemote({key:requestKey,...entry});setAnalyticsOffline(false);setAnalyticsLoading(false)
    }).catch((reason)=>{if(active&&!controller.signal.aborted){setRemote(null);setAnalyticsOffline(true);setAnalyticsError(reason instanceof ApiError?reason.message:'Сервер аналитики недоступен');setAnalyticsLoading(false)}})
    return()=>{active=false;controller.abort()}
  },[workspaceId,from,analyticsTo,target,categoryId,tagId,previousFrom,previousTo,requestKey,online,retryEpoch])
  // Индикатор загрузки появляется только если сервер думает дольше 300 мс, и не трогает раскладку.
  const [slowLoading,setSlowLoading]=useState(false)
  useEffect(()=>{if(!analyticsLoading){setSlowLoading(false);return}const timer=setTimeout(()=>setSlowLoading(true),300);return()=>clearTimeout(timer)},[analyticsLoading])
  const data=remote?.key===requestKey?remote.data:fallback
  const previousTotalMinor=remote?.key===requestKey?remote.previousTotalMinor:previousFallback.totalMinor
  const decimals=bootstrap.currencies.find((currency)=>currency.code===target)?.decimals??2
  const divisor=10**decimals
  const days=useMemo(()=>Array.from({length:periodDays},(_,index)=>shiftDateKey(from,index)),[from,periodDays])
  const dailyMap=new Map(data.daily.map((point)=>[point.date,point.amountMinor/divisor]))
  const byDay=days.map((date)=>dailyMap.get(date)||0)
  const byCategory=data.categories.filter((item)=>item.amountMinor>0).map((item)=>({...item,value:item.amountMinor/divisor}))
  useEffect(()=>{setAllDetails(false);setAllTagDetails(false);setGroupKey(null)},[period,from,categoryId,tagId])
  // Записи периода под обоими фокусами — из них раскрываются и категория, и тег, и из них же «Крупные траты».
  // Без фокуса и без этой карточки они не нужны, и лишнего прохода по всем расходам нет.
  const topShown=isShown(analyticsBlocks,'top')
  const focusedDetails=useMemo(()=>!categoryId&&!tagId&&!topShown?[]:bootstrap.expenses.filter((expense)=>!expense.deletedAt&&!expense.voidedAt&&(!categoryId||expense.categoryId===categoryId)&&hasTag(expense,tagId,bootstrap.tags??[])).map((expense)=>({expense,date:localDateKey(expense.occurredAt)})).filter((item)=>item.date>=from&&item.date<=analyticsTo).sort((left,right)=>right.expense.occurredAt.localeCompare(left.expense.occurredAt)),[bootstrap.expenses,bootstrap.tags,categoryId,tagId,from,analyticsTo,topShown])
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
  const weekRange=formatWeekRange(selectedWeek.from,selectedWeek.to)
  const monthLabel=new Date(`${selectedMonth.from}T12:00:00Z`).toLocaleDateString('ru-RU',{timeZone:'UTC',month:'long',year:'numeric'})
  const rangeLabel=formatDateRange(from,selectedRange.to)
  const focusedTagLabel=tagId?tagId===UNTAGGED?'Без тега':`#${(bootstrap.tags??[]).find((tag)=>tag.id===tagId)?.name}`:null
  const focusedName=[categoryId?bootstrap.categories.find((category)=>category.id===categoryId)?.name:null,focusedTagLabel].filter(Boolean).join(' · ')||null
  const categoryName=(id:string)=>bootstrap.categories.find((category)=>category.id===id)?.name??''
  // О пересчёте валют говорим только когда он есть: в периоде встретились расходы не в валюте аналитики.
  const hasForeign=useMemo(()=>bootstrap.expenses.some((expense)=>{if(expense.deletedAt||expense.voidedAt||expense.currency===target)return false;const date=localDateKey(expense.occurredAt);return date>=from&&date<=analyticsTo}),[bootstrap.expenses,target,from,analyticsTo,timeZone])
  const focus=(id:string)=>{tap(4);setAllDetails(false);setRateInfo(false);setFocusedCategoryId((current)=>current===id?null:id)}
  const focusTag=(id:string)=>{tap(4);setAllTagDetails(false);setRateInfo(false);setFocusedTagId((current)=>current===id?null:id)}
  const detailRow=({expense,date}:{expense:Expense;date:string},caption:string)=><div key={expense.id} className="legend-detail"><span><b>{detailDate(date)}</b>{caption}</span><span className="legend-value"><b>{money(expense.amountMinor,expense.currency,bootstrap.currencies)}</b>{expense.currency!==target&&<small>≈ {formatAnalyticsAmount(convertExpense(expense,target,bootstrap.currencies,bootstrap.rates),target)}</small>}</span></div>
  // Пустое пространство и пустой период — разные случаи: в первом человек ещё не знает, что тут вообще будет.
  const anyExpenses=bootstrap.expenses.some((expense)=>!expense.deletedAt)
  // Удержание любой карточки открывает настройку экрана.
  const holdRef=useHold(!editing&&anyExpenses?()=>onEditScreen('analytics','hold'):undefined,(target)=>Boolean(target.closest('.chart-card')))
  const sectionRef=useCallback((node:HTMLElement|null)=>{pageRef.current=node;holdRef(node)},[holdRef])
  // В настройке плашки доезжают до новых мест плавно, убранная уезжает к пунктиру внизу.
  useFlip(pageRef,editing)
  const emptyPeriod=anyExpenses?'В этом периоде ещё нет расходов':'Появится после первых трат: сколько за месяц и на что'
  const chartColor=chart.line
  const chartText=theme==='dark'?'#b3b3ae':'#73776f'
  const chartGrid=theme==='dark'?'rgba(255,255,255,.06)':'rgba(32,37,31,.06)'
  // «Крупные траты»: записи периода под тем же фокусом, что и сумма в шапке, от самой большой в валюте аналитики.
  const topExpenses=useMemo(()=>!topShown?[]:focusedDetails.filter(({expense,date})=>hasRate(bootstrap.rates,expense.currency,target,date)).map((item)=>({...item,value:convertExpense(item.expense,target,bootstrap.currencies,bootstrap.rates)})).sort((left,right)=>right.value-left.value).slice(0,5),[topShown,focusedDetails,bootstrap.rates,bootstrap.currencies,target])
  const categoryOf=(id:string)=>bootstrap.categories.find((category)=>category.id===id)
  // Телефон хранит записи за последний год; более ранние лежат только на сервере, пока их не подгрузили в «Истории».
  const onPhoneFrom=bootstrap.olderExpenses&&bootstrap.expensesSince?bootstrap.expensesSince:null
  const periodOnPhone=!onPhoneFrom||from>=onPhoneFrom
  const previousOnPhone=!onPhoneFrom||previousRange.from>=onPhoneFrom
  // Прошлые дни, которых нет на телефоне, досчитывает сервер. Пока его ответа нет, сравнение молчит, а не пишет «— 0»;
  // строка остаётся, чтобы шапка не прыгала.
  const comparisonKnown=remote?.key===requestKey||!onPhoneFrom||previousFrom>=onPhoneFrom
  const notOnPhone='Записи этого периода ещё не загружены на телефон — их можно подгрузить в конце «Истории»'
  // «Темп»: сколько выйдет к концу периода, если тратить как до сих пор, и сколько было за прошлый период целиком.
  const forecast=partial?total/Math.max(1,periodDays)*periodLength:total
  // Прошлый период целиком показывает только большая карточка «Темп»; без неё третий проход по расходам не нужен.
  const paceShown=isShown(analyticsBlocks,'pace')&&!isSmall(analyticsBlocks,'pace')
  const previousFullMinor=useMemo(()=>paceShown?fallbackAnalytics(source,target,previousRange.from,previousRange.to,categoryId,tagId).totalMinor:0,[paceShown,source,target,previousRange.from,previousRange.to,categoryId,tagId])
  const previousFull=previousFullMinor/divisor
  const periodEnd=period==='week'?'недели':period==='month'?'месяца':'периода'
  const periodCaption=period==='week'?'За неделю':period==='month'?'За месяц':'За выбранные дни'
  // «По дням недели» нужно хотя бы две недели: за одну каждый день встречается один раз.
  const weekdaysShown=period==='month'||period==='range'&&periodDays>=14
  // «Календарь»: дни периода по неделям — чем темнее день, тем больше потрачено.
  const calendarAmounts=new Map(data.calendar.map((point)=>[point.date,point.amountMinor/divisor]))
  const calendarMax=Math.max(0,...calendarAmounts.values())
  const calendarStart=shiftDateKey(from,-weekdayFromDateKey(from))
  const calendarSpan=spanDays(calendarStart,selectedRange.to)
  const calendarCells=Array.from({length:Math.ceil(calendarSpan/7)*7},(_,index)=>shiftDateKey(calendarStart,index))
  const busiestDay=[...calendarAmounts].filter(([,amount])=>amount>0).sort((left,right)=>right[1]-left[1])[0]
  const calendarLabel=busiestDay?`Календарь трат: больше всего ${detailDate(busiestDay[0])}, ${formatAnalyticsAmount(busiestDay[1],target)}`:'Календарь трат: в этом периоде пусто'
  const heatDay=(date:string,outside:boolean,number:boolean)=>{
    const amount=calendarAmounts.get(date)??0
    // Дни вне сетки месяца пусты, даже если они попали в даты: их показывает соседний месяц.
    const heat=!outside&&amount&&calendarMax?.18+.82*amount/calendarMax:0
    return <span key={date} aria-hidden="true" className={[outside?'outside':'',date===today?'today':'',date>today?'future':'',heat>.55?'hot':''].filter(Boolean).join(' ')||undefined} style={{'--heat':String(heat)} as React.CSSProperties}>{number&&!outside?Number(date.slice(8)):''}</span>
  }
  // Свои даты длиннее двух месяцев раскладываются по месяцам, как календарь на год: недели строками заняли бы
  // несколько экранов.
  const calendarByMonth=period==='range'&&periodLength>62
  const calendarYears=from.slice(0,4)!==selectedRange.to.slice(0,4)
  const calendarMonths=calendarByMonth?Array.from({length:(Number(selectedRange.to.slice(0,4))-Number(from.slice(0,4)))*12+Number(selectedRange.to.slice(5,7))-Number(from.slice(5,7))+1},(_,index)=>monthDateRange(from,index)):[]
  const calendarGrid=(small:boolean)=>calendarByMonth?<div className={`calendar-year${small?' small':''}`} style={{'--heat-color':chart.line} as React.CSSProperties} role="img" aria-label={calendarLabel}>
    {calendarMonths.map((month,index)=>{
      const start=shiftDateKey(month.from,-weekdayFromDateKey(month.from))
      const name=new Date(`${month.from}T12:00:00Z`).toLocaleDateString('ru-RU',{timeZone:'UTC',month:'short',...(calendarYears&&(index===0||month.from.slice(5,7)==='01')?{year:'numeric'}:{})}).replace(' г.','')
      return <div key={month.from} className="calendar-month">{!small&&<small aria-hidden="true">{name}</small>}<div className="calendar-heat">{Array.from({length:spanDays(start,month.to)},(_,day)=>shiftDateKey(start,day)).map((date)=>heatDay(date,date<month.from||date<from||date>selectedRange.to,false))}</div></div>
    })}
  </div>:<div className={`calendar-heat${small?' small':''}`} style={{'--heat-color':chart.line} as React.CSSProperties} role="img" aria-label={calendarLabel}>
    {!small&&['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map((day)=><small key={day} aria-hidden="true">{day}</small>)}
    {calendarCells.map((date)=>heatDay(date,date<from||date>selectedRange.to,!small))}
  </div>
  // Маленькая карточка — в полширины, две в ряд: только главное, без легенды и фокуса.
  const emptyShort=anyExpenses?'Нет трат за период':'Пока пусто'
  // «Динамика» своих дат: до двух месяцев — по дням, до года — по неделям, дольше — по месяцам. Год по дням — частокол
  // из 365 точек. Неделя или месяц, попавшие в даты не целиком, начинаются с первого дня дат.
  const trendStep=period!=='range'||periodDays<=62?'day':periodDays<=366?'week':'month'
  // Подписи одни на большую и маленькую «Динамику»; даты форматируются дорого, поэтому только при смене периода.
  const trend=useMemo(()=>{
    const starts:string[]=[]
    const slots=days.map((day)=>{
      const start=trendStep==='day'?day:trendStep==='week'?startOfWeekDateKey(day):`${day.slice(0,8)}01`
      const key=start<from?from:start
      if(starts[starts.length-1]!==key)starts.push(key)
      return starts.length-1
    })
    const years=starts[0]?.slice(0,4)!==starts[starts.length-1]?.slice(0,4)
    const format:Intl.DateTimeFormatOptions=period==='week'?{weekday:'short'}:trendStep==='month'?{month:'short',...(years?{year:'2-digit'}:{})}:{day:'numeric',month:'short'}
    return {slots,labels:starts.map((start)=>new Date(`${start}T12:00`).toLocaleDateString('ru-RU',format).replace(' г.',''))}
  },[days,period,trendStep,from])
  const trendValues=trend.labels.map(()=>0)
  byDay.forEach((value,index)=>{trendValues[trend.slots[index]!]+=value})
  const trendCaption=period==='week'?'Понедельник — воскресенье':period==='month'?'По дням выбранного месяца':trendStep==='day'?'По дням':trendStep==='week'?'По неделям':'По месяцам'
  const topShares=(items:{key:string;label:string;color:string;value:number}[])=>{
    const sorted=[...items].sort((left,right)=>right.value-left.value)
    return <div className="mini-list">{sorted.slice(0,3).map((item)=><div key={item.key}><i style={{background:item.color}}/><span>{item.label}</span><b>{Math.round(item.value/(total||1)*100)}%</b></div>)}{sorted.length>3&&<small>и ещё {sorted.length-3}</small>}</div>
  }
  const smallCard=(id:string)=>id==='trend'?<div key="trend" className="chart-card small"><h2>Динамика</h2>{data.convertedCount?<div className="mini-chart"><Suspense fallback={<ChartSkeleton/>}><AnalyticsChart kind="line" compact labels={trend.labels} values={trendValues} color={chartColor} fillColor={chart.fill} pointRadius={0} target={target} textColor={chartText} gridColor={chartGrid} maxTicksLimit={7}/></Suspense></div>:<p className="mini-empty">{data.expenseCount?'Нет курса':emptyShort}</p>}</div>
    :id==='categories'?<div key="categories" className="chart-card small"><h2>Категории</h2>{byCategory.length?topShares(byCategory.map((item)=>({key:item.categoryId,label:item.name,color:item.color||'#a9afa5',value:item.value}))):<p className="mini-empty">{emptyShort}</p>}</div>
    :id==='tags'?(showTags&&<div key="tags" className="chart-card small"><h2>Теги</h2>{byTag.length?topShares(byTag.map((item,index)=>({key:item.id,label:item.label,color:tagColors[index]!,value:item.value}))):<p className="mini-empty">{emptyShort}</p>}</div>)
    :id==='pace'?<div key="pace" className="chart-card small"><h2>Темп</h2><p className="pace-value small">{partial?'≈ ':''}{formatCompactNumber(forecast)}</p><p className="mini-empty">{partial?`к концу ${periodEnd}`:'за весь период'}</p></div>
    :id==='top'?<div key="top" className="chart-card small"><h2>Крупные траты</h2>{!periodOnPhone?<p className="mini-empty">Не загружено</p>:topExpenses.length?<div className="mini-list">{topExpenses.slice(0,3).map(({expense,value})=><div key={expense.id}><i style={{background:categoryOf(expense.categoryId)?.color??'#a9afa5'}}/><span>{categoryName(expense.categoryId)||'Скрытая категория'}</span><b>{formatCompactNumber(value)}</b></div>)}</div>:<p className="mini-empty">{emptyShort}</p>}</div>
    :id==='calendar'?<div key="calendar" className="chart-card small"><h2>Календарь</h2>{calendarGrid(true)}</div>
    :id==='weekdays'?(weekdaysShown&&<div key="weekdays" className="chart-card small"><h2>По дням недели</h2>{data.convertedCount?<div className="mini-chart"><Suspense fallback={<ChartSkeleton/>}><AnalyticsChart kind="bar" compact labels={['П','В','С','Ч','П','С','В']} values={weekdays} color={chartColor} target={target} textColor={chartText} gridColor={chartGrid}/></Suspense></div>:<p className="mini-empty">{emptyShort}</p>}</div>)
    :null
  const statusLine=analyticsOffline?<>{analyticsError?'Не удалось обновить. ':''}Показаны сохранённые данные на {new Date(bootstrap.serverTime).toLocaleString('ru-RU')}{online&&<button type="button" onClick={()=>setRetryEpoch((value)=>value+1)}>Повторить</button>}</>:data.missingCurrencies.length?`Нет курса: ${data.missingCurrencies.join(', ')} — эти расходы не посчитаны`:null
  return <section ref={sectionRef} className={`page analytics${editing?' arranging':''}`}><AnalyticsProgress on={slowLoading}/><div className="analytics-fixed" inert={editing}><header className="page-header analytics-title"><div><p className="eyebrow">{focusedName??'Все расходы'}</p><h1><TweenedAmount value={total}/>{hasForeign&&<button type="button" className="rate-info" aria-label="Как посчитана сумма" aria-expanded={rateInfo} onClick={()=>setRateInfo((value)=>!value)}>i</button>}</h1><p className="analytics-comparison"><TweenedAmount value={total/elapsedDays} currency={target}/> в день · {data.expenseCount} {pluralRu(data.expenseCount,['операция','операции','операций'])}</p><p className="analytics-comparison">{comparisonKnown?comparisonLabel(total,previousTotal,partial,period,periodDays):'\u00a0'}</p></div><button className="currency-choice" onClick={()=>setCurrencySheet(true)}>{target}<ChevronIcon/></button></header>
    {rateInfo&&hasForeign&&<p className="rate-caption" role="note">Расходы в других валютах пересчитаны в {target} по курсу на день покупки.</p>}
    <div className="analytics-period" role="group" aria-label="Период аналитики"><button type="button" aria-pressed={period==='week'} className={period==='week'?'selected':''} onClick={()=>setPeriod('week')}>Неделя</button><button type="button" aria-pressed={period==='month'} className={period==='month'?'selected':''} onClick={()=>setPeriod('month')}>Месяц</button><button type="button" aria-pressed={period==='range'} aria-haspopup="dialog" className={period==='range'?'selected':''} onClick={()=>setPeriod('range')}>Даты</button></div>
    {period==='week'&&<div className="week-navigator"><button type="button" onClick={()=>setWeekOffset((value)=>value-1)} aria-label="Предыдущая неделя">‹</button><div><b>{weekOffset===0?'Текущая неделя':weekOffset===-1?'Прошлая неделя':'Выбранная неделя'}</b><span>{weekRange}</span></div><button type="button" onClick={()=>setWeekOffset((value)=>Math.min(0,value+1))} disabled={weekOffset===0} aria-label="Следующая неделя">›</button></div>}
    {period==='month'&&<div className="week-navigator"><button type="button" onClick={()=>setMonthOffset((value)=>value-1)} aria-label="Предыдущий месяц">‹</button><div><b>{monthOffset===0?'Текущий месяц':monthOffset===-1?'Прошлый месяц':'Выбранный месяц'}</b><span>{monthLabel}</span></div><button type="button" onClick={()=>setMonthOffset((value)=>Math.min(0,value+1))} disabled={monthOffset===0} aria-label="Следующий месяц">›</button></div>}
    {period==='range'&&<div className="week-navigator"><button type="button" onClick={()=>shiftRange(-1)} aria-label={capitalize(daysAround('предыдущ',periodLength))}>‹</button><button type="button" className="range-dates" aria-haspopup="dialog" aria-label={`Даты: ${rangeLabel}. Выбрать другие`} onClick={()=>{tap(4);setRangeSheet(true)}}><b>{periodLength} {pluralRu(periodLength,['день','дня','дней'])}</b><span>{rangeLabel}<ChevronIcon/></span></button><button type="button" onClick={()=>shiftRange(1)} disabled={selectedRange.to>=today} aria-label={capitalize(daysAround('следующ',periodLength))}>›</button></div>}
    {statusLine&&<div className={`rate-caption${analyticsOffline?' cached':''}`} role="status">{statusLine}</div>}</div>
    {editing?<AnalyticsBlocksEditor blocks={analyticsBlocks} onChange={(next)=>onScreensChange({analyticsBlocks:toBlockLayout(next)})}/>:<div className="analytics-cards">{analyticsBlocks.shown.map((block)=>isSmall(analyticsBlocks,block.id)?smallCard(block.id):block.id==='trend'?<div key="trend" className="chart-card"><div><h2>Динамика</h2><p>{trendCaption}</p></div>{data.convertedCount?<div className="line-chart"><Suspense fallback={<ChartSkeleton/>}><AnalyticsChart kind="line" labels={trend.labels} values={trendValues} color={chartColor} fillColor={chart.fill} pointRadius={trendValues.length<=14?3:0} target={target} textColor={chartText} gridColor={chartGrid} maxTicksLimit={period==='week'?7:6}/></Suspense></div>:<AnalyticsEmpty>{data.expenseCount?'Нет курса для выбранной валюты':emptyPeriod}</AnalyticsEmpty>}</div>
      :block.id==='categories'?<div key="categories" className={`chart-card${byCategory.length?' split':''}`}><div><h2>Категории</h2><p>{categoryId?'Только эта категория':tagId?`Только ${focusedTagLabel}`:periodCaption}</p></div>{byCategory.length?<><div className="donut-wrap"><Suspense fallback={<ChartSkeleton/>}><AnalyticsChart kind="doughnut" labels={donut.map((x)=>x.name)} values={donut.map((x)=>x.value)} colors={donut.map((x)=>x.color)} target={target}/></Suspense><span>{formatCompactNumber(total)}</span></div><div className="legend">{byCategory.map((x)=>{const focused=categoryId===x.categoryId;const rows=focused?categoryDetails.filter(({expense})=>inGroup(expense)):[];const shown=allDetails?rows:rows.slice(0,LEGEND_DETAIL_LIMIT);return <div key={x.categoryId} className={`legend-item${focused?' open':''}`}><button type="button" className="legend-row" aria-expanded={focused} onClick={()=>focus(x.categoryId)}><i style={{background:x.color||'#a9afa5'}}/><span>{x.name}</span><span className="legend-value"><b>{formatAnalyticsAmount(x.value,target)}</b><small className={focused?'ghost':undefined} aria-hidden={focused||undefined}>{Math.round(x.value/total*100)||0}%</small></span>{focused?<span className="legend-close" aria-hidden="true">×</span>:<ChevronIcon/>}</button>{focused&&<div className="legend-details">{groups.length>0&&<div className="legend-groups" role="group" aria-label="Из чего сложилась категория">{groups.map((group,index)=><button key={group.key} type="button" className={`legend-group${activeGroup===group.key?' selected':''}${activeGroup&&activeGroup!==group.key?' dim':''}`} aria-pressed={activeGroup===group.key} onClick={()=>pickGroup(group.key)}><i style={{background:groupColors[index]}}/><span>{group.label}{group.count>1&&<small> · {group.count}</small>}</span><span className="legend-value"><b>{formatAnalyticsAmount(group.value,target)}</b><small>{Math.round(group.value/(groupTotal||1)*100)}%</small></span></button>)}</div>}{rows.length?<>{shown.map((item)=>detailRow(item,detailCaption(item.expense)))}{rows.length>shown.length&&<button type="button" className="legend-more" onClick={()=>setAllDetails(true)}>Показать все · {rows.length}</button>}</>:<p className="legend-empty">На этом устройстве нет записей этой категории за период.</p>}</div>}</div>})}{categoryId&&<button type="button" className="legend-all" onClick={()=>focus(categoryId)}>Все категории</button>}</div></>:<AnalyticsEmpty>{emptyPeriod}</AnalyticsEmpty>}</div>
      :block.id==='tags'?(showTags&&<div key="tags" className={`chart-card${byTag.length?' split':''}`}><div><h2>Теги</h2><p>{tagId?'Только этот тег':categoryId?'В этой категории':periodCaption}</p></div>{byTag.length?<><div className="donut-wrap"><Suspense fallback={<ChartSkeleton/>}><AnalyticsChart kind="doughnut" labels={byTag.map((x)=>x.label)} values={byTag.map((x)=>x.value)} colors={tagColors} target={target}/></Suspense><span>{formatCompactNumber(total)}</span></div><div className="legend tag-legend">{byTag.map((x,index)=>{const focused=tagId===x.id;const shown=allTagDetails?tagDetails:tagDetails.slice(0,LEGEND_DETAIL_LIMIT);return <div key={x.id} className={`legend-item${focused?' open':''}`}><button type="button" className="legend-row" aria-expanded={focused} onClick={()=>focusTag(x.id)}><i style={{background:tagColors[index]}}/><span>{x.label}</span><span className="legend-value"><b>{formatAnalyticsAmount(x.value,target)}</b><small className={focused?'ghost':undefined} aria-hidden={focused||undefined}>{Math.round(x.value/total*100)||0}%</small></span>{focused?<span className="legend-close" aria-hidden="true">×</span>:<ChevronIcon/>}</button>{focused&&<div className="legend-details">{tagDetails.length?<>{shown.map((item)=>detailRow(item,tagCaption(item.expense)))}{tagDetails.length>shown.length&&<button type="button" className="legend-more" onClick={()=>setAllTagDetails(true)}>Показать все · {tagDetails.length}</button>}</>:<p className="legend-empty">На этом устройстве нет записей с этим тегом за период.</p>}</div>}</div>})}{tagId&&<button type="button" className="legend-all" onClick={()=>focusTag(tagId)}>Все теги</button>}</div></>:<AnalyticsEmpty>{emptyPeriod}</AnalyticsEmpty>}</div>)
      :block.id==='weekdays'?(weekdaysShown&&<div key="weekdays" className="chart-card"><div><h2>По дням недели</h2><p>Средние траты за календарный день</p></div>{data.convertedCount?<div className="bar-chart"><Suspense fallback={<ChartSkeleton/>}><AnalyticsChart kind="bar" labels={['Пн','Вт','Ср','Чт','Пт','Сб','Вс']} values={weekdays} color={chartColor} target={target} textColor={chartText} gridColor={chartGrid}/></Suspense></div>:<AnalyticsEmpty>Недостаточно данных для сравнения</AnalyticsEmpty>}</div>)
      :block.id==='pace'?<div key="pace" className="chart-card"><div><h2>Темп</h2><p>{partial?`Если тратить как сейчас, к концу ${periodEnd}`:'За весь период'}</p></div>{data.expenseCount||previousFull?<><p className="pace-value">{partial?'≈ ':''}{formatAnalyticsAmount(forecast,target)}</p>{previousOnPhone&&<p className="pace-compare">{previousFull?`${period==='week'?'Прошлая неделя':period==='month'?'Прошлый месяц':capitalize(daysAround('предыдущ',periodLength))} целиком — ${formatAnalyticsAmount(previousFull,target)}`:`${period==='week'?'На прошлой неделе':period==='month'?'В прошлом месяце':`За ${daysAround('предыдущ',periodLength)}`} трат не было`}</p>}</>:<AnalyticsEmpty>{emptyPeriod}</AnalyticsEmpty>}</div>
      :block.id==='top'?<div key="top" className="chart-card"><div><h2>Крупные траты</h2><p>{focusedName?`Только ${focusedName}`:periodCaption}</p></div>{!periodOnPhone?<AnalyticsEmpty>{notOnPhone}</AnalyticsEmpty>:topExpenses.length?<div className="top-list">{topExpenses.map(({expense,date,value})=><div key={expense.id} className="top-row"><CategoryMark category={categoryOf(expense.categoryId)}/><span><b>{categoryName(expense.categoryId)||'Скрытая категория'}</b><small>{detailDate(date)}{detailCaption(expense)}</small></span><span className="legend-value"><b>{money(expense.amountMinor,expense.currency,bootstrap.currencies)}</b>{expense.currency!==target&&<small>≈ {formatAnalyticsAmount(value,target)}</small>}</span></div>)}</div>:<AnalyticsEmpty>{emptyPeriod}</AnalyticsEmpty>}</div>
      :block.id==='calendar'?<div key="calendar" className="chart-card"><div><h2>Календарь</h2><p>{busiestDay?`Больше всего — ${detailDate(busiestDay[0])}, ${formatAnalyticsAmount(busiestDay[1],target)}`:'Чем темнее день, тем больше потрачено'}</p></div>{calendarGrid(false)}</div>
      :null)}</div>}
    {rangeSheet && <CalendarSheet from={from} to={selectedRange.to} onClose={()=>setRangeSheet(false)} onPick={pickRange}/>}
    {currencySheet && <CurrencySheet currencies={bootstrap.currencies} used={[...new Set(bootstrap.expenses.filter((item)=>!item.deletedAt).map((item)=>item.currency))]} selected={target} onClose={()=>setCurrencySheet(false)} onSelect={(code)=>{setBootstrap((data)=>({...data,settings:patchSettings(data.settings,{analyticsCurrency:code})}));saveMemberSettings(userId,workspaceId,{analyticsCurrency:code});setCurrencySheet(false)}}/>}
  </section>
})

export const LEGEND_DETAIL_LIMIT=8

// Значки свёрнутых карточек: по ним карточку узнают, пока графики спрятаны на время настройки.
const BLOCK_ICONS:Record<string,React.ReactNode>={
  trend:<path d="M3 14l4.2-4.2 3.3 3 6.5-6.8"/>,
  categories:<><circle cx="10" cy="10" r="6.5"/><path d="M10 3.5V10l4.6 4.6"/></>,
  tags:<><path d="M3.5 4.3v4.9c0 .3.1.5.3.7l6.6 6.6c.4.4 1 .4 1.4 0l4.6-4.6c.4-.4.4-1 0-1.4L9.8 3.8c-.2-.2-.4-.3-.7-.3H4.3c-.4 0-.8.4-.8.8z"/><circle cx="7" cy="7" r=".9" fill="currentColor" stroke="none"/></>,
  weekdays:<path d="M4.5 16.5v-5M8.2 16.5v-9M11.8 16.5v-6.5M15.5 16.5v-11"/>,
  pace:<><path d="M3.8 14.5a6.2 6.2 0 0 1 12.4 0"/><path d="M10 14.5l3.4-3.8"/></>,
  top:<path d="M4 5h12M4 10h8.5M4 15h5"/>,
  calendar:<><rect x="3.5" y="4.5" width="13" height="12" rx="2.5"/><path d="M3.5 8.5h13M7 3v3M13 3v3"/></>,
}

// Режим «Настройка экрана»: карточки свёрнуты в плашки — значок, название и что в ней. «−» в углу убирает карточку,
// ≡ переставляет, кнопка размера делает её маленькой (в полширины, две в ряд) или снова большой. Убранные ждут внизу
// пунктиром и возвращаются на своё место по касанию.
export function AnalyticsBlocksEditor({blocks,onChange}:{blocks:Blocks;onChange:(next:Blocks)=>void}) {
  return <div className="edit-cards" role="group" aria-label="Карточки аналитики">
    <DragList className="edit-card-list" flip items={blocks.shown} onReorder={(ids)=>onChange(reorderBlocks(blocks,ids))} render={(block)=><>
      <span className="block-icon" aria-hidden="true"><svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{BLOCK_ICONS[block.id]}</svg></span>
      <span className="block-name"><b>{block.name}</b><small>{block.hint}</small></span>
      {block.resizable&&<button type="button" className={`size-toggle${isSmall(blocks,block.id)?' small':''}`} aria-label={`Размер «${block.name}»: ${isSmall(blocks,block.id)?'маленькая, сделать большой':'большая, сделать маленькой'}`} onPointerDown={(event)=>event.stopPropagation()} onClick={()=>{tap(4);onChange(toggleSize(blocks,block.id))}}>{isSmall(blocks,block.id)?'Маленькая':'Большая'}</button>}
      <RemoveBadge name={block.name} onRemove={()=>onChange(hideBlock(blocks,block.id))}/>
    </>}/>
    {blocks.hidden.map((block)=><EditBlock key={block.id} name={block.name} hint={block.hint} shown={false} flipId={block.id} className="edit-card" onToggle={()=>onChange(showBlock(blocks,block.id))}/>)}
  </div>
}

export function AnalyticsEmpty({children}:{children:string}) {
  return <div className="analytics-empty"><span>⌁</span><p>{children}</p></div>
}

export function ChartSkeleton() {
  return <div className="chart-skeleton" role="status" aria-label="Загружаем график"><i/><i/><i/><i/><i/></div>
}

// Полоска загрузки бежит, только пока её видно: пока её показывают (`on`) и пока она гаснет. Бег (`running`) снимается
// по концу угасания, так что в покое у прозрачной полоски анимации нет вовсе — WebKit иначе перерисовывал бы её каждый
// кадр, — а каждый показ начинается с левого края. Показанная снова до конца угасания едет дальше, без скачка.
export function AnalyticsProgress({on}:{on:boolean}) {
  const [running,setRunning]=useState(on)
  useEffect(()=>{
    if(on&&!running)setRunning(true)
    if(on||!running)return
    // Показ и снятие в одном кадре прозрачность не меняют, и transitionend не придёт: тогда бег снимается сам, когда
    // полоска давно погасла.
    const timer=setTimeout(()=>setRunning(false),1000)
    return()=>clearTimeout(timer)
  },[on,running])
  return <div className={`analytics-progress${on?' on':''}${on||running?' running':''}`} aria-hidden="true" onTransitionEnd={(event)=>{if(!on&&event.propertyName==='opacity')setRunning(false)}}/>
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

// Сумма в шапке — отдельный маленький компонент: кадры её анимации перерисовывают только число, а не весь экран
// с графиками. Без валюты — только число, как в заголовке.
function TweenedAmount({value,currency}:{value:number;currency?:string}) {
  const shown=useTweenedNumber(value)
  return currency?formatAnalyticsAmount(shown,currency):cachedNumberFormat('ru-RU',{maximumFractionDigits:0}).format(shown)
}

// Дни своих дат: «предыдущие 15 дней», «следующий день».
export function daysAround(stem:'предыдущ'|'следующ',count:number) {
  return count===1?`${stem}ий день`:`${stem}ие ${count} ${pluralRu(count,['день','дня','дней'])}`
}

const capitalize=(text:string)=>text.charAt(0).toUpperCase()+text.slice(1)

// Сколько дней от одной даты до другой, обе включительно.
function spanDays(from:string,to:string) {
  return Math.round((Date.parse(`${to}T12:00:00Z`)-Date.parse(`${from}T12:00:00Z`))/86400000)+1
}

// Одна строка при любых числах: «+3252% к тем же дням прошлого месяца» не должно переносить шапку. Свои даты
// сравниваются с таким же числом дней перед ними (`days`), так что «тех же дней» у них не бывает.
export function comparisonLabel(total:number,previous:number,partial:boolean,period:AnalyticsPeriod,days=0) {
  if(period==='range')partial=false
  const same=period==='week'?'за те же дни прошлой недели':'за те же дни прошлого месяца'
  const whole=period==='week'?'на прошлой неделе':period==='month'?'в прошлом месяце':`за ${daysAround('предыдущ',days)}`
  const to=period==='range'?(days===1?'к предыдущему дню':`к предыдущим ${days} ${days%10===1&&days%100!==11?'дню':'дням'}`):period==='week'?(partial?'к тем же дням прошлой недели':'к прошлой неделе'):(partial?'к тем же дням прошлого месяца':'к прошлому месяцу')
  if(previous===0)return total===0?`Как и ${partial?same:whole}`:`${capitalize(partial?same:whole)} — 0`
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

// Для расчёта нужны только расходы, курсы и справочники — не весь bootstrap с личными настройками.
export type AnalyticsSource=Pick<Bootstrap,'expenses'|'categories'|'tags'|'currencies'|'rates'>

// Отпечаток списка расходов для ключа кэша ответов: те же поля, что раньше склеивались в строку на сотни килобайт,
// сведены в 64-битный хэш по схеме cyrb53. Одинаковые списки, в том числе в новом массиве, дают один ключ.
function expensesRevision(expenses:Expense[]) {
  let first=0xdeadbeef^expenses.length,second=0x41c6ce57^expenses.length
  for(const expense of expenses){
    const text=`${expense.id}:${expense.version}:${expense.updatedAt}:${expense.deletedAt||''}:${expense.voidedAt||''}:${expense.amountMinor}:${expense.currency}:${expense.categoryId}:${expense.occurredAt}|`
    for(let index=0;index<text.length;index++){const code=text.charCodeAt(index);first=Math.imul(first^code,2654435761);second=Math.imul(second^code,1597334677)}
  }
  first=Math.imul(first^(first>>>16),2246822507)^Math.imul(second^(second>>>13),3266489909)
  second=Math.imul(second^(second>>>16),2246822507)^Math.imul(first^(first>>>13),3266489909)
  return `${expenses.length}:${(first>>>0).toString(36)}:${(second>>>0).toString(36)}`
}

export function fallbackAnalytics(bootstrap:AnalyticsSource,target:string,from:string,to:string,categoryId:string|null,tagId:string|null=null):AnalyticsData {
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
