import { parseHistoryPreferences } from './history'
import type { AccountSettings, AuthenticatedSession, MemberSettings, WorkspaceBootstrap } from './types'
import { localDateKey } from './utils'

/*
 * Личные настройки живут в аккаунте (сервер, settings.ts): тема — у человека целиком, валюты и фильтры истории —
 * у человека в каждом пространстве. Здесь их путь через телефон. Изменение сразу видно на экране и ложится в очередь;
 * пока оно не дошло до сервера, оно перекрывает его ответ. То, что телефон помнил до переезда настроек в аккаунт,
 * один раз отправляется туда же — если в аккаунте этого ещё нет.
 */

/** Изменение настроек: `null` возвращает значение по умолчанию. */
export type SettingsPatch<T> = { [K in keyof T]?: T[K] | null }

/** Тема до входа и в первом кадре: копия темы аккаунта на этом телефоне. До переезда тема хранилась только здесь. */
export const THEME_MIRROR = 'moapp:theme'

const storage = (): Storage | null => {
  if (typeof localStorage === 'undefined') return null
  return typeof localStorage.getItem === 'function' && typeof localStorage.setItem === 'function' ? localStorage : null
}

const accountQueueKey = (userId: string) => `moapp:v2:user:${userId}:pending-settings`
const memberQueueKey = (userId: string, workspaceId: string) => `moapp:v2:user:${userId}:workspace:${workspaceId}:pending-settings`
const themeMovedKey = (userId: string) => `moapp:v2:user:${userId}:theme-moved`
const legacyMemberKey = (userId: string, workspaceId: string, name: 'last-currency' | 'analytics-currency' | 'history-filters') => `moapp:v2:user:${userId}:workspace:${workspaceId}:${name}`

export function patchSettings<T extends object>(settings: T | undefined, patch: SettingsPatch<T>): T {
  const next: Record<string, unknown> = { ...settings }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key]
    else if (value !== undefined) next[key] = value
  }
  return next as T
}

function readQueue(key: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(storage()?.getItem(key) ?? 'null') as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch { return {} }
}

function writeQueue(key: string, queue: Record<string, unknown>): void {
  try {
    if (Object.keys(queue).length) storage()?.setItem(key, JSON.stringify(queue))
    else storage()?.removeItem(key)
  } catch { /* Хранилище недоступно: изменение уйдёт, пока приложение открыто. */ }
}

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

export const queuedAccountSettings = (userId: string) => readQueue(accountQueueKey(userId)) as SettingsPatch<AccountSettings>
export const queuedMemberSettings = (userId: string, workspaceId: string) => readQueue(memberQueueKey(userId, workspaceId)) as SettingsPatch<MemberSettings>

export function queueAccountSettings(userId: string, patch: SettingsPatch<AccountSettings>): void {
  writeQueue(accountQueueKey(userId), { ...readQueue(accountQueueKey(userId)), ...patch })
}

export function queueMemberSettings(userId: string, workspaceId: string, patch: SettingsPatch<MemberSettings>): void {
  writeQueue(memberQueueKey(userId, workspaceId), { ...readQueue(memberQueueKey(userId, workspaceId)), ...patch })
}

/* Сервер принял (или окончательно отверг) отправленное: из очереди уходит только то, что с тех пор не менялось. */
function settle(key: string, sent: Record<string, unknown>): void {
  const queue = readQueue(key)
  for (const [name, value] of Object.entries(sent)) if (same(queue[name], value)) delete queue[name]
  writeQueue(key, queue)
}

export const settleAccountSettings = (userId: string, sent: SettingsPatch<AccountSettings>) => settle(accountQueueKey(userId), sent)
export const settleMemberSettings = (userId: string, workspaceId: string, sent: SettingsPatch<MemberSettings>) => settle(memberQueueKey(userId, workspaceId), sent)
export const dropMemberSettings = (userId: string, workspaceId: string) => writeQueue(memberQueueKey(userId, workspaceId), {})

/** Пространства, где остались неотправленные настройки. */
export function workspacesWithQueuedSettings(userId: string): string[] {
  const local = storage()
  if (!local) return []
  const prefix = `moapp:v2:user:${userId}:workspace:`
  const ids: string[] = []
  for (let index = 0; index < local.length; index += 1) {
    const key = local.key(index)
    if (key?.startsWith(prefix) && key.endsWith(':pending-settings')) ids.push(key.slice(prefix.length, -':pending-settings'.length))
  }
  return ids
}

/*
 * Тема, выбранная на этом телефоне до переезда, отправляется в аккаунт один раз — если там темы ещё нет.
 * Сессия из старого кэша приходит без поля `settings`: что лежит в аккаунте, тогда неизвестно, и ждём ответа сервера.
 */
function moveLegacyTheme(session: AuthenticatedSession): void {
  const local = storage()
  if (!local || !session.settings || local.getItem(themeMovedKey(session.user.id))) return
  const theme = local.getItem(THEME_MIRROR)
  if (!session.settings.theme && (theme === 'light' || theme === 'dark') && queuedAccountSettings(session.user.id).theme === undefined) {
    queueAccountSettings(session.user.id, { theme })
  }
  local.setItem(themeMovedKey(session.user.id), '1')
}

/* Валюты и фильтры истории, которые пространство помнило на этом телефоне, — так же, один раз и только поверх пустого. */
function moveLegacyMemberSettings(userId: string, workspaceId: string, known: MemberSettings): void {
  const local = storage()
  if (!local) return
  const queued = queuedMemberSettings(userId, workspaceId)
  const moved: SettingsPatch<MemberSettings> = {}
  const keep = (name: keyof MemberSettings) => known[name] === undefined && queued[name] === undefined
  for (const [name, legacy] of [['lastCurrency', 'last-currency'], ['analyticsCurrency', 'analytics-currency']] as const) {
    const value = local.getItem(legacyMemberKey(userId, workspaceId, legacy))
    if (value === null) continue
    if (keep(name) && /^[A-Z]{3}$/.test(value)) moved[name] = value
    local.removeItem(legacyMemberKey(userId, workspaceId, legacy))
  }
  const filters = local.getItem(legacyMemberKey(userId, workspaceId, 'history-filters'))
  if (filters !== null) {
    // Строка поиска не переезжает: в аккаунте живут только фильтры.
    const { query: _query, ...stored } = parseHistoryPreferences(filters, localDateKey(new Date()))
    if (keep('historyFilters')) moved.historyFilters = stored
    local.removeItem(legacyMemberKey(userId, workspaceId, 'history-filters'))
  }
  if (Object.keys(moved).length) queueMemberSettings(userId, workspaceId, moved)
}

/** Сессия с настройками аккаунта, как их видит этот телефон: ответ сервера, поверх него — ещё не отправленное. */
export function withAccountSettings(session: AuthenticatedSession): AuthenticatedSession {
  moveLegacyTheme(session)
  const queued = queuedAccountSettings(session.user.id)
  return Object.keys(queued).length ? { ...session, settings: patchSettings(session.settings, queued) } : session
}

/** Данные пространства со своими настройками человека в нём: ответ сервера, поверх него — ещё не отправленное. */
export function withMemberSettings(userId: string, data: WorkspaceBootstrap): WorkspaceBootstrap {
  if (data.settings) moveLegacyMemberSettings(userId, data.workspaceId, data.settings)
  const queued = queuedMemberSettings(userId, data.workspaceId)
  return Object.keys(queued).length ? { ...data, settings: patchSettings(data.settings, queued) } : data
}
