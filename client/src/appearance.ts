import type { Accent, AccountSettings, TextSize, ThemePreference } from './types'

/*
 * Внешний вид — личные настройки аккаунта: тема, свой цвет и размер текста. Цвета интерфейса — токены
 * в workspace-layout.css по атрибуту data-accent, размер текста — множитель по data-text-size. Здесь названия цветов,
 * образцы для выбора и цвет графиков, которым CSS-токены недоступны. Копия на этом телефоне нужна только для первого
 * кадра, пока аккаунт не ответил, и для экрана истёкшего входа; при выходе она стирается.
 */

export type Appearance = { theme: ThemePreference; accent: Accent; textSize: TextSize }

export const DEFAULT_APPEARANCE: Appearance = { theme: 'system', accent: 'sage', textSize: 'normal' }

type AccentInfo = {
  id: Accent
  name: string
  /** Сам акцент в светлой и тёмной теме — как в CSS; он же образец в шите «Внешний вид». */
  light: string
  dark: string
  /** Линия и столбики графиков: в светлой теме чуть светлее акцента, чтобы не спорить с текстом. */
  chart: { light: string; dark: string }
}

export const ACCENTS: readonly AccentInfo[] = [
  { id: 'sage', name: 'шалфейный', light: '#58704f', dark: '#b1cfa3', chart: { light: '#758d69', dark: '#b1cfa3' } },
  { id: 'terracotta', name: 'терракотовый', light: '#8e5845', dark: '#eeb5a2', chart: { light: '#ae745f', dark: '#eeb5a2' } },
  { id: 'sand', name: 'песочный', light: '#7f6335', dark: '#debf90', chart: { light: '#9d7f50', dark: '#debf90' } },
  { id: 'blue', name: 'голубой', light: '#436c8f', dark: '#9ecaf0', chart: { light: '#5e89af', dark: '#9ecaf0' } },
  { id: 'lilac', name: 'сиреневый', light: '#745d86', dark: '#d3b8e8', chart: { light: '#9279a5', dark: '#d3b8e8' } },
  { id: 'graphite', name: 'графитовый', light: '#63696e', dark: '#bec5cd', chart: { light: '#7f858c', dark: '#bec5cd' } },
]

export const TEXT_SIZES: readonly { id: TextSize; label: string }[] = [{ id: 'normal', label: 'Обычный' }, { id: 'large', label: 'Крупный' }]

const isTheme = (value: unknown): value is ThemePreference => value === 'system' || value === 'light' || value === 'dark'
const isAccent = (value: unknown): value is Accent => ACCENTS.some((accent) => accent.id === value)
const isTextSize = (value: unknown): value is TextSize => TEXT_SIZES.some((size) => size.id === value)

export const accentInfo = (accent: Accent) => ACCENTS.find((item) => item.id === accent) ?? ACCENTS[0]!

/** Внешний вид по настройкам аккаунта: чего человек не выбирал, то по умолчанию. */
export function appearanceOf(settings: AccountSettings): Appearance {
  return {
    theme: isTheme(settings.theme) ? settings.theme : DEFAULT_APPEARANCE.theme,
    accent: isAccent(settings.accent) ? settings.accent : DEFAULT_APPEARANCE.accent,
    textSize: isTextSize(settings.textSize) ? settings.textSize : DEFAULT_APPEARANCE.textSize,
  }
}

/** Линия графика и заливка под ней в цвете человека. */
export function chartColors(accent: Accent, theme: 'light' | 'dark') {
  const line = accentInfo(accent).chart[theme]
  const [red, green, blue] = [1, 3, 5].map((start) => parseInt(line.slice(start, start + 2), 16))
  return { line, fill: `rgba(${red},${green},${blue},${theme === 'dark' ? .14 : .12})` }
}

/** Свой цвет и размер текста — атрибутами корня; по умолчанию атрибутов нет, и работают исходные токены. */
export function applyAppearance(root: HTMLElement, { accent, textSize }: Pick<Appearance, 'accent' | 'textSize'>): void {
  if (accent === DEFAULT_APPEARANCE.accent) delete root.dataset.accent
  else root.dataset.accent = accent
  if (textSize === DEFAULT_APPEARANCE.textSize) delete root.dataset.textSize
  else root.dataset.textSize = textSize
}

/** До переезда настроек в аккаунт тема хранилась только под этим ключом; теперь это копия темы аккаунта. */
export const THEME_MIRROR = 'moapp:theme'
const ACCENT_MIRROR = 'moapp:accent'
const TEXT_SIZE_MIRROR = 'moapp:text-size'

const storage = (): Storage | null => {
  try {
    if (typeof localStorage === 'undefined') return null
    return typeof localStorage.getItem === 'function' && typeof localStorage.setItem === 'function' ? localStorage : null
  } catch { return null }
}

export function readAppearanceMirror(): Appearance {
  try {
    const local = storage()
    const theme = local?.getItem(THEME_MIRROR)
    const accent = local?.getItem(ACCENT_MIRROR)
    const textSize = local?.getItem(TEXT_SIZE_MIRROR)
    return { theme: isTheme(theme) ? theme : 'system', accent: isAccent(accent) ? accent : 'sage', textSize: isTextSize(textSize) ? textSize : 'normal' }
  } catch { return DEFAULT_APPEARANCE }
}

export function writeAppearanceMirror(appearance: Appearance): void {
  try {
    const local = storage()
    if (!local) return
    for (const [key, value, fallback] of [[THEME_MIRROR, appearance.theme, 'system'], [ACCENT_MIRROR, appearance.accent, 'sage'], [TEXT_SIZE_MIRROR, appearance.textSize, 'normal']] as const) {
      if (value === fallback) local.removeItem(key)
      else local.setItem(key, value)
    }
  } catch { /* копия только ускоряет первый кадр */ }
}

export function clearAppearanceMirror(): void {
  try {
    const local = storage()
    for (const key of [THEME_MIRROR, ACCENT_MIRROR, TEXT_SIZE_MIRROR]) local?.removeItem(key)
  } catch { /* нечего стирать */ }
}
