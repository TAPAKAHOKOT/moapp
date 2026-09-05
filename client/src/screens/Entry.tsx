import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { WorkspaceApiError as ApiError, submitExpenseOperation } from '../workspace-api'
import { getWorkspacePreference, setWorkspacePreference } from '../app-state'
import type { Category, Currency, Expense, Tag } from '../types'
import { amountToMinor, applyKeypad, cachedNumberFormat, formatAmountInput, isoToLocalInput, localInputToIso, swipeDirection } from '../utils'
import { ChevronIcon, CurrencySheet, GridIcon, Toast, TrashIcon, prefersReducedMotion, tap, useConfirm, useDialog, useToast } from '../ui'
import { amountSize, formatEntryDate, formatShortWeekday, inputFromExpense } from '../format'
import type { Bootstrap } from '../format'
import { ExtrasRow, NoteSheet, TAG_COLORS, createTagOrReuse } from '../tags'

export const EMPTY_FORM = { amount: '', currency: 'RSD', note: '', occurredAt: '', tagIds: [] as string[], categoryId: '' }

// Черновик считается непустым, если в нём есть что угодно, а не только сумма: категория и теги теперь тоже выбираются до сохранения.
export const formHasContent = (form: typeof EMPTY_FORM) => Boolean(form.amount || form.note || form.occurredAt || form.tagIds.length || form.categoryId)

export const SWIPE_START = 14

export const SWIPE_COMMIT = 64

export const CARD_GAP = 18

// Вид карточки задаётся её содержимым, а не состоянием экрана: соседняя карточка сохранённого расхода
// рисуется теми же правилами, что и живая, и в момент подмены ничего не меняет цвет и не сдвигается.
export type CardFace = { kind: 'new' | 'edit'; title: string; date: string; amount: string; currency: string }

export function EntryCard({ face, onDate, onCurrency, disabled = false, limitHit = 0 }: { face: CardFace; onDate?: () => void; onCurrency?: () => void; disabled?: boolean; limitHit?: number }) {
  const inert = onCurrency ? undefined : -1
  return <>
    <header className={`topline${face.kind === 'edit' ? ' topline-edit' : ''}`}>
      <div>
        <p className="eyebrow">{face.title}</p>
        <button type="button" className="date-chip" onClick={onDate} tabIndex={inert} disabled={disabled}><span>{face.date}</span><ChevronIcon/></button>
      </div>
    </header>
    <div className="amount-row">
      <output key={limitHit} className={`amount-value${face.amount ? '' : ' empty'}${limitHit ? ' limit' : ''}`} data-size={amountSize(face.amount)} aria-label="Сумма">{formatAmountInput(face.amount) || '0'}</output>
      <button type="button" onClick={onCurrency} tabIndex={inert} disabled={disabled}>{face.currency}<ChevronIcon/></button>
    </div>
  </>
}

// Блок действий над расходом («новый» и «удалить») проявляется и гаснет вместе с карточкой, а не скачком при подмене.
export const ENTRY_ACTIONS_HIDDEN: React.CSSProperties = { opacity: 0, transform: 'scale(.82)' }

export function styleEntryActions(node: HTMLElement | null, presence: number, duration: number) {
  if (!node) return
  if (prefersReducedMotion()) duration = 0
  const easing = 'cubic-bezier(.25,.8,.3,1)'
  node.style.transition = duration ? `opacity ${duration}ms ${easing}, transform ${duration}ms ${easing}` : 'none'
  node.style.opacity = String(presence)
  node.style.transform = `scale(${0.82 + presence * 0.18})`
}

export function DateSheet({ value, onClose, onPick }: { value: string; onClose: () => void; onPick: (value: string) => void }) {
  const now = () => isoToLocalInput(new Date().toISOString())
  const [draft, setDraft] = useState(value || now())
  const [validation, setValidation] = useState('')
  const dialogRef = useDialog(onClose)
  const shift = (days: number) => {
    const date = new Date()
    date.setDate(date.getDate() - days)
    setValidation('')
    setDraft(isoToLocalInput(date.toISOString()))
  }
  const valid = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(draft)
  return <div className="sheet-backdrop" onMouseDown={onClose}>
    <form ref={dialogRef as React.Ref<HTMLFormElement>} className="bottom-sheet editor" role="dialog" aria-modal="true" aria-labelledby="date-title" noValidate onSubmit={(event) => { event.preventDefault(); if (!draft) { setValidation('Выберите дату и время.'); return } onPick(draft) }} onMouseDown={(event) => event.stopPropagation()}>
      <div className="sheet-handle"/>
      <div className="sheet-title"><h2 id="date-title">Когда</h2><button type="button" className="icon-button" data-dialog-initial-focus onClick={onClose} aria-label="Закрыть">×</button></div>
      <p className="date-preview" aria-live="polite">{valid ? formatEntryDate(draft) : 'Дата не выбрана'}</p>
      <div className="date-presets"><button type="button" onClick={() => shift(0)}>Сейчас</button><button type="button" onClick={() => shift(1)}>Вчера</button><button type="button" onClick={() => shift(2)}>Позавчера</button></div>
      <label className="date-field">Дата и время <b className="weekday-badge">{formatShortWeekday(draft)}</b><input type="datetime-local" aria-invalid={Boolean(validation)} value={draft} onChange={(event) => { setValidation(''); setDraft(event.target.value) }}/></label>
      {validation && <p className="form-error" role="alert">{validation}</p>}
      <button className="primary">Готово</button>
    </form>
  </div>
}

