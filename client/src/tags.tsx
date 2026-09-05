import { useId, useLayoutEffect, useRef, useState } from 'react'
import { WorkspaceApiError as ApiError, createTag } from './workspace-api'
import type { Tag } from './types'
import { CheckIcon, tap, useConfirm, useDialog, useOverflowHint } from './ui'
import { pluralRu } from './format'

export const MAX_EXPENSE_TAGS = 20

// Тег — короткая плашка поверх категории. Один расход может нести несколько тегов, любой тег подходит любой категории.
export function TagChip({ name, color = null, selected = false, onToggle, disabled = false, inert = false }: { name: string; color?: string | null; selected?: boolean; onToggle?: () => void; disabled?: boolean; inert?: boolean }) {
  if (!onToggle) return <span className="tag-chip" style={tagStyle({ color })}>{name}</span>
  return <button type="button" className="tag-chip" style={tagStyle({ color })} aria-pressed={selected} disabled={disabled} tabIndex={inert ? -1 : undefined} onClick={onToggle}>{name}</button>
}

export const TAG_COLORS = ['#819978', '#d98f70', '#d2ad62', '#7d9db4', '#aa8aaf', '#797d72']

export const TAG_COLOR_NAMES = ['шалфейный', 'терракотовый', 'песочный', 'голубой', 'сиреневый', 'графитовый']

// Порядок тегов задаёт пользователь в настройках: полоса выбора и плашки в истории следуют ему.
export function sortTags(tags: Tag[]) {
  return [...tags].sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, 'ru-RU'))
}

export function tagStyle(tag: Pick<Tag, 'color'>) {
  return tag.color ? { '--tag': tag.color } as React.CSSProperties : undefined
}

// Сколько тегов лежит на самом экране расхода до чипа «Ещё N». Выбранные видны всегда.
export const VISIBLE_TAGS = 5

// Ряд под категориями: заметка первой и всегда на месте, дальше теги как категории — по порядку из настроек,
// остальные за «Ещё N». Полный список с поиском и созданием — в шите.
export function ExtrasRow({ tags, selected, note, onChange, onNote, onCreate, disabled = false, online = true, inert = false }: { tags: Tag[]; selected: string[]; note: string; onChange: (ids: string[]) => void; onNote: () => void; onCreate?: (name: string) => Promise<Tag | null>; disabled?: boolean; online?: boolean; inert?: boolean }) {
  const [open, setOpen] = useState(false)
  const stripRef = useRef<HTMLDivElement>(null)
  const sorted = sortTags(tags)
  // Порядок стабилен: выбранный чип не переезжает под пальцем в начало, а тег из хвоста списка встаёт в конец ряда.
  const shown = sorted.filter((tag, index) => index < VISIBLE_TAGS || selected.includes(tag.id))
  const hidden = sorted.length - shown.length
  const tabIndex = inert ? -1 : undefined
  const more = useOverflowHint(stripRef)
  // Полоса тегов — единственное место экрана ввода, где разрешён горизонтальный пан. Пока чипам хватает ширины, ей
  // нечего листать, и браузер отдавал жест пейджеру вкладок: страница отъезжала и возвращалась. Без переполнения пан запрещён.
  useLayoutEffect(() => {
    const node = stripRef.current
    if (!node) return
    const update = () => { const next = node.scrollWidth > node.clientWidth + 1 ? 'pan-x' : 'pan-y'; if (node.style.touchAction !== next) node.style.touchAction = next }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  })
  const toggle = (id: string) => {
    tap(4)
    if (selected.includes(id)) onChange(selected.filter((item) => item !== id))
    else if (selected.length < MAX_EXPENSE_TAGS) onChange([...selected, id])
  }
  // Шторка рендерится рядом с рядом, а не внутри него: iOS Safari удерживает position:fixed внутри прокручиваемого
  // контейнера, и подложка оказывалась обрезанной полосой и под футером.
  return <>
    <div className={`extras-row${more ? ' more' : ''}`} role="group" aria-label="Заметка и теги">
      <button type="button" className={`tag-add extra-add extra-note${note ? ' filled' : ''}`} disabled={disabled} tabIndex={tabIndex} onClick={onNote} aria-label={note ? `Заметка: ${note}` : 'Добавить заметку'}>{note ? `✎ ${note}` : '＋ Заметка'}</button>
      <div className="tag-strip" ref={stripRef} role="group" aria-label="Теги">
        {shown.map((tag) => <TagChip key={tag.id} name={tag.name} color={tag.color} selected={selected.includes(tag.id)} disabled={disabled} inert={inert} onToggle={() => toggle(tag.id)}/>)}
        <button type="button" className="tag-add extra-add" disabled={disabled} tabIndex={tabIndex} onClick={() => setOpen(true)} aria-label={hidden ? `Ещё ${hidden} ${pluralRu(hidden, ['тег', 'тега', 'тегов'])}, все теги` : tags.length ? 'Все теги' : 'Добавить тег'}>{hidden ? `Ещё ${hidden}` : '＋ Тег'}</button>
      </div>
    </div>
    {open && <TagSheet tags={tags} selected={selected} online={online} onClose={() => setOpen(false)} onChange={onChange} onCreate={onCreate}/>}
  </>
}

