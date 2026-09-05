import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { appTimeZone } from './utils'
import { WorkspaceApiError as ApiError, allowWorkspaceMutations, blockWorkspaceMutations, discardOutboxIssues, getBootstrap, getBybitCardStatus, getSession, logoutExpected, prepareInitialOrManualRecovery, probeServer, retryOutboxIssue, setSessionContext, syncAllWorkspaces } from './workspace-api'
import { cacheBootstrap, migrateLegacyOfflineData, outboxStats, readCachedProfile, waitForWorkspaceOfflineWrites } from './workspace-offline'
import { REMINDER_COMPACT_AFTER, applyMembershipLoss, beginLogout, chooseCachedWorkspace, closeCapability, createAppState, createIdentityCoordinator, createLoggedOutState, forgetKnownProfile, hydrateAppState, openLegacyClaim, readReminderMemory, reminderSnoozed, setActiveWorkspace, settlePendingLogout, snoozeReminder, updateWorkspace, writeReminderMemory } from './app-state'
import type { AppState, ReminderMemory } from './app-state'
import { createIdentityWithProbe, createWorkspaceWithProbe } from './access-flow'
import { completeRotationSafely } from './recovery-flow'
import { monitorServiceWorkerUpdates } from './service-worker-update'
import type { BybitCardStatus, CapabilityIntent, RecoveryPrepareResponse, SessionState } from './types'
import { ChevronIcon, Toast, prefersReducedMotion, tap, useConfirm, useInputModality, useOnlineStatus, useToast } from './ui'
import type { Theme } from './ui'
import { pluralRu } from './format'
import type { Bootstrap } from './format'
import { EntryView } from './screens/Entry'
import { HistoryView } from './screens/History'
import { AnalyticsView } from './screens/Analytics'
import { SettingsView } from './screens/Settings'
import type { ThemePreference } from './screens/Settings'
import { BybitReviewView, ReviewOverlay } from './screens/Review'
import { CapabilityScreen, CreateWorkspaceSheet, LegacyClaimFlow, RecoverySave, RestrictedRecovery, SyncIssuesSheet, WorkspaceSwitcher } from './screens/Access'

export type Tab = 'entry' | 'history' | 'analytics' | 'settings'

function readThemePreference(): ThemePreference {
  const saved = localStorage.getItem('moapp:theme')
  return saved === 'dark' || saved === 'light' ? saved : 'system'
}

function systemTheme(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

// «Как в системе» следует за телефоном и меняется вместе с ним; явный выбор фиксирует тему.
function useResolvedTheme(preference: ThemePreference): Theme {
  const [system, setSystem] = useState<Theme>(systemTheme)
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!media) return
    const update = () => setSystem(media.matches ? 'dark' : 'light')
    update()
    media.addEventListener?.('change', update)
    return () => media.removeEventListener?.('change', update)
  }, [])
  return preference === 'system' ? system : preference
}

const tabs:{id:Tab;label:string}[]=[{id:'entry',label:'Расход'},{id:'history',label:'История'},{id:'analytics',label:'Аналитика'},{id:'settings',label:'Настройки'}]

function NavIcon({ tab }: { tab: Tab }) {
  if(tab==='entry')return <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 8v8M8 12h8"/></svg>
  if(tab==='history')return <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/></svg>
  if(tab==='analytics')return <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19V13M12 19V5M19 19V9M3.5 19h17"/></svg>
  return <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h7M15 18h5"/><circle cx="16" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="13" cy="18" r="2"/></svg>
}

// Диагностика жеста на телефоне: включается адресом ?debug=swipe и запоминается, выключается ?debug=off.
// Панель пишет, куда пришло касание, что делает лента вкладок и лента карточек — то, чего не видно в эмуляции.
function readDebugFlag(): string | null {
  try {
    const wanted = new URL(window.location.href).searchParams.get('debug')
    if (wanted === 'off') localStorage.removeItem('moapp:debug')
    else if (wanted) localStorage.setItem('moapp:debug', wanted)
    return localStorage.getItem('moapp:debug')
  } catch { return null }
}

function SwipeDebug() {
  const [lines, setLines] = useState<string[]>(['debug=swipe: жду касания'])
  useEffect(() => {
    const pager = document.querySelector<HTMLElement>('.pager')
    const push = (line: string, replaceMove = false) => setLines((current) => {
      const kept = replaceMove && current.at(-1)?.startsWith('move') ? current.slice(0, -1) : current
      return [...kept.slice(-9), line]
    })
    const describe = (target: EventTarget | null) => target instanceof Element ? `${target.tagName.toLowerCase()}${target.className && typeof target.className === 'string' ? `.${target.className.split(' ').filter(Boolean).slice(0, 2).join('.')}` : ''}` : '?'
    let startX = 0, startY = 0
    const track = () => document.querySelector<HTMLElement>('.entry-track')?.style.transform || '0'
    // Что вокруг касания: заблокированные предки, состояние полосы тегов и слоя превью — то, что ломается «до перезагрузки».
    const surroundings = (target: EventTarget | null) => {
      const blocked = target instanceof Element ? target.closest('[inert], [aria-hidden="true"]') : null
      const strip = document.querySelector<HTMLElement>('.entry-lower-live .tag-strip')
      const preview = document.querySelector<HTMLElement>('.entry-lower-preview')
      return [
        blocked ? `blocked-by=${describe(blocked)}` : '',
        strip ? `strip=${strip.style.touchAction || 'css'}/${strip.scrollWidth - strip.clientWidth}px/left${Math.round(strip.scrollLeft)}` : '',
        preview ? `preview=${preview.style.opacity || '?'}` : '',
        pager?.style.overflowX ? `pager-overflow=${pager.style.overflowX}` : '',
      ].filter(Boolean).join(' ')
    }
    const viewport = () => `vv=${Math.round(window.visualViewport?.offsetLeft ?? 0)},${Math.round(window.visualViewport?.offsetTop ?? 0)} h${Math.round(window.visualViewport?.height ?? window.innerHeight)} scroll=${Math.round(window.scrollX)},${Math.round(window.scrollY)}`
    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0]
      if (!touch) return
      startX = touch.clientX; startY = touch.clientY
      const action = event.target instanceof Element ? getComputedStyle(event.target).touchAction : '?'
      push(`start x${Math.round(touch.clientX)} y${Math.round(touch.clientY)} ${describe(event.target)} touch-action=${action} pager=${pager?.scrollLeft ?? '-'} fingers=${event.touches.length} ${surroundings(event.target)}`)
    }
    const onMove = (event: TouchEvent) => {
      const touch = event.touches[0]
      if (!touch) return
      push(`move dx${Math.round(touch.clientX - startX)} dy${Math.round(touch.clientY - startY)} pager=${pager?.scrollLeft ?? '-'} track=${track()}${event.defaultPrevented ? ' prevented' : ''} ${viewport()}`, true)
    }
    const onEnd = (event: TouchEvent) => push(`${event.type} pager=${pager?.scrollLeft ?? '-'} track=${track()} ${viewport()}`)
    const onScroll = () => push(`pager scrolled to ${pager?.scrollLeft}`)
    const onPointerCancel = (event: PointerEvent) => push(`pointercancel ${event.pointerType} ${describe(event.target)}`)
    const onWindow = (event: Event) => push(`${event.type} ${viewport()} inner=${window.innerWidth}x${window.innerHeight}`)
    document.addEventListener('touchstart', onStart, { passive: true })
    document.addEventListener('touchmove', onMove, { passive: true })
    document.addEventListener('touchend', onEnd, { passive: true })
    document.addEventListener('touchcancel', onEnd, { passive: true })
    document.addEventListener('pointercancel', onPointerCancel, { passive: true })
    pager?.addEventListener('scroll', onScroll, { passive: true })
    for (const type of ['resize', 'scroll', 'pagehide', 'pageshow', 'popstate', 'blur']) window.addEventListener(type, onWindow, { passive: true })
    window.visualViewport?.addEventListener('resize', onWindow); window.visualViewport?.addEventListener('scroll', onWindow)
    return () => {
      document.removeEventListener('touchstart', onStart); document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend', onEnd); document.removeEventListener('touchcancel', onEnd)
      document.removeEventListener('pointercancel', onPointerCancel)
      pager?.removeEventListener('scroll', onScroll)
      for (const type of ['resize', 'scroll', 'pagehide', 'pageshow', 'popstate', 'blur']) window.removeEventListener(type, onWindow)
      window.visualViewport?.removeEventListener('resize', onWindow); window.visualViewport?.removeEventListener('scroll', onWindow)
    }
  }, [])
  return <pre className="swipe-debug" aria-hidden="true">{lines.join('\n')}</pre>
}