export const Keypad = memo(function Keypad({ onKey, disabled = false }: { onKey: (key: string) => void; disabled?: boolean }) {
  const press = (key: string) => { tap(); onKey(key) }
  return <div className="keypad" aria-label="Клавиатура суммы">{['1','2','3','4','5','6','7','8','9',',','0','⌫'].map((key) => <button
    key={key}
    type="button"
    disabled={disabled}
    className={key === ',' || key === '⌫' ? 'keypad-aux' : undefined}
    onPointerDown={(event) => event.preventDefault()}
    onPointerUp={() => press(key)}
    onClick={(event) => { if (event.detail === 0) press(key) }}
    aria-label={key === '⌫' ? 'Удалить цифру' : key}
  >{key}</button>)}</div>
})

export function CategorySheet({ categories, selectedId, onClose, onPick }: { categories: Category[]; selectedId?: string; onClose: () => void; onPick: (category: Category) => void }) {
  const dialogRef = useDialog(onClose)
  return <div className="sheet-backdrop" onMouseDown={onClose}><section ref={dialogRef} className="bottom-sheet" role="dialog" aria-modal="true" aria-labelledby="category-sheet-title" onMouseDown={(e) => e.stopPropagation()}>
    <div className="sheet-handle"/><div className="sheet-title"><h2 id="category-sheet-title">Другие категории</h2><button type="button" className="icon-button" data-dialog-initial-focus onClick={onClose} aria-label="Закрыть">×</button></div>
    <div className="category-grid">{categories.map((category) => <button type="button" key={category.id} aria-pressed={category.id === selectedId} className={category.id === selectedId ? 'selected' : undefined} onClick={() => onPick(category)}><i style={{ backgroundColor: category.color ?? '#a9afa5' }}/><span>{category.name}</span></button>)}</div>
    {!categories.length && <p className="sheet-empty" role="status">Других категорий пока нет. Их можно добавить в настройках.</p>}
  </section></div>
}

// Нижняя часть экрана ввода для соседней записи: во время свайпа она проявляется поверх живой, чтобы категория,
// теги, заметка и кнопка сохранения менялись вместе с движением пальца, а не скачком при подмене. Слой чисто декоративный.
export const SETTLE_MS = 80

export type LowerPreviewState = { key: string; categoryId: string | null; tagIds: string[]; note: string; saveLabel: string; canSave: boolean }

// Подпись кнопки сохранения сама сообщает, чего не хватает: суммы, категории или изменений.
export function saveButtonLabel({ amount, currency, categoryId, editing, dirty, currencies }: { amount: string; currency: string; categoryId: string | null; editing: boolean; dirty: boolean; currencies: Currency[] }) {
  const ready = Boolean(amount) && Number(amount) > 0
  if (!ready) return { label: 'Введите сумму', canSave: false }
  if (!categoryId) return { label: 'Выберите категорию', canSave: false }
  if (editing && !dirty) return { label: 'Сохранить', canSave: false }
  const decimals = currencies.find((item) => item.code === currency)?.decimals ?? 2
  return { label: `Сохранить ${cachedNumberFormat('ru-RU', { maximumFractionDigits: decimals }).format(Number(amount))} ${currency}`, canSave: true }
}

// Ряд плиток категорий: основные — плитками, остальные — за плиткой «Ещё N», которая показывает выбранную из них.
export function CategoryTiles({ main, additional, selectedId, disabled = false, inert = false, onPick, onMore }: { main: Category[]; additional: Category[]; selectedId: string | null; disabled?: boolean; inert?: boolean; onPick?: (category: Category) => void; onMore?: () => void }) {
  const other = selectedId && !main.some((item) => item.id === selectedId) ? additional.find((item) => item.id === selectedId) ?? null : null
  const tabIndex = inert ? -1 : undefined
  return <div className="categories"><div className="main-categories">
    {main.map((category) => <button type="button" key={category.id} disabled={disabled} tabIndex={tabIndex} aria-pressed={category.id === selectedId} className={category.id === selectedId ? 'selected' : undefined} onClick={() => onPick?.(category)}><i style={{ backgroundColor: category.color ?? '#a9afa5' }}/><span>{category.name}</span></button>)}
    {additional.length > 0 && <button type="button" disabled={disabled} tabIndex={tabIndex} aria-pressed={Boolean(other)} className={other ? 'selected' : undefined} onClick={onMore}>{other ? <i style={{ backgroundColor: other.color ?? '#a9afa5' }}/> : <GridIcon/>}<span>{other ? other.name : `Ещё ${additional.length}`}</span></button>}
  </div></div>
}