// Заметка правится в шите: поле на самом экране меняло высоту и уводило раскладку под клавиатуру.
export function NoteSheet({ value, onClose, onSave }: { value: string; onClose: () => void; onSave: (note: string) => void }) {
  const [draft, setDraft] = useState(value)
  const dialogRef = useDialog(onClose)
  return <div className="sheet-backdrop" onMouseDown={onClose}>
    <form ref={dialogRef as React.Ref<HTMLFormElement>} className="bottom-sheet editor note-sheet" role="dialog" aria-modal="true" aria-labelledby="note-title" noValidate onSubmit={(event) => { event.preventDefault(); onSave(draft.trim()) }} onMouseDown={(event) => event.stopPropagation()}>
      <div className="sheet-handle"/>
      <div className="sheet-title"><h2 id="note-title">Заметка</h2><button type="button" className="icon-button" onClick={onClose} aria-label="Закрыть">×</button></div>
      <label>Заметка<input data-dialog-initial-focus maxLength={200} placeholder="Например, IKEA" value={draft} onChange={(event) => setDraft(event.target.value)}/></label>
      <button className="primary">Готово</button>
      {value && <button type="button" className="danger-link" onClick={() => onSave('')}>Убрать заметку</button>}
    </form>
  </div>
}

export function TagSheet({ tags, selected, online, onClose, onChange, onCreate }: { tags: Tag[]; selected: string[]; online: boolean; onClose: () => void; onChange: (ids: string[]) => void; onCreate?: (name: string) => Promise<Tag | null> }) {
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dialogRef = useDialog(onClose, !busy)
  const titleId = useId()
  const normalized = query.trim().toLowerCase()
  const sorted = sortTags(tags)
  const filtered = normalized ? sorted.filter((tag) => tag.name.toLowerCase().includes(normalized)) : sorted
  const exact = tags.find((tag) => tag.name.toLowerCase() === normalized)
  const canCreate = Boolean(onCreate) && normalized.length > 0 && !exact
  const toggle = (id: string) => {
    if (selected.includes(id)) onChange(selected.filter((item) => item !== id))
    else if (selected.length < MAX_EXPENSE_TAGS) onChange([...selected, id])
  }
  const create = async () => {
    if (!onCreate || !canCreate || busy || !online) return
    setBusy(true); setError('')
    try {
      const tag = await onCreate(query.trim())
      if (tag) { if (!selected.includes(tag.id) && selected.length < MAX_EXPENSE_TAGS) onChange([...selected, tag.id]); setQuery('') }
    } catch (reason) { setError(reason instanceof ApiError ? reason.message : 'Не удалось создать тег') }
    finally { setBusy(false) }
  }
  return <div className="sheet-backdrop" onMouseDown={() => { if (!busy) onClose() }}>
    <section ref={dialogRef} className="bottom-sheet tall select-sheet tag-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(event) => event.stopPropagation()}>
      <div className="sheet-handle"/><div className="sheet-title"><h2 id={titleId}>Теги</h2><button type="button" className="icon-button" data-dialog-initial-focus onClick={onClose} aria-label="Закрыть">×</button></div>
      <input className="search" type="search" maxLength={30} placeholder={onCreate ? 'Найти или создать тег' : 'Найти тег'} aria-label="Поиск тега" value={query} disabled={busy} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key !== 'Enter') return; event.preventDefault(); if (canCreate) void create(); else if (exact) toggle(exact.id) }}/>
      {canCreate && <button type="button" className="tag-create" disabled={busy || !online} onClick={() => void create()}>{busy ? 'Создаём…' : `Создать тег «${query.trim()}»`}</button>}
      {canCreate && !online && <p className="sheet-empty" role="status">Новые теги создаются только онлайн.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="select-options" role="listbox" aria-label="Теги" aria-multiselectable="true">{filtered.map((tag) => { const active = selected.includes(tag.id); return <button type="button" role="option" key={tag.id} aria-selected={active} className="select-option" onClick={() => toggle(tag.id)}><span><i className="tag-dot" style={tagStyle(tag)}/><b>{tag.name}</b></span>{active && <CheckIcon/>}</button> })}</div>
      {!tags.length && !normalized && <p className="sheet-empty" role="status">Тегов пока нет. Введите название, чтобы создать первый.</p>}
      <button type="button" className="primary sheet-done" onClick={onClose}>Готово</button>
    </section>
  </div>
}