export function pagerTabsAt(scrollLeft: number, clientWidth: number, items=tabs): Tab[] {
  if (clientWidth <= 0) return ['entry']
  const position = Math.max(0, Math.min(items.length - 1, scrollLeft / clientWidth))
  const touching = [Math.floor(position), Math.ceil(position)].map((index) => items[index]!.id)
  return [...new Set<Tab>(['entry', ...touching])]
}

function pagerTabsFor(tab: Tab): Tab[] {
  return tab === 'entry' ? ['entry'] : ['entry', tab]
}

export default function App({ capability = null }: { capability?: CapabilityIntent | null }) {
  useInputModality()
  const [state,setState]=useState(()=>createAppState(capability))
  const [pagerState,setPagerState]=useState<{workspaceId:string|null;tab:Tab;mounted:Tab[]}>({workspaceId:null,tab:'entry',mounted:['entry']})
  const [currentId,setCurrentId]=useState<string|null>(null)
  const [createOpen,setCreateOpen]=useState(false)
  const [switchOpen,setSwitchOpen]=useState(false)
  const [issuesOpen,setIssuesOpen]=useState(false)
  const [reviewOpen,setReviewOpen]=useState(false)
  const [bybitRuntime,setBybitRuntime]=useState<{workspaceId:string;status:BybitCardStatus}|null>(null)
  const [initialRecovery,setInitialRecovery]=useState<RecoveryPrepareResponse|null>(null)
  const [error,setError]=useState('')
  const { toast: notice, notify: setNotice, dismiss: hideNotice } = useToast()
  const { confirm, confirmation } = useConfirm()
  const online=useOnlineStatus()
  const [themePreference,setThemePreference]=useState<ThemePreference>(readThemePreference)
  const theme=useResolvedTheme(themePreference)
  const [debugFlag]=useState(readDebugFlag)
  const [updateWaiting,setUpdateWaiting]=useState(false)
  const [draftDirty,setDraftDirty]=useState(false)
  const [workspaceReloadEpoch,setWorkspaceReloadEpoch]=useState(0)
  // Календарь телефона. Смена пояса (переезд, настройки) замечается при возврате в приложение и раз в минуту:
  // экраны пересчитывают дни, а пространство перезагружается за курсами по дням нового календаря.
  const [timeZone,setTimeZone]=useState(appTimeZone)
  useEffect(()=>{
    const check=()=>{const zone=appTimeZone();setTimeZone((current)=>current===zone?current:zone)}
    document.addEventListener('visibilitychange',check);window.addEventListener('focus',check);window.addEventListener('pageshow',check)
    const timer=setInterval(check,60_000)
    return()=>{document.removeEventListener('visibilitychange',check);window.removeEventListener('focus',check);window.removeEventListener('pageshow',check);clearInterval(timer)}
  },[])
  const seenTimeZone=useRef(timeZone)
  useEffect(()=>{if(seenTimeZone.current===timeZone)return;seenTimeZone.current=timeZone;setWorkspaceReloadEpoch((value)=>value+1)},[timeZone])
  const stateRef=useRef(state); stateRef.current=state
  const tab=pagerState.workspaceId===state.activeWorkspaceId?pagerState.tab:'entry'
  const mountedTabs=pagerState.workspaceId===state.activeWorkspaceId?pagerState.mounted:['entry']
  const reviewConnected=bybitRuntime?.workspaceId===state.activeWorkspaceId&&bybitRuntime.status.connected
  const navigationTabs=tabs
  const setTab=useCallback((next:Tab)=>{
    const workspaceId=stateRef.current.activeWorkspaceId
    // Сначала срочно меняем вкладку (лента поехала), а тяжёлые страницы монтируем в transition — нажатие не ждёт их рендера.
    setPagerState((previous)=>previous.workspaceId===workspaceId?{...previous,tab:next}:{workspaceId,tab:next,mounted:['entry']})
    startTransition(()=>setPagerState((previous)=>previous.workspaceId===workspaceId?{...previous,mounted:[...previous.mounted,...pagerTabsFor(next).filter((item)=>!previous.mounted.includes(item))]}:{workspaceId,tab:next,mounted:pagerTabsFor(next)}))
  },[])
  const capabilityRef=useRef(capability)
  const monitor=useRef<ReturnType<typeof monitorServiceWorkerUpdates> | undefined>(undefined)
  const coordinator=useRef<ReturnType<typeof createIdentityCoordinator> | null>(null)
  const requestAbort=useRef(new AbortController())
  const syncAbort=useRef(new AbortController())
  const sessionAbort=useRef(new AbortController())
  const refreshEpoch=useRef(0)
  const identityEpoch=useRef(0)
  const pager=useRef<HTMLElement|null>(null)
  const pagerWorkspace=useRef<string|null>(null)
  const pagerTimer=useRef<ReturnType<typeof setTimeout>>(undefined)
  const draftDirtyRef=useRef(draftDirty); draftDirtyRef.current=draftDirty
  const requestEpoch=useRef<Record<string,number>>({})

  const updateState=useCallback((updater:(value:AppState)=>AppState)=>{
    setState((value)=>{const next=updater(value);stateRef.current=next;return next})
  },[])
  const commitState=useCallback((next:AppState)=>{stateRef.current=next;setState(next)},[])
  const stopNetwork=useCallback(()=>{
    requestAbort.current.abort();syncAbort.current.abort();sessionAbort.current.abort();refreshEpoch.current+=1;identityEpoch.current+=1
    requestAbort.current=new AbortController();syncAbort.current=new AbortController()
  },[])
  const buildState=useCallback(async(next:SessionState,intent:CapabilityIntent|null=capabilityRef.current)=>{
    if(next.authenticated)allowWorkspaceMutations()
    if(next.authenticated&&!next.restrictedToRecovery&&next.legacyWorkspaceId)await migrateLegacyOfflineData(next.user.id,next.legacyWorkspaceId)
    return hydrateAppState(next,intent)
  },[])
  const hydrate=useCallback(async(next:SessionState,announce=false,expectedIdentityEpoch=identityEpoch.current)=>{
    if(expectedIdentityEpoch!==identityEpoch.current){setSessionContext(stateRef.current.session);return}
    const built=await buildState(next)
    if(expectedIdentityEpoch!==identityEpoch.current){setSessionContext(stateRef.current.session);return}
    commitState(built)
    if(announce&&next.authenticated)coordinator.current?.announce(next.user.id,next.currentSessionId)
  },[buildState,commitState])

  const refresh=useCallback(async(reloadWorkspace=false)=>{
    if(reloadWorkspace){
      requestAbort.current.abort();syncAbort.current.abort()
      syncAbort.current=new AbortController()
    }
    sessionAbort.current.abort()
    const controller=new AbortController();sessionAbort.current=controller
    const epoch=++refreshEpoch.current
    const current=()=>!controller.signal.aborted&&refreshEpoch.current===epoch
    const settled=await settlePendingLogout(navigator.onLine,controller.signal)
    if(!current())return
    if(!settled){
      const locked=createAppState(capabilityRef.current);locked.phase=capabilityRef.current?'capability':'known-user-locked'
      commitState(locked);setError('Подключитесь к интернету, чтобы безопасно завершить выход.')
      return
    }
    try{
      setError('')
      const next=await getSession(controller.signal)
      if(!current())return
      const built=await buildState(next)
      if(!current()){setSessionContext(stateRef.current.session);return}
      commitState(built)
      if(reloadWorkspace)setWorkspaceReloadEpoch((value)=>value+1)
    }
    catch{
      if(!current()){setSessionContext(stateRef.current.session);return}
      const currentState=stateRef.current;const known=currentState.knownUserId
      if(known){
        const profile=await readCachedProfile(known)
        if(!current())return
        const candidate=profile?.session
        if(candidate?.authenticated&&Date.parse(candidate.currentSessionExpiresAt)>Date.now()){
          const offline=await buildState(candidate)
          if(!current()){setSessionContext(stateRef.current.session);return}
          if(Object.values(offline.runtimes).some((runtime)=>runtime.bootstrap)){
            const activeWorkspaceId=chooseCachedWorkspace(known,candidate.workspaces,offline.runtimes)
            commitState({...offline,activeWorkspaceId,runtimes:Object.fromEntries(Object.entries(offline.runtimes).map(([id,runtime])=>[id,{...runtime,offline:Boolean(runtime.bootstrap)}]))})
            return
          }
        }
        const locked=createAppState(capabilityRef.current);locked.knownUserId=known;locked.phase=capabilityRef.current?'capability':'known-user-locked';commitState(locked)
        setError('Нет связи с сервером, а сохранённых на этом телефоне данных нет.')
        return
      }
      const guest=createAppState(capabilityRef.current);guest.session=currentState.session?.authenticated?null:currentState.session;guest.phase=capabilityRef.current?'capability':'guest';commitState(guest)
      setError('Нет подключения к серверу.')
    }
  },[buildState,commitState])

  useEffect(()=>{void refresh()},[refresh])
  useEffect(()=>{
    const item=createIdentityCoordinator({
      refresh,
      abortNetwork:()=>requestAbort.current.abort(),
      stopSync:()=>{syncAbort.current.abort();syncAbort.current=new AbortController()},
      onForeignIdentity:()=>{identityEpoch.current+=1;blockWorkspaceMutations();setSessionContext(null);const locked=createAppState(capabilityRef.current);locked.knownUserId=stateRef.current.knownUserId;commitState(locked)},
    })
    coordinator.current=item
    return()=>{coordinator.current=null;item.dispose()}
  },[commitState,refresh])
  useEffect(()=>{
    const item=monitorServiceWorkerUpdates({
      onWaiting:()=>setUpdateWaiting(true),
      onControllerChange:()=>void waitForWorkspaceOfflineWrites().then(()=>{if(draftDirtyRef.current){setUpdateWaiting(true);return}window.location.reload()}),
    })
    monitor.current=item;void item.checkForUpdate()
    return()=>item.dispose()
  },[])
  useEffect(()=>{document.documentElement.dataset.theme=theme},[theme])
  useEffect(()=>{if(themePreference==='system')localStorage.removeItem('moapp:theme');else localStorage.setItem('moapp:theme',themePreference)},[themePreference])
  useLayoutEffect(()=>{
    const node=pager.current
    if(!node)return
    const workspaceId=state.activeWorkspaceId
    if(pagerWorkspace.current!==workspaceId){
      pagerWorkspace.current=workspaceId
      clearTimeout(pagerTimer.current)
      node.scrollLeft=0
      setPagerState({workspaceId,tab:'entry',mounted:['entry']})
      return
    }
    const left=Math.max(0,navigationTabs.findIndex((item)=>item.id===tab))*node.clientWidth
    if(Math.abs(node.scrollLeft-left)<1&&pagerAnimation.current===null)return
    // Тап по вкладке едет так же плавно, как свайп между страницами. Пока лента в пути, обработчик скролла
    // не должен переключать вкладку на промежуточную, иначе анимация развернётся обратно.
    pagerTarget.current=left
    animatePager(node,left)
  },[state.activeWorkspaceId,tab,reviewConnected,Boolean(state.activeWorkspaceId&&state.runtimes[state.activeWorkspaceId]?.bootstrap)])
  useEffect(()=>()=>clearTimeout(pagerTimer.current),[])
  const pagerTarget=useRef<number|null>(null)
  const pagerAnimation=useRef<number|null>(null)
  // Прокрутку к вкладке ведём сами через requestAnimationFrame: нативный smooth scroll в WebKit при новой команде
  // поверх незавершённой делает скачок, а при остановке между точками привязки зависает мимо страницы.
  const stopPagerAnimation=()=>{
    if(pagerAnimation.current!==null){cancelAnimationFrame(pagerAnimation.current);pagerAnimation.current=null}
    const node=pager.current;if(node)node.style.scrollSnapType=''
  }
  const animatePager=(node:HTMLElement,left:number)=>{
    stopPagerAnimation()
    const from=node.scrollLeft,distance=left-from
    if(Math.abs(distance)<1||prefersReducedMotion()){node.scrollLeft=left;return}
    // Привязку отключаем на время анимации: иначе браузер притягивает каждый промежуточный кадр к странице.
    node.style.scrollSnapType='none'
    const duration=Math.min(320,200+Math.abs(distance)/node.clientWidth*40)
    const started=performance.now()
    const frame=(now:number)=>{
      const progress=Math.min(1,(now-started)/duration)
      const eased=1-Math.pow(1-progress,3)
      node.scrollLeft=from+distance*eased
      if(progress<1){pagerAnimation.current=requestAnimationFrame(frame);return}
      pagerAnimation.current=null
      node.style.scrollSnapType=''
      node.scrollLeft=left
    }
    pagerAnimation.current=requestAnimationFrame(frame)
  }

  const session=state.session
  const auth=session?.authenticated?session:null
  const settingsIdentityEpoch=identityEpoch.current
  const workspaceId=state.activeWorkspaceId
  const workspacesKey=auth?.workspaces.map((workspace)=>`${workspace.id}:${workspace.version}`).join('|')??''
  const bybitStatus=bybitRuntime?.workspaceId===workspaceId?bybitRuntime.status:null
  const updateBybitStatus=useCallback((next:Partial<BybitCardStatus>&Pick<BybitCardStatus,'pendingCount'>)=>{
    const id=stateRef.current.activeWorkspaceId;if(!id)return
    setBybitRuntime((current)=>({workspaceId:id,status:{connected:false,canManage:false,...(current?.workspaceId===id?current.status:{}),...next}}))
  },[])

  useEffect(()=>{
    if(!auth||!workspaceId||!online){setBybitRuntime(null);return}
    const controller=new AbortController();const id=workspaceId
    setBybitRuntime((current)=>current?.workspaceId===id?current:null)
    void getBybitCardStatus(id,controller.signal).then((status)=>{
      if(controller.signal.aborted)return
      setBybitRuntime({workspaceId:id,status})
    }).catch(()=>{/* Bybit status is supplemental and must not block the workspace. */})
    return()=>controller.abort()
  },[auth?.currentSessionId,auth?.user.id,online,workspaceId])
  useEffect(()=>{if(!reviewConnected)setReviewOpen(false)},[reviewConnected])
  // История мемоизирована: карточка очереди отдаётся ей стабильным объектом, чтобы не перерисовывать список на каждый рендер приложения.
  const openReview=useCallback(()=>setReviewOpen(true),[])
  const reviewCount=reviewConnected?bybitStatus?.pendingCount??0:0
  const historyInbox=useMemo(()=>reviewCount?{count:reviewCount,onOpen:openReview}:null,[reviewCount,openReview])
  // Ссылку доступа предлагаем спокойной карточкой над историей после первого расхода, а не тремя модалками при первом запуске.
  const recoveryNeeded=Boolean(auth&&!auth.user.recoveryConfigured&&!auth.restrictedToRecovery)
  const hasExpenses=Boolean(workspaceId&&state.runtimes[workspaceId]?.bootstrap?.expenses.some((expense)=>!expense.deletedAt))
  const openRecoverySave=useCallback(async()=>{
    try{setInitialRecovery(await prepareInitialOrManualRecovery())}
    catch(reason){setError(reason instanceof ApiError?reason.message:'Не удалось подготовить ссылку доступа')}
  },[])
  // Показы карточки считаются по одному на запуск; после пары показов она сворачивается в строку, «Позже» убирает её на неделю.
  const reminderUserId=auth?.user.id??null
  const [reminderMemory,setReminderMemory]=useState<ReminderMemory>({shows:0,snoozedUntil:null})
  useEffect(()=>{if(reminderUserId)setReminderMemory(readReminderMemory(reminderUserId))},[reminderUserId])
  const reminderEligible=recoveryNeeded&&hasExpenses&&online
  const reminderCounted=useRef<string|null>(null)
  useEffect(()=>{
    if(!reminderEligible||!reminderUserId||reminderCounted.current===reminderUserId)return
    reminderCounted.current=reminderUserId
    setReminderMemory((current)=>{if(reminderSnoozed(current))return current;const next={...current,shows:current.shows+1};writeReminderMemory(reminderUserId,next);return next})
  },[reminderEligible,reminderUserId])
  const postponeReminder=useCallback(()=>{
    if(!reminderUserId)return
    setReminderMemory((current)=>{const next=snoozeReminder(current);writeReminderMemory(reminderUserId,next);return next})
  },[reminderUserId])
  const historyReminder=useMemo(()=>reminderEligible&&!reminderSnoozed(reminderMemory)?{onSave:()=>void openRecoverySave(),onLater:postponeReminder,compact:reminderMemory.shows>REMINDER_COMPACT_AFTER}:null,[reminderEligible,reminderMemory,openRecoverySave,postponeReminder])

  // A Bybit sync can change expenses server-side (declined operations void their expense); pull the
  // workspace again without the loading state so history and analytics reflect it immediately.
  const reloadWorkspaceData=useCallback(()=>{
    const id=stateRef.current.activeWorkspaceId;const session=stateRef.current.session
    if(!id||!session?.authenticated)return
    const userId=session.user.id,sessionId=session.currentSessionId
    void getBootstrap(id).then((value)=>{
      if(value.offline)return
      updateState((current)=>{
        if(!current.session?.authenticated||current.session.user.id!==userId||current.session.currentSessionId!==sessionId||!current.runtimes[id])return current
        return updateWorkspace(current,id,(runtime)=>({...runtime,bootstrap:value.data,source:'network',offline:false}))
      })
    }).catch(()=>{/* the next regular load refreshes it */})
  },[updateState])
  const refreshWorkspaceStats=useCallback(async(userId:string,id:string)=>{
    const stats=await outboxStats(userId,id)
    updateState((value)=>{
      if(!value.session?.authenticated||value.session.user.id!==userId||!value.runtimes[id])return value
      return updateWorkspace(value,id,(runtime)=>({...runtime,outbox:stats}))
    })
  },[updateState])

  useEffect(()=>{
    if(!auth||!workspaceId)return
    requestAbort.current.abort();const controller=new AbortController();requestAbort.current=controller
    const id=workspaceId,userId=auth.user.id,sessionId=auth.currentSessionId,workspaces=auth.workspaces
    const epoch=(requestEpoch.current[id]??0)+1;requestEpoch.current[id]=epoch
    updateState((value)=>value.runtimes[id]?updateWorkspace(value,id,(runtime)=>({...runtime,status:'loading',requestEpoch:epoch})):value)
    void getBootstrap(id,controller.signal).then((value)=>{
      if(controller.signal.aborted)return
      updateState((current)=>{
        if(!current.session?.authenticated||current.session.user.id!==userId||current.session.currentSessionId!==sessionId||!current.runtimes[id]||current.runtimes[id].requestEpoch!==epoch)return current
        return updateWorkspace(current,id,(runtime)=>({...runtime,bootstrap:value.data,source:value.offline?'cache':'network',offline:value.offline,status:'ready'}))
      })
      void syncAllWorkspaces(userId,workspaces,id,syncAbort.current.signal,(syncedId)=>void refreshWorkspaceStats(userId,syncedId)).catch((reason)=>{
        if(reason instanceof DOMException&&reason.name==='AbortError')return
        if(reason instanceof ApiError&&(reason.status===401||reason.code==='SESSION_CONTEXT_CHANGED'))void refresh()
      })
    }).catch(async(reason)=>{
      if(reason instanceof DOMException&&reason.name==='AbortError')return
      if(reason instanceof ApiError&&reason.code==='WORKSPACE_NOT_FOUND'){
        const base=stateRef.current;const next=await applyMembershipLoss(base,id)
        if(stateRef.current.session?.authenticated&&stateRef.current.session.user.id===userId&&stateRef.current.session.currentSessionId===sessionId)commitState(next)
        return
      }
      if(reason instanceof ApiError&&(reason.status===401||reason.code==='SESSION_CONTEXT_CHANGED')){void refresh();return}
      updateState((value)=>value.runtimes[id]?updateWorkspace(value,id,(runtime)=>({...runtime,status:runtime.bootstrap?'ready':'error'})):value)
      setError(reason instanceof ApiError?reason.message:'Не удалось загрузить пространство')
    })
    return()=>controller.abort()
  },[auth?.currentSessionId,auth?.user.id,commitState,refresh,refreshWorkspaceStats,updateState,workspaceId,workspaceReloadEpoch,workspacesKey])

  const setWorkspaceData=useMemo<React.Dispatch<React.SetStateAction<Bootstrap>>>(()=>{
    const expectedWorkspaceId=workspaceId
    const expectedUserId=auth?.user.id
    const expectedSessionId=auth?.currentSessionId
    return(action)=>{
      if(!expectedWorkspaceId||!expectedUserId||!expectedSessionId)return
      updateState((value)=>{
        const runtime=value.runtimes[expectedWorkspaceId]
        if(!runtime?.bootstrap||!value.session?.authenticated||value.session.user.id!==expectedUserId||value.session.currentSessionId!==expectedSessionId||!value.session.workspaces.some((workspace)=>workspace.id===expectedWorkspaceId))return value
        const next=typeof action==='function'?(action as (previous:Bootstrap)=>Bootstrap)(runtime.bootstrap):action
        if(next.workspaceId!==expectedWorkspaceId)return value
        void cacheBootstrap(expectedUserId,expectedWorkspaceId,next)
        return updateWorkspace(value,expectedWorkspaceId,(current)=>({...current,bootstrap:next}))
      })
    }
  },[auth?.currentSessionId,auth?.user.id,updateState,workspaceId])

  const refreshPending=useCallback(()=>{
    const current=stateRef.current
    if(!current.session?.authenticated||!current.activeWorkspaceId)return
    void refreshWorkspaceStats(current.session.user.id,current.activeWorkspaceId)
  },[refreshWorkspaceStats])

  const create=async(id:string,name:string,displayName?:string)=>{
    setError('')
    let createdIdentity=false
    try{
      let current=stateRef.current.session
      if(!current?.authenticated){if(!displayName)return;current=await createIdentityWithProbe(displayName);allowWorkspaceMutations();createdIdentity=true}
      await createWorkspaceWithProbe(id,name)
      const next=await getSession()
      if(!next.authenticated)throw new Error('Сервер не подтвердил созданное пространство')
      let built=await buildState(next,null);built=setActiveWorkspace(built,id);capabilityRef.current=null;commitState(built)
      setCreateOpen(false);setSwitchOpen(false);setCurrentId(null);setTab('entry')
      setNotice(`Пространство «${name.trim()}» создано`)
      if(createdIdentity)coordinator.current?.announce(next.user.id,next.currentSessionId)
    }catch(reason){setError(reason instanceof ApiError||reason instanceof Error?reason.message:'Не удалось создать пространство')}
  }

  const closeIntent=()=>{capabilityRef.current=null;updateState(closeCapability)}
  const finishIntent=async(next:SessionState,targetWorkspaceId?:string)=>{
    const finishedKind=capabilityRef.current?.kind
    capabilityRef.current=null
    let built=await buildState(next,null)
    if(targetWorkspaceId)built=setActiveWorkspace(built,targetWorkspaceId)
    commitState(built)
    if(next.authenticated)coordinator.current?.announce(next.user.id,next.currentSessionId)
    if(finishedKind==='recovery')setNotice('Доступ возвращён. Старая ссылка больше не работает, прежние устройства отключены. Сохраните новую.')
  }

  const resolveIdentityConflict=async(targetUserId:string|null)=>{
    if(!navigator.onLine)throw new Error('Для безопасного выхода нужно подключение к интернету')
    stopNetwork();const current=stateRef.current
    const preserveKnown=Boolean(targetUserId&&current.knownUserId===targetUserId)
    if(current.conflictingSession)await logoutExpected(current.conflictingSession.userId,current.conflictingSession.sessionId)
    if(current.session?.authenticated){
      const pending=beginLogout(current)
      const locked=createAppState(capabilityRef.current);locked.phase='capability';commitState(locked)
      await pending
      if(!await settlePendingLogout(true))throw new Error('Не удалось завершить выход')
    }else if(current.knownUserId&&!preserveKnown){
      const verifiedSession=current.session??await getSession()
      const pending=forgetKnownProfile(true,verifiedSession)
      const locked=createAppState(capabilityRef.current);locked.phase='capability';commitState(locked)
      if(!await pending)throw new Error('Не удалось удалить данные профиля')
    }
    coordinator.current?.announce(null,null)
    await hydrate(await getSession())
  }

  const logoutCurrent=async()=>{
    const current=stateRef.current
    if(!current.session?.authenticated)return
    const queued=current.activeWorkspaceId?current.runtimes[current.activeWorkspaceId]?.outbox.total??0:0
    const message=queued?`Данные приложения удалятся с этого телефона, а ${queued} ${pluralRu(queued,['неотправленное изменение пропадёт','неотправленных изменения пропадут','неотправленных изменений пропадут'])}. Вернуться можно по сохранённой ссылке доступа.`:'Данные приложения удалятся с этого телефона. Вернуться можно по сохранённой ссылке доступа.'
    if(!await confirm({title:'Выйти?',message,confirmLabel:'Выйти',danger:true}))return
    stopNetwork();const pending=beginLogout(current);capabilityRef.current=null;commitState(createLoggedOutState());coordinator.current?.announce(null,null)
    try{
      await pending
      if(online&&!await settlePendingLogout(true))throw new Error('Не удалось подтвердить выход на сервере')
      await refresh()
    }catch(reason){setError(reason instanceof Error?reason.message:'Не удалось завершить выход. Повторите после подключения к интернету.')}
  }

  const forgetCurrent=async()=>{
    if(!await confirm({title:'Начать заново?',message:'Данные этого профиля удалятся с телефона, включая расходы, которые не успели отправиться. Если ссылка доступа сохранена, лучше открыть её.',confirmLabel:'Начать заново',danger:true}))return
    const current=stateRef.current
    if(!online||!current.session){setError('Подключитесь к интернету, чтобы начать заново.');return}
    stopNetwork()
    const pending=forgetKnownProfile(online,current.session)
    capabilityRef.current=null;commitState(createLoggedOutState());coordinator.current?.announce(null,null)
    try{
      const forgotten=await pending
      if(!forgotten){setError('Не удалось удалить данные профиля. Подключитесь к интернету и повторите.');return}
      await refresh()
    }catch(reason){setError(reason instanceof Error?reason.message:'Не удалось удалить данные профиля. Повторите попытку.')}
  }

  const logoutUnexpected=async()=>{
    const unexpected=stateRef.current.conflictingSession
    if(!unexpected)return
    await logoutExpected(unexpected.userId,unexpected.sessionId)
    await refresh()
  }

  const confirmDraftDiscard=async()=>!draftDirty||confirm({title:'Отбросить изменения?',message:'Несохранённая сумма, категория, дата и заметка будут потеряны.',confirmLabel:'Отбросить',danger:true})
  const openCreate=async()=>{if(await confirmDraftDiscard()){setSwitchOpen(false);setCreateOpen(true)}}
  const openExpense=async(id:string|null)=>{
    if(id!==currentId&&!await confirmDraftDiscard())return
    setCurrentId(id)
    setDraftDirty(false)
    setTab('entry')
  }
  // История мемоизирована и получает неизменные колбэки; актуальное замыкание берётся из рефа.
  const openExpenseRef=useRef(openExpense);openExpenseRef.current=openExpense
  const editExpense=useCallback((id:string)=>void openExpenseRef.current(id),[])
  const createNewExpense=useCallback(()=>void openExpenseRef.current(null),[])
  const switchWorkspace=async(id:string)=>{
    if(id!==stateRef.current.activeWorkspaceId&&!await confirmDraftDiscard())return
    if(id!==stateRef.current.activeWorkspaceId){updateState((value)=>setActiveWorkspace(value,id));setCurrentId(null);setDraftDirty(false);setReviewOpen(false);setTab('entry')}
    setSwitchOpen(false)
  }
  const retryIssue=async(operationId:string):Promise<string|null>=>{
    const current=stateRef.current
    if(!current.session?.authenticated||!current.activeWorkspaceId)throw new Error('Пространство уже закрыто')
    const userId=current.session.user.id
    const activeWorkspaceId=current.activeWorkspaceId
    const result=await retryOutboxIssue(userId,activeWorkspaceId,operationId)
    await refreshWorkspaceStats(userId,activeWorkspaceId)
    if(!result)return 'Нет связи с сервером: изменение отправится, когда связь появится.'
    if(result.status==='applied'||result.status==='unchanged'){setWorkspaceReloadEpoch((value)=>value+1);return 'Сохранено на сервере.'}
    return null
  }
  const discardIssues=async(operationIds?:string[])=>{
    const current=stateRef.current
    if(!current.session?.authenticated||!current.activeWorkspaceId)throw new Error('Пространство уже закрыто')
    const userId=current.session.user.id
    const sessionId=current.session.currentSessionId
    const activeWorkspaceId=current.activeWorkspaceId
    const data=await discardOutboxIssues(userId,activeWorkspaceId,operationIds)
    updateState((value)=>value.session?.authenticated&&value.session.user.id===userId&&value.session.currentSessionId===sessionId&&value.activeWorkspaceId===activeWorkspaceId&&value.runtimes[activeWorkspaceId]?updateWorkspace(value,activeWorkspaceId,(runtime)=>({...runtime,bootstrap:data,source:'network',offline:false,status:'ready'})):value)
    await refreshWorkspaceStats(userId,activeWorkspaceId)
    setWorkspaceReloadEpoch((value)=>value+1)
    if(operationIds)return
    setIssuesOpen(false)
    setNotice('Проблемные изменения отменены. Загружаем серверную версию.')
  }
  const activateUpdate=()=>{if(draftDirty){setError('Сначала сохраните или очистите черновик расхода.');return}monitor.current?.activateWaiting()}
  const onPagerScroll=()=>{
    const node=pager.current
    // Пока лента едет к выбранной вкладке программно, промежуточные позиции ничего не монтируют: набор уже задан в setTab.
    if(node?.clientWidth&&pagerTarget.current===null){
      const workspaceId=stateRef.current.activeWorkspaceId
      const visible=pagerTabsAt(node.scrollLeft,node.clientWidth,navigationTabs)
      setPagerState((previous)=>{
        if(previous.workspaceId!==workspaceId)return {workspaceId,tab:'entry',mounted:visible}
        // Страницы не размонтируются, пока открыто это пространство: повторное монтирование мигает и заново грузит аналитику.
        const mounted=[...previous.mounted,...visible.filter((item)=>!previous.mounted.includes(item))]
        return mounted.length===previous.mounted.length?previous:{...previous,mounted}
      })
    }
    clearTimeout(pagerTimer.current)
    pagerTimer.current=setTimeout(()=>{const node=pager.current;if(!node?.clientWidth)return;if(pagerTarget.current!==null){// Safari может остановить плавную прокрутку между точками привязки, особенно при быстрых тапах по вкладкам — дожимаем без анимации.
if(Math.abs(node.scrollLeft-pagerTarget.current)>1)node.scrollLeft=pagerTarget.current;pagerTarget.current=null}const item=navigationTabs[Math.max(0,Math.min(navigationTabs.length-1,Math.round(node.scrollLeft/node.clientWidth)))];if(item)setTab(item.id)},90)
  }

  if(state.phase==='checking')return <div className="splash"><div className="brand-mark">m</div>{error&&<p>{error}</p>}</div>
  if(state.capability)return <CapabilityScreen intent={state.capability} session={session} knownUserId={state.knownUserId} finish={finishIntent} close={closeIntent} resolveIdentityConflict={resolveIdentityConflict}/>
  if(state.phase==='legacy-claim')return <LegacyClaimFlow hydrate={(next)=>hydrate(next,true)} cancel={()=>updateState((value)=>({...value,phase:'guest'}))}/>
  if(state.phase==='restricted-recovery'&&auth)return <RestrictedRecovery session={auth} hydrate={async(next)=>{await hydrate(next,true);setNotice('Перенос завершён. Ссылка доступа сохранена, старый PIN больше не нужен.')}}/>
  if(state.phase==='guest'||state.phase==='no-workspaces'||state.phase==='known-user-locked')return <><main className="empty-state"><div className="brand-mark">m</div><p className="eyebrow">Общие расходы</p><h1>{state.phase==='known-user-locked'?'Вход истёк':'Простой общий учёт расходов'}</h1><p>{state.phase==='known-user-locked'?'Откройте ссылку доступа, которую сохраняли, — или начните заново.':'Без регистрации, email и пароля.'}</p>{state.phase==='known-user-locked'?<>{state.conflictingSession&&<button type="button" className="primary" disabled={!online} onClick={()=>void logoutUnexpected().catch((reason)=>setError(reason instanceof Error?reason.message:'Не удалось выйти'))}>Выйти из другого профиля</button>}<button type="button" className={state.conflictingSession?'danger-link':'primary danger'} disabled={!online||!state.session} onClick={()=>void forgetCurrent()}>Начать заново</button>{(!online||!state.session)&&<p className="management-state" role="status">Начать заново можно, когда появится связь с сервером.</p>}</>:<><button type="button" className="primary" disabled={!online} onClick={()=>setCreateOpen(true)}>Создать пространство</button>{state.phase==='guest'&&session&&!session.authenticated&&session.legacyClaimAvailable&&<button type="button" className="sheet-cancel" onClick={()=>updateState(openLegacyClaim)}>Продолжить с существующими расходами</button>}</>}{createOpen&&<CreateWorkspaceSheet existing={Boolean(auth)} onClose={()=>setCreateOpen(false)} onCreate={create}/>} {error&&<p className="form-error" role="alert">{error}</p>}</main>{confirmation}</>

  const runtime=workspaceId?state.runtimes[workspaceId]:undefined
  const bootstrap=runtime?.bootstrap
  const workspace=auth&&workspaceId?auth.workspaces.find((item)=>item.id===workspaceId):undefined
  if(!auth||!workspaceId||!workspace||!bootstrap)return <div className="splash"><div className="brand-mark">m</div><p role={runtime?.status==='error'?'alert':'status'}>{runtime?.status==='error'?'Не удалось открыть пространство':'Загружаем пространство…'}</p>{error&&<><p className="form-error" role="alert">{error}</p><button type="button" className="sheet-cancel" onClick={()=>void refresh(true)}>Повторить</button></>}</div>
  const stats=runtime.outbox
  const serverAvailable=online&&!runtime.offline
  const issueCount=stats.conflicts+stats.failed
  const queuedCount=Math.max(0,stats.total-issueCount)
  // Одно место для состояния связи — плашка в шапке: проблемы отправки, офлайн с очередью или идущая отправка.
  const syncPill=issueCount
    ?<button type="button" className="sync-status attention" onClick={()=>setIssuesOpen(true)} aria-label={`Не отправлено: ${issueCount}. Открыть список`}><span>Не отправлено · {issueCount}</span><i/></button>
    :!serverAvailable
      ?<button type="button" className="sync-status offline" onClick={()=>{void probeServer();setWorkspaceReloadEpoch((value)=>value+1)}} aria-label={`Нет связи с сервером${queuedCount?`, ${queuedCount} ${pluralRu(queuedCount,['изменение ждёт','изменения ждут','изменений ждут'])} отправки`:''}. Проверить связь`}><span>Офлайн{queuedCount?` · ${queuedCount} ${queuedCount===1?'ждёт':'ждут'}`:''}</span>{queuedCount?<i/>:null}</button>
      :stats.total?<div className="sync-status" role="status" aria-live="polite"><span>Отправляем · {stats.total}</span><i/></div>:null
  return <div className="app-shell" key={workspaceId}>
    <header className="workspace-header"><button type="button" className="workspace-name-button" onClick={()=>setSwitchOpen(true)}><span>{workspace.name}</span><ChevronIcon/></button><div className="workspace-header-actions">{updateWaiting&&<button type="button" className="update-button" onClick={activateUpdate}>Обновить</button>}{syncPill}</div></header>
    <main className="pager" ref={pager} onScroll={onPagerScroll} onPointerDown={()=>{stopPagerAnimation();pagerTarget.current=null}} onTouchStart={()=>{stopPagerAnimation();pagerTarget.current=null}}>
      <div className="page-slot" inert={tab!=='entry'} aria-hidden={tab!=='entry'}>{mountedTabs.includes('entry')&&<EntryView userId={auth.user.id} workspaceId={workspaceId} bootstrap={bootstrap} setBootstrap={setWorkspaceData} currentId={currentId} setCurrentId={setCurrentId} refreshPending={refreshPending} onDraftDirtyChange={setDraftDirty} active={tab==='entry'}/>}</div>
      <div className="page-slot" inert={tab!=='history'} aria-hidden={tab!=='history'}>{mountedTabs.includes('history')&&<HistoryView userId={auth.user.id} workspaceId={workspaceId} bootstrap={bootstrap} setBootstrap={setWorkspaceData} edit={editExpense} createNew={createNewExpense} refreshPending={refreshPending} inbox={historyInbox} reminder={historyReminder} timeZone={timeZone}/>}</div>
      <div className="page-slot" inert={tab!=='analytics'} aria-hidden={tab!=='analytics'}>{mountedTabs.includes('analytics')&&<AnalyticsView userId={auth.user.id} workspaceId={workspaceId} bootstrap={bootstrap} theme={theme} online={serverAvailable} timeZone={timeZone}/>}</div>
      <div className="page-slot" inert={tab!=='settings'} aria-hidden={tab!=='settings'}>{mountedTabs.includes('settings')&&<SettingsView user={auth} workspace={workspace} workspaceId={workspaceId} bootstrap={bootstrap} setBootstrap={setWorkspaceData} pendingCount={stats.total} refreshPending={refreshPending} onLogout={()=>void logoutCurrent()} theme={themePreference} onThemeChange={setThemePreference} onSession={(next)=>hydrate(next,false,settingsIdentityEpoch)} online={serverAvailable} bybitStatus={bybitStatus} onBybitStatus={(status)=>updateBybitStatus(status)} onBybitSynced={reloadWorkspaceData}/>}</div>
    </main>
    <nav className="bottom-nav" aria-label="Основная навигация">{navigationTabs.map((item)=><button type="button" key={item.id} aria-current={tab===item.id?'page':undefined} aria-label={item.id==='history'&&reviewCount?`История: ${reviewCount} операций с карты ждут разбора`:item.label} className={tab===item.id?'active':''} onClick={()=>{if(tab!==item.id)tap(4);setTab(item.id)}}><span><NavIcon tab={item.id}/>{item.id==='history'&&reviewCount>0&&<b className="nav-badge">{reviewCount>99?'99+':reviewCount}</b>}</span><small>{item.label}</small></button>)}</nav>
    {reviewOpen&&reviewConnected&&<ReviewOverlay onClose={()=>setReviewOpen(false)}><BybitReviewView workspaceId={workspaceId} categories={bootstrap.categories} currencies={bootstrap.currencies} tags={bootstrap.tags??[]} onTag={(tag)=>setWorkspaceData((data)=>({...data,tags:[tag,...(data.tags??[]).filter((item)=>item.id!==tag.id)]}))} online={serverAvailable} onStatus={updateBybitStatus} pendingCount={bybitStatus?.pendingCount??0} active onExpense={(expense)=>setWorkspaceData((data)=>({...data,expenses:[expense,...data.expenses.filter((item)=>item.id!==expense.id)]}))} onExpenseUndo={(expenseId)=>setWorkspaceData((data)=>({...data,expenses:data.expenses.filter((item)=>item.id!==expenseId)}))}/></ReviewOverlay>}
    {switchOpen&&<WorkspaceSwitcher items={auth.workspaces} active={workspaceId} runtimes={state.runtimes} online={serverAvailable} onSelect={(id)=>void switchWorkspace(id)} onCreate={()=>void openCreate()}/>} {createOpen&&<CreateWorkspaceSheet existing onClose={()=>setCreateOpen(false)} onCreate={create}/>} {issuesOpen&&<SyncIssuesSheet userId={auth.user.id} workspaceId={workspaceId} bootstrap={bootstrap} online={serverAvailable} onClose={()=>setIssuesOpen(false)} onRetry={retryIssue} onDiscard={discardIssues}/>} {initialRecovery&&<RecoverySave key={initialRecovery.completionToken} prepared={initialRecovery} mode="initial" close={()=>setInitialRecovery(null)} complete={async()=>{
      const outcome=await completeRotationSafely({prepared:initialRecovery,targetUserId:auth.user.id})
      if(outcome.status!=='completed')throw new Error(outcome.status==='rotation-stale'?'Параллельно была сохранена другая ссылка доступа.':'Не удалось подтвердить ссылку. Повторите из настроек.')
      await hydrate(outcome.session,true)
      setNotice('Ссылка доступа сохранена')
    }}/>}
    {error && <Toast toast={{text:error,urgent:true}} onDismiss={()=>setError('')}/>}
    {notice&&<Toast toast={notice} onDismiss={hideNotice}/>} {confirmation}
    {debugFlag==='swipe'&&<SwipeDebug/>}
  </div>
}

// Экраны и утилиты живут в своих файлах; тесты и main продолжают импортировать их отсюда.
export { EntryView } from './screens/Entry'
export { HistoryView } from './screens/History'
export { AnalyticsView, fallbackAnalytics } from './screens/Analytics'
export { SettingsView, exportHistoryCsv } from './screens/Settings'
export { BybitReviewView } from './screens/Review'
export { CapabilityScreen, CreateWorkspaceSheet, RecoverySave, WorkspaceSwitcher } from './screens/Access'
export { useToast } from './ui'
export { amountSize, formatDateRange, formatEntryDate, formatHistoryDate, formatShortDate } from './format'