export function EntryLowerPreview({ main, additional, tags, state }: { main: Category[]; additional: Category[]; tags: Tag[]; state: LowerPreviewState }) {
  return <>
    <CategoryTiles main={main} additional={additional} selectedId={state.categoryId} inert/>
    <ExtrasRow tags={tags} selected={state.tagIds} note={state.note} inert onChange={() => {}} onNote={() => {}}/>
    <div className="entry-save"><button type="button" className="primary" tabIndex={-1} disabled={!state.canSave}>{state.saveLabel}</button>{state.key !== 'blank' && <button type="button" className="sheet-cancel ghost" tabIndex={-1} disabled aria-hidden>Отменить</button>}</div>
  </>
}

export function EntryView({ userId, workspaceId, bootstrap, setBootstrap, currentId, setCurrentId, refreshPending, onDraftDirtyChange, active }: {
  userId: string
  workspaceId: string
  bootstrap: Bootstrap; setBootstrap: React.Dispatch<React.SetStateAction<Bootstrap>>; currentId: string | null; setCurrentId: (id: string | null) => void; refreshPending: () => void; onDraftDirtyChange: (dirty: boolean) => void; active: boolean
}) {
  const activeExpenses = useMemo(() => bootstrap.expenses.filter((item) => !item.deletedAt).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)), [bootstrap.expenses])
  const currentIndex = currentId ? activeExpenses.findIndex((item) => item.id === currentId) : -1
  const current = currentIndex >= 0 ? activeExpenses[currentIndex] : null
  const [form, setForm] = useState(EMPTY_FORM)
  const [categorySheet, setCategorySheet] = useState(false)
  const [currencySheet, setCurrencySheet] = useState(false)
  const [dateSheet, setDateSheet] = useState(false)
  const [noteSheet, setNoteSheet] = useState(false)
  const [saving, setSaving] = useState(false)
  const { toast, notify, dismiss } = useToast()
  const { confirm, confirmation } = useConfirm()
  const swipe = useRef<{ x: number; y: number; lastX: number; active: boolean; touchId: number | null } | null>(null)
  const suppressTouchPointerUp = useRef(false)
  const entryRef = useRef<HTMLElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const actionsRef = useRef<HTMLDivElement>(null)
  const lowerLiveRef = useRef<HTMLDivElement>(null)
  const lowerPreviewRef = useRef<HTMLDivElement>(null)
  // Содержимое превью замораживается на момент жеста: после подмены соседи меняются, а слой должен ещё
  // прикрывать живой, пока тот дотягивает свой переход к новой записи.
  const [swipePreview, setSwipePreview] = useState<LowerPreviewState | null>(null)
  const previewTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(previewTimer.current), [])
  const lastFade = useRef(0)
  // Превью непрозрачное и лежит поверх живого слоя: где содержимое совпадает, картинка не меняется вовсе,
  // а различия (выбранная категория, теги, заметка) проявляются пропорционально сдвигу.
  const styleCrossfade = (fade: number, duration: number) => {
    lastFade.current = fade
    const node = lowerPreviewRef.current
    if (!node) return
    node.style.transition = duration && !prefersReducedMotion() ? `opacity ${duration}ms cubic-bezier(.25,.8,.3,1)` : 'none'
    node.style.opacity = String(fade)
  }
  useLayoutEffect(() => {
    // Слой мог смонтироваться уже после первого сдвига — догоняем текущее значение без перехода.
    const node = lowerPreviewRef.current
    if (node && swipePreview) { node.style.transition = 'none'; node.style.opacity = String(lastFade.current) }
  }, [swipePreview])
  // Единственное, что существует только у сохранённой записи, — кнопка удаления сверху; она проявляется одним движением.
  const setActionsPresence = (presence: number, duration: number) => styleEntryActions(actionsRef.current, presence, duration)
  const offset = useRef(0)
  const swapped = useRef(false)
  const committing = useRef(false)
  const swapTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // Черновик несохранённого нового расхода, чтобы свайп по истории не стирал набранное.
  const draft = useRef(EMPTY_FORM)
  const synced = useRef<{ id: string; form: typeof EMPTY_FORM }>({ id: '', form: EMPTY_FORM })
  const formRef = useRef(form)
  formRef.current = form

  useEffect(() => () => clearTimeout(swapTimer.current), [])

  // Соседняя карточка уже стоит на месте текущей, поэтому ленту возвращаем в ноль синхронно — до кадра, без мигания.
  useLayoutEffect(() => {
    const didSwap = swapped.current
    if (didSwap) {
      swapped.current = false
      committing.current = false
      const node = trackRef.current
      if (node) { node.style.transition = 'none'; node.style.transform = ''; offset.current = 0 }
    }
    // При свайпе новое состояние уже достигнуто анимацией; при удалении и открытии из истории кнопка мягко гаснет или проявляется сама.
    setActionsPresence(currentId ? 1 : 0, didSwap ? 0 : 180)
    clearTimeout(previewTimer.current)
    if (didSwap) {
      // Живой слой получает новую запись следующим рендером; на этот кадр его переходы выключены, чтобы под превью
      // не тянулась анимация от старого состояния, иначе следующий быстрый свайп покажет её.
      const live = lowerLiveRef.current
      live?.classList.add('settling')
      previewTimer.current = setTimeout(() => { styleCrossfade(0, 0); setSwipePreview(null); live?.classList.remove('settling') }, SETTLE_MS)
    } else {
      styleCrossfade(0, 0)
      setSwipePreview(null)
    }
  }, [currentId])

  const blankForm = () => ({ ...EMPTY_FORM, currency: getWorkspacePreference(userId, workspaceId, 'last-currency') || 'RSD' })
  useLayoutEffect(() => {
    const base = current ? inputFromExpense(current, bootstrap.currencies) : formHasContent(draft.current) ? draft.current : blankForm()
    // Свежую версию записи подхватываем, только пока пользователь не начал править её сам.
    const sameRecord = synced.current.id === (currentId || '')
    if (sameRecord && JSON.stringify(form) !== JSON.stringify(synced.current.form)) return
    synced.current = { id: currentId || '', form: base }
    setForm(base)
  }, [currentId, current?.version]) // eslint-disable-line react-hooks/exhaustive-deps

  const [limitHit, setLimitHit] = useState(0)
  const key = useCallback((value: string) => {
    const decimalsFor = (currency: string) => bootstrap.currencies.find((item) => item.code === currency)?.decimals ?? 2
    const latest = formRef.current
    if (applyKeypad(latest.amount, value, decimalsFor(latest.currency)) === latest.amount) {
      // Отклонённая цифра (лимит разрядов или десятичных): без этого клавиатура молчит и кажется сломанной.
      if (value !== '⌫') { tap([10, 40, 10]); setLimitHit((count) => count + 1) }
      return
    }
    setForm((previous) => ({ ...previous, amount: applyKeypad(previous.amount, value, decimalsFor(previous.currency)) }))
  }, [bootstrap.currencies])

  const buildExpense = (submittedForm = form, submittedCurrent = current): Expense => {
    const now = new Date().toISOString()
    return {
      id: submittedCurrent?.id || crypto.randomUUID(), amountMinor: amountToMinor(submittedForm.amount, submittedForm.currency, bootstrap.currencies), currency: submittedForm.currency,
      categoryId: submittedForm.categoryId, note: submittedForm.note.trim() || null, occurredAt: submittedForm.occurredAt ? localInputToIso(submittedForm.occurredAt) : now, tagIds: [...submittedForm.tagIds].sort(),
      createdAt: submittedCurrent?.createdAt || now, updatedAt: now, version: submittedCurrent ? submittedCurrent.version + 1 : 1, deletedAt: null, pending: !navigator.onLine,
    }
  }

  const submitExpense = async () => {
    const submittedForm = { ...form }
    const submittedCurrent = current
    if (!submittedForm.amount || Number(submittedForm.amount) <= 0) { notify('Сначала введите сумму'); return }
    if (!submittedForm.categoryId) { notify('Выберите категорию'); return }
    setSaving(true); setCategorySheet(false)
    const expense = buildExpense(submittedForm, submittedCurrent)
    const previousExpense = bootstrap.expenses.find((item) => item.id === expense.id)
    setBootstrap((data) => ({ ...data, expenses: [expense, ...data.expenses.filter((item) => item.id !== expense.id)] }))
    try {
      const result = await submitExpenseOperation(userId, workspaceId, submittedCurrent ? 'updateExpense' : 'createExpense', expense)
      if (result?.expense) setBootstrap((data) => ({ ...data, expenses: data.expenses.map((item) => item.id === expense.id ? result.expense! : item) }))
      else if (!result) setBootstrap((data) => ({ ...data, expenses: data.expenses.map((item) => item.id === expense.id ? { ...item, pending:true } : item) }))
      notify(result?.status === 'conflict' ? 'Изменение конфликтует с сервером. Откройте «Не отправлено» вверху.' : submittedCurrent ? 'Изменения сохранены' : 'Расход добавлен')
      if (!submittedCurrent && !currentId && JSON.stringify(formRef.current) === JSON.stringify(submittedForm)) {
        const next = { ...EMPTY_FORM, currency: submittedForm.currency }
        draft.current = next
        synced.current = { id: '', form: next }
        setForm(next)
      } else if (submittedCurrent && currentId === submittedCurrent.id) {
        synced.current = { id: submittedCurrent.id, form: submittedForm }
      }
      refreshPending()
    } catch (error) {
      setBootstrap((data) => {
        const optimistic = data.expenses.find((item) => item.id === expense.id)
        if (optimistic?.version !== expense.version || optimistic.updatedAt !== expense.updatedAt) return data
        return { ...data, expenses: previousExpense
          ? data.expenses.map((item) => item.id === expense.id ? previousExpense : item)
          : data.expenses.filter((item) => item.id !== expense.id) }
      })
      notify(error instanceof ApiError ? error.message : 'Не удалось сохранить', undefined, true)
    }
    finally { setSaving(false) }
  }

  // Плитка категории только выбирает — и для нового расхода, и для правки. Сохраняет одна кнопка внизу.
  const chooseCategory = (category: Category) => {
    tap(6)
    setForm((value) => ({ ...value, categoryId: category.id }))
    setCategorySheet(false)
  }

  const restore = async (deleted: Expense) => {
    // Сервер при обновлении сам снимает deleted_at, поэтому возврат — это обычная правка поверх версии после удаления.
    const restored: Expense = { ...deleted, deletedAt: null, updatedAt: new Date().toISOString(), version: deleted.version + 1, pending: !navigator.onLine }
    setBootstrap((data) => ({ ...data, expenses: data.expenses.map((item) => item.id === restored.id ? restored : item) }))
    try {
      const result = await submitExpenseOperation(userId, workspaceId, 'updateExpense', restored)
      if (result?.expense) setBootstrap((data) => ({ ...data, expenses: data.expenses.map((item) => item.id === restored.id ? result.expense! : item) }))
      notify(result?.status === 'conflict' ? 'Возврат конфликтует с сервером. Откройте «Не отправлено» вверху.' : 'Расход возвращён')
    } catch (error) {
      setBootstrap((data) => ({ ...data, expenses: data.expenses.map((item) => item.id === deleted.id && item.version === restored.version && item.updatedAt === restored.updatedAt ? deleted : item) }))
      notify(error instanceof ApiError ? error.message : 'Не удалось вернуть расход', undefined, true)
    }
    refreshPending()
  }

  const remove = async () => {
    if (!current) return
    const target = current
    const deletedAt = new Date().toISOString()
    setBootstrap((data) => ({ ...data, expenses: data.expenses.map((item) => item.id === target.id ? { ...item, deletedAt, pending: !navigator.onLine } : item) }))
    setCurrentId(null)
    try {
      const result = await submitExpenseOperation(userId, workspaceId, 'deleteExpense', target)
      // Версию после удаления сервер поднимает на единицу — без неё возврат ушёл бы в конфликт.
      const stored: Expense = result?.expense ?? { ...target, deletedAt, version: target.version + 1, pending: true }
      setBootstrap((data) => ({ ...data, expenses: data.expenses.map((item) => item.id === target.id ? stored : item) }))
      if (result?.status === 'conflict') notify('Удаление конфликтует с сервером. Откройте «Не отправлено» вверху.')
      else notify('Расход удалён', { label: 'Вернуть', run: () => void restore(stored) })
    } catch (error) {
      setBootstrap((data) => ({ ...data, expenses: data.expenses.map((item) => item.id === target.id && item.version === target.version && item.deletedAt === deletedAt ? target : item) }))
      setCurrentId(target.id)
      notify(error instanceof ApiError ? error.message : 'Не удалось удалить', undefined, true)
    }
    refreshPending()
  }

  // Слева от текущей карточки лежит более старый расход, справа — более новый (или карточка нового расхода).
  const olderNeighbour = current ? activeExpenses[currentIndex + 1] : activeExpenses[0]
  const newerNeighbour = currentIndex > 0 ? activeExpenses[currentIndex - 1] : undefined
  const canMove = (direction: 'older' | 'newer') => direction === 'older' ? Boolean(olderNeighbour) : currentIndex >= 0

  // Лента едет за пальцем один к одному, поэтому соседняя карточка видна на всём пути.
  const slide = (dx: number, duration: number) => {
    const node = trackRef.current
    if (!node) return
    // Ширину читаем до записи стилей: чтение после записи заставляет браузер синхронно пересчитывать раскладку на каждом движении пальца.
    const span = node.clientWidth + CARD_GAP
    const easing = 'cubic-bezier(.25,.8,.3,1)'
    node.style.transition = duration ? `transform ${duration}ms ${easing}` : 'none'
    node.style.transform = dx ? `translateX(${dx}px)` : ''
    offset.current = dx

    const sourcePresence = current ? 1 : 0
    const direction = dx ? swipeDirection(dx) : null
    const targetPresence = !direction || !canMove(direction)
      ? sourcePresence
      : direction === 'older' || Boolean(newerNeighbour) ? 1 : 0
    const progress = Math.min(Math.abs(dx) / span, 1)
    setActionsPresence(sourcePresence + (targetPresence - sourcePresence) * progress, duration)
    const previewDirection = direction && canMove(direction) ? direction : null
    styleCrossfade(previewDirection ? progress : 0, duration)
    // Превью остаётся смонтированным при откате в ноль: его прозрачность уже уходит в 0, а размонтирование оборвало бы переход.
    const target = previewDirection ? previewFor(previewDirection) : null
    if (target) setSwipePreview((previous) => previous?.key === target.key ? previous : target)
  }

  const move = async (direction: 'older' | 'newer') => {
    if (!canMove(direction)) return
    const discarded = dirty
    if (dirty) {
      slide(0, prefersReducedMotion() ? 0 : 180)
      if (!await confirm({
        title: 'Перейти к другому расходу?',
        message: 'Несохранённые изменения будут потеряны. Сохраните их кнопкой ниже или подтвердите переход.',
        confirmLabel: 'Отбросить и перейти',
        danger: true,
      })) return
      draft.current = { ...EMPTY_FORM, currency: form.currency }
    }
    const target = direction === 'older' ? olderNeighbour : newerNeighbour ?? null
    if (!current && !discarded) draft.current = form
    const span = (trackRef.current?.clientWidth ?? 320) + CARD_GAP
    const destination = direction === 'older' ? span : -span
    const reduced = prefersReducedMotion()
    // Чем ближе карточка уже подтянута пальцем, тем короче доводка — быстрый флик не должен ощущаться вязким.
    const duration = reduced ? 0 : Math.min(300, Math.max(150, Math.abs(destination - offset.current) * 0.55))
    committing.current = true
    slide(destination, duration)
    clearTimeout(swapTimer.current)
    // Подмену делаем ровно в той точке, где соседняя карточка встала на место текущей: сдвиг снимет useLayoutEffect до отрисовки.
    swapTimer.current = setTimeout(() => { swapped.current = true; setCurrentId(target?.id ?? null) }, duration)
    tap(6)
  }

  const swipeStartAt = (clientX: number, clientY: number, touchId: number | null = null) => {
    // Пока лента доезжает до соседа, новый жест перехватывать нельзя: подмена карточки дёрнет её из-под пальца.
    if (committing.current || saving || categorySheet || currencySheet || dateSheet || noteSheet) return false
    swipe.current = { x: clientX, y: clientY, lastX: clientX, active: false, touchId }
    return true
  }

  const swipeMoveTo = (clientX: number, clientY: number) => {
    const start = swipe.current
    if (!start) return false
    const dx = clientX - start.x
    const dy = clientY - start.y
    start.lastX = clientX
    if (!start.active) {
      // Пока не ясно, горизонтальный это жест или что-то ещё, — не мешаем вертикальному скроллу и нажатию клавиши.
      if (Math.abs(dy) > SWIPE_START && Math.abs(dy) > Math.abs(dx)) { swipe.current = null; return false }
      if (Math.abs(dx) < SWIPE_START || Math.abs(dx) < Math.abs(dy) * 1.5) return false
      start.active = true
    }
    // В тупике (дальше расходов нет) лента почти не поддаётся — это и есть подсказка.
    slide(canMove(swipeDirection(dx)) ? dx : Math.max(-26, Math.min(26, dx * 0.2)), 0)
    return true
  }

  const swipeEndAt = (clientX: number) => {
    const start = swipe.current
    swipe.current = null
    if (!start?.active) return false
    const dx = clientX - start.x
    if (Math.abs(dx) > SWIPE_COMMIT && canMove(swipeDirection(dx))) void move(swipeDirection(dx))
    else slide(0, prefersReducedMotion() ? 0 : 220)
    return true
  }

  const swipeCancelAt = () => {
    const start = swipe.current
    swipe.current = null
    if (!start?.active) return
    // pointercancel/touchcancel means the browser interrupted the gesture
    // (for example for system navigation), so it must never commit a move.
    slide(0, prefersReducedMotion() ? 0 : 220)
  }

  const usesNativeTouch = () => 'ontouchstart' in window

  // Ряд «Дополнительно» листается сам по горизонтали: жест внутри него не должен переключать расходы.
  const insideTagStrip = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest('.tag-strip'))
  const swipeStart = (event: React.PointerEvent) => {
    if (event.pointerType === 'touch' && usesNativeTouch()) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (insideTagStrip(event.target)) return
    swipeStartAt(event.clientX, event.clientY)
  }

  const swipeMove = (event: React.PointerEvent) => {
    if (event.pointerType === 'touch' && usesNativeTouch()) return
    swipeMoveTo(event.clientX, event.clientY)
  }

  const swipeEnd = (event: React.PointerEvent) => {
    if (event.pointerType === 'touch' && usesNativeTouch()) {
      // touchend завершит жест следом; здесь нужно лишь не пропустить pointerup до нажатой клавиши.
      if (suppressTouchPointerUp.current || swipe.current?.active) event.stopPropagation()
      return
    }
    if (!swipe.current?.active) { swipe.current = null; return }
    // Capture-фаза секции срабатывает раньше pointerup клавиши и не даёт свайпу случайно ввести цифру.
    event.stopPropagation()
    swipeEndAt(event.clientX)
  }

  const swipeCancel = (event: React.PointerEvent) => {
    if (event.pointerType === 'touch' && usesNativeTouch()) return
    swipeCancelAt()
  }

  // Слушатели ставятся один раз на всё время жизни экрана: перевешивать четыре touch-обработчика на каждый
  // рендер (а рендеры идут и во время жеста) — лишняя работа посреди свайпа. Актуальные замыкания берём из рефа.
  const touchHandlers = useRef({ swipeStartAt, swipeMoveTo, swipeEndAt, swipeCancelAt })
  touchHandlers.current = { swipeStartAt, swipeMoveTo, swipeEndAt, swipeCancelAt }
  useEffect(() => {
    const node = entryRef.current
    if (!node || !usesNativeTouch()) return
    // Пока палец на экране расхода, лента вкладок не прокручивается сама: ни от края экрана, ни «перетеканием»
    // из полосы тегов. Вкладки с этого экрана и так переключаются только кнопками внизу.
    const pagerNode = node.closest<HTMLElement>('.pager')
    const lockPager = (locked: boolean) => { if (pagerNode) pagerNode.style.overflowX = locked ? 'hidden' : '' }
    const findTouch = (touches: TouchList, identifier: number) => Array.from(touches).find((touch) => touch.identifier === identifier)
    const touchStart = (event: TouchEvent) => {
      lockPager(true)
      suppressTouchPointerUp.current = false
      if (event.touches.length !== 1 || insideTagStrip(event.target)) { swipe.current = null; return }
      const touch = event.touches[0]
      if (touch) touchHandlers.current.swipeStartAt(touch.clientX, touch.clientY, touch.identifier)
    }
    const touchMove = (event: TouchEvent) => {
      const start = swipe.current
      if (!start || start.touchId === null) return
      const touch = findTouch(event.touches, start.touchId)
      if (touch && touchHandlers.current.swipeMoveTo(touch.clientX, touch.clientY)) {
        suppressTouchPointerUp.current = true
        event.preventDefault()
      }
    }
    const touchEnd = (event: TouchEvent) => {
      if (event.touches.length === 0) lockPager(false)
      const start = swipe.current
      if (!start || start.touchId === null) return
      const touch = findTouch(event.changedTouches, start.touchId)
      if (touch) touchHandlers.current.swipeEndAt(touch.clientX)
      setTimeout(() => { suppressTouchPointerUp.current = false }, 0)
    }
    const touchCancel = (event: TouchEvent) => {
      if (event.touches.length === 0) lockPager(false)
      touchHandlers.current.swipeCancelAt()
      setTimeout(() => { suppressTouchPointerUp.current = false }, 0)
    }
    node.addEventListener('touchstart', touchStart, { passive: true })
    node.addEventListener('touchmove', touchMove, { passive: false })
    node.addEventListener('touchend', touchEnd, { passive: true })
    node.addEventListener('touchcancel', touchCancel, { passive: true })
    return () => {
      lockPager(false)
      node.removeEventListener('touchstart', touchStart)
      node.removeEventListener('touchmove', touchMove)
      node.removeEventListener('touchend', touchEnd)
      node.removeEventListener('touchcancel', touchCancel)
    }
  }, [])

  const occurredLabel = formatEntryDate(form.occurredAt) || formatEntryDate(isoToLocalInput(new Date().toISOString()))
  const faceOf = (expense: Expense): CardFace => {
    const data = inputFromExpense(expense, bootstrap.currencies)
    return { kind: 'edit', title: 'Редактирование', date: formatEntryDate(data.occurredAt), amount: data.amount, currency: data.currency }
  }
  const blankFace = (amount: string, currency: string): CardFace => ({ kind: 'new', title: 'Новый расход', date: formatEntryDate(isoToLocalInput(new Date().toISOString())), amount, currency })
  const liveFace: CardFace = current
    ? { kind: 'edit', title: 'Редактирование', date: occurredLabel, amount: form.amount, currency: form.currency }
    : { ...blankFace(form.amount, form.currency), date: occurredLabel }
  const olderFace = olderNeighbour ? faceOf(olderNeighbour) : null
  const newerFace = newerNeighbour ? faceOf(newerNeighbour)
    : currentIndex === 0 ? blankFace(draft.current.amount, draft.current.amount ? draft.current.currency : getWorkspacePreference(userId, workspaceId, 'last-currency') || 'RSD')
    : null
  const main = bootstrap.categories.filter((item) => !item.archivedAt && item.placement === 'main').sort((a,b) => a.sortOrder-b.sortOrder)
  const additional = bootstrap.categories.filter((item) => !item.archivedAt && item.placement === 'additional').sort((a,b) => a.sortOrder-b.sortOrder)
  const selectedCategoryId = form.categoryId || null
  const dirty = current ? JSON.stringify(form) !== JSON.stringify(inputFromExpense(current, bootstrap.currencies)) : formHasContent(form)
  const save = saveButtonLabel({ amount: form.amount, currency: form.currency, categoryId: selectedCategoryId, editing: Boolean(current), dirty, currencies: bootstrap.currencies })
  const usedCurrencies = useMemo(() => [...new Set(['RSD', ...bootstrap.expenses.filter((item) => !item.deletedAt).map((item) => item.currency)])], [bootstrap.expenses])
  const cancelEdit = () => {
    if (!current || saving) return
    const original = inputFromExpense(current, bootstrap.currencies)
    synced.current = { id: current.id, form: original }
    setForm(original)
  }
  useEffect(() => { onDraftDirtyChange(dirty) }, [dirty, onDraftDirtyChange])
  useEffect(() => () => onDraftDirtyChange(false), [onDraftDirtyChange])
  const previewFor = (direction: 'older' | 'newer'): LowerPreviewState | null => {
    const neighbour = direction === 'older' ? olderNeighbour : newerNeighbour
    if (direction === 'older' && !neighbour) return null
    if (neighbour) return { key: neighbour.id, categoryId: neighbour.categoryId, tagIds: neighbour.tagIds ?? [], note: neighbour.note ?? '', saveLabel: 'Сохранить', canSave: false }
    const blank = draft.current
    const blankSave = saveButtonLabel({ amount: blank.amount, currency: blank.currency, categoryId: blank.categoryId || null, editing: false, dirty: true, currencies: bootstrap.currencies })
    return { key: 'blank', categoryId: blank.categoryId || null, tagIds: blank.tagIds, note: blank.note, saveLabel: blankSave.label, canSave: blankSave.canSave }
  }
  const physicalKey = (event: KeyboardEvent) => {
    if (saving) return
    if(event.metaKey||event.ctrlKey||event.altKey)return
    if(document.querySelector('[aria-modal="true"]'))return
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return
    const value = /^\d$/.test(event.key) ? event.key : event.key === 'Backspace' ? '⌫' : event.key === '.' || event.key === ',' ? ',' : null
    if (!value) return
    event.preventDefault()
    key(value)
  }
  useEffect(()=>{
    if(!active)return
    const handle=(event:KeyboardEvent)=>physicalKey(event)
    window.addEventListener('keydown',handle)
    return()=>window.removeEventListener('keydown',handle)
  },[active,physicalKey])
  const publishTag = (tag: Tag) => setBootstrap((data) => ({ ...data, tags: [tag, ...(data.tags ?? []).filter((item) => item.id !== tag.id)] }))
  return <section ref={entryRef} className={`entry-view${current ? ' editing' : ''}${saving ? ' saving' : ''}`} aria-label="Ввод суммы" onPointerDown={swipeStart} onPointerMove={swipeMove} onPointerUpCapture={swipeEnd} onPointerCancel={swipeCancel}>
    <div className="swipe-area">
      <div className="entry-track" ref={trackRef}>
        {olderFace && <div className="entry-card aside older" aria-hidden="true"><EntryCard face={olderFace}/></div>}
        <div className="entry-card"><EntryCard face={liveFace} disabled={saving} limitHit={limitHit} onDate={() => setDateSheet(true)} onCurrency={() => setCurrencySheet(true)}/></div>
        {newerFace && <div className="entry-card aside newer" aria-hidden="true"><EntryCard face={newerFace}/></div>}
      </div>
    </div>
    <div ref={actionsRef} className="entry-actions" style={ENTRY_ACTIONS_HIDDEN} inert={!current} aria-hidden={!current}>
      <button type="button" className="icon-danger entry-delete" disabled={saving || !current} onClick={() => void remove()} aria-label="Удалить расход"><TrashIcon/></button>
    </div>
    <Keypad onKey={key} disabled={saving}/>
    <div className="entry-lower">
    <div ref={lowerLiveRef} className="entry-lower-live">
    <CategoryTiles main={main} additional={additional} selectedId={selectedCategoryId} disabled={saving} onPick={chooseCategory} onMore={() => setCategorySheet(true)}/>
    <ExtrasRow tags={bootstrap.tags ?? []} selected={form.tagIds} note={form.note} disabled={saving} online={navigator.onLine} onChange={(tagIds) => setForm((value) => ({ ...value, tagIds }))} onNote={() => setNoteSheet(true)} onCreate={(name) => createTagOrReuse(workspaceId, name, TAG_COLORS[(bootstrap.tags ?? []).length % TAG_COLORS.length] ?? null, publishTag)}/>
    <div className="entry-save"><button type="button" className="primary" disabled={!save.canSave || saving} onClick={() => void submitExpense()}>{saving ? 'Сохраняем…' : save.label}</button>{current && <button type="button" className={`sheet-cancel${dirty && !saving ? '' : ' ghost'}`} disabled={!dirty || saving} aria-hidden={!dirty || saving} tabIndex={dirty && !saving ? undefined : -1} onClick={cancelEdit}>Отменить</button>}</div>
    </div>
    {swipePreview && <div ref={lowerPreviewRef} className="entry-lower-preview" aria-hidden="true" inert><EntryLowerPreview main={main} additional={additional} tags={bootstrap.tags ?? []} state={swipePreview}/></div>}
    </div>
    {dateSheet && <DateSheet value={form.occurredAt} onClose={() => setDateSheet(false)} onPick={(value) => { setForm({ ...form, occurredAt: value }); setDateSheet(false) }}/>}
    {categorySheet && <CategorySheet categories={additional} selectedId={selectedCategoryId ?? undefined} onClose={() => setCategorySheet(false)} onPick={chooseCategory}/>}
    {noteSheet && <NoteSheet value={form.note} onClose={() => setNoteSheet(false)} onSave={(note) => { setForm({ ...form, note }); setNoteSheet(false) }}/>}
    {currencySheet && <CurrencySheet
      currencies={bootstrap.currencies}
      used={usedCurrencies}
      selected={form.currency}
      onClose={() => setCurrencySheet(false)}
      onSelect={(currency) => {
        setForm({...form,currency})
        setWorkspacePreference(userId, workspaceId, 'last-currency', currency)
        setCurrencySheet(false)
      }}
    />}
    {toast && <Toast toast={toast} onDismiss={dismiss}/>}
    {confirmation}
  </section>
}