export function TagEditor({ tag, onClose, onSave, onDelete }: { tag: Tag | null; onClose: () => void; onSave: (name: string, color: string | null) => Promise<void>; onDelete?: () => Promise<void> }) {
  const [name, setName] = useState(tag?.name ?? '')
  const [color, setColor] = useState<string | null>(tag ? tag.color : TAG_COLORS[0]!)
  const [busy, setBusy] = useState(false)
  const [validation, setValidation] = useState('')
  const { confirm, confirmation } = useConfirm()
  const dialogRef = useDialog(onClose, !busy)
  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed) { setValidation('Введите название тега.'); return }
    setValidation(''); setBusy(true)
    try { await onSave(trimmed, color) } finally { setBusy(false) }
  }
  const remove = async () => {
    if (!onDelete || !await confirm({ title: 'Удалить тег?', message: 'Он исчезнет со всех расходов, сами расходы останутся.', confirmLabel: 'Удалить', danger: true })) return
    setBusy(true)
    try { await onDelete() } finally { setBusy(false) }
  }
  return <><div className="sheet-backdrop" onMouseDown={() => { if (!busy) onClose() }}><form ref={dialogRef as React.Ref<HTMLFormElement>} className="bottom-sheet editor tag-editor" role="dialog" aria-modal="true" aria-labelledby="tag-editor-title" noValidate onSubmit={(event) => { event.preventDefault(); void submit() }} onMouseDown={(event) => event.stopPropagation()}><div className="sheet-handle"/><div className="sheet-title"><h2 id="tag-editor-title">{tag ? 'Изменить тег' : 'Новый тег'}</h2><button type="button" className="icon-button" data-dialog-initial-focus disabled={busy} aria-label="Закрыть" onClick={onClose}>×</button></div><label>Название<input maxLength={30} aria-invalid={Boolean(validation)} value={name} onChange={(event) => { setValidation(''); setName(event.target.value) }}/></label>{validation && <p className="form-error" role="alert">{validation}</p>}<fieldset><legend>Цвет</legend><div className="colors">{TAG_COLORS.map((option, index) => <button type="button" key={option} aria-label={`Цвет: ${TAG_COLOR_NAMES[index] ?? option}`} aria-pressed={color === option} className={color === option ? 'selected' : ''} style={{ background: option }} onClick={() => setColor(option)}/>)}<button type="button" aria-label="Без цвета" aria-pressed={color === null} className={`colors-none${color === null ? ' selected' : ''}`} onClick={() => setColor(null)}>—</button></div></fieldset><button className="primary" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>{tag && onDelete && <button type="button" className="danger-link" disabled={busy} onClick={() => void remove()}>Удалить</button>}</form></div>{confirmation}</>
}

// Создание тега из любого экрана: дубликат имени не ошибка, а уже существующий тег.
export async function createTagOrReuse(workspaceId: string, name: string, color: string | null, publish: (tag: Tag) => void): Promise<Tag> {
  try {
    const tag = await createTag(workspaceId, { name, color })
    publish(tag)
    return tag
  } catch (error) {
    const current = error instanceof ApiError && error.code === 'DUPLICATE' ? (error.details as { current?: Tag } | undefined)?.current : undefined
    if (!current) throw error
    publish(current)
    return current
  }
}
