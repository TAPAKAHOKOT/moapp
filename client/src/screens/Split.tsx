import { useEffect, useRef, useState } from 'react'
import type { Currency } from '../types'
import { amountNumber, pluralRu } from '../format'
import { amountToMinor, formatAmountInput } from '../utils'
import { tap, useDialog } from '../ui'

// Столько же частей принимает сервер (MAX_EXPENSE_PARTS): дальше это уже отдельные записи, а не деление платежа.
export const MAX_PARTS = 10

// Второе нажатие в эти мгновения — продолжение того же тапа, а не выбор новой части.
const REPEAT_TAP_MS = 400

// Последняя часть всегда держит остаток: человек называет только те суммы, которые знает,
// а сдача считается сама — так деление никогда не расходится с суммой платежа.
export function splitDraft(amounts: string[], totalMinor: number, currency: string, currencies: Currency[]) {
  const minorOf = (amount: string) => {
    if (!amount) return 0
    try { const value = amountToMinor(amount, currency, currencies); return Number.isSafeInteger(value) ? value : Number.NaN }
    catch { return Number.NaN }
  }
  const named = amounts.slice(0, -1).map(minorOf)
  const assigned = named.reduce((total, amount) => total + (Number.isSafeInteger(amount) ? amount : 0), 0)
  const remainder = totalMinor - assigned
  const valid = named.every((amount) => Number.isSafeInteger(amount) && amount > 0)
  return { parts: [...named, remainder], remainder, valid, canSave: valid && remainder > 0 }
}

// В поле суммы допускаются только цифры и один разделитель: клавиатура телефона предлагает и минус, и пробелы.
export function sanitizeAmount(value: string, decimals: number) {
  const cleaned = value.replace(/[^\d.,]/g, '').replace(',', '.')
  const [whole = '', ...rest] = cleaned.split('.')
  const head = whole.slice(0, 12)
  if (!rest.length || !decimals) return head
  return `${head}.${rest.join('').slice(0, decimals)}`
}

/*
 * «Разделить» отвечает ровно на один вопрос — на какие суммы. Чем эти суммы были, спрашивается там,
 * где спрашивается всегда: у операции карты — на карточке разбора, у записи — на экране расхода.
 */
export function SplitSheet({ totalMinor, currency, currencies, busy = false, error = '', onClose, onSubmit }: {
  totalMinor: number
  currency: string
  currencies: Currency[]
  busy?: boolean
  error?: string
  onClose: () => void
  onSubmit: (amounts: number[]) => void
}) {
  const [rows, setRows] = useState<Array<{ id: number; amount: string }>>(() => [{ id: 0, amount: '' }, { id: 1, amount: '' }])
  const nextId = useRef(2)
  const rowsRef = useRef<HTMLOListElement>(null)
  /*
   * Шит прижат к низу экрана, а строки идут сверху, поэтому убранная часть двигала всё сразу:
   * шит уезжал вниз, оставшиеся строки — вверх. Второе нажатие приходило уже по соседнему крестику
   * или вовсе по «Закрыть», унося лишнюю часть или все набранные суммы. Поэтому список больше не
   * сжимается сразу: убранная строка оставляет за собой пустое место, и шит стоит там, где стоял,
   * пока палец не займётся чем-то другим — новой частью или суммой. А повторное нажатие в первые
   * мгновения не считается вовсе: это ещё тот же тап, а не выбор второй части.
   */
  const [heldHeight, setHeldHeight] = useState(0)
  const tapped = useRef(false)
  const forget = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(forget.current), [])
  const dialogRef = useDialog(onClose, !busy)
  const decimals = currencies.find((item) => item.code === currency)?.decimals ?? 2
  const draft = splitDraft(rows.map((row) => row.amount), totalMinor, currency, currencies)
  // Первая же цифра означает, что палец ушёл с крестиков: список можно отпустить и сжать.
  const change = (id: number, amount: string) => { setHeldHeight(0); setRows((value) => value.map((row) => (row.id === id ? { ...row, amount } : row))) }
  const addRow = () => { tap(6); setHeldHeight(0); setRows((value) => [...value.slice(0, -1), { id: nextId.current++, amount: '' }, value[value.length - 1]!]) }
  // Строка убирается по своему номеру, а не по месту в списке: перепутать соседа уже нечем.
  const removeRow = (id: number) => {
    if (tapped.current) return
    tapped.current = true
    clearTimeout(forget.current)
    forget.current = setTimeout(() => { tapped.current = false }, REPEAT_TAP_MS)
    setHeldHeight(rowsRef.current?.offsetHeight ?? 0)
    tap(5)
    setRows((value) => (value.length > 2 ? value.filter((row) => row.id !== id) : value))
  }
  // Подсказка говорит только о беде: остаток в строке и так виден, объяснять его словами нечего.
  const hint = draft.remainder < 0 ? `Части больше платежа на ${amountNumber(-draft.remainder, currency, currencies)} ${currency}`
    : draft.remainder === 0 ? 'На последнюю часть ничего не осталось'
    : ''
  return <div className="sheet-backdrop" onMouseDown={() => { if (!busy) onClose() }}>
    <form
      ref={dialogRef as React.Ref<HTMLFormElement>}
      className="bottom-sheet editor split-sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="split-title"
      noValidate
      onSubmit={(event) => { event.preventDefault(); if (draft.canSave && !busy) onSubmit(draft.parts) }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="sheet-handle"/>
      <div className="sheet-title">
        <h2 id="split-title">Разделить {amountNumber(totalMinor, currency, currencies)} {currency}</h2>
        <button type="button" className="icon-button" disabled={busy} onClick={onClose} aria-label="Закрыть">×</button>
      </div>
      <ol className="split-rows" ref={rowsRef} style={heldHeight ? { minHeight: heldHeight } : undefined}>
        {rows.map((row, index) => {
          const last = index === rows.length - 1
          return <li key={row.id} className={last ? 'split-row remainder' : 'split-row'}>
            <span className="split-ordinal" aria-hidden="true">{index + 1}</span>
            {last
              ? <span className="split-amount static">{draft.remainder > 0 ? amountNumber(draft.remainder, currency, currencies) : '—'}<small>остаток</small></span>
              : <input
                  className="split-amount"
                  inputMode="decimal"
                  autoComplete="off"
                  disabled={busy}
                  placeholder="0"
                  aria-label={`Сумма части ${index + 1}`}
                  {...(index === 0 ? { 'data-dialog-initial-focus': true } : {})}
                  value={formatAmountInput(row.amount)}
                  onChange={(event) => change(row.id, sanitizeAmount(event.target.value, decimals))}
                />}
            {!last && rows.length > 2 && <button type="button" className="icon-button split-remove" disabled={busy} onClick={() => removeRow(row.id)} aria-label={`Убрать часть ${index + 1}`}>×</button>}
          </li>
        })}
      </ol>
      {rows.length < MAX_PARTS && draft.remainder > 0 && <button type="button" className="split-add" disabled={busy} onClick={addRow}>Ещё часть</button>}
      {(hint || error) && <p className={error ? 'form-error' : 'split-hint'} role={error ? 'alert' : 'status'}>{error || hint}</p>}
      <button className="primary" disabled={!draft.canSave || busy}>{busy ? 'Делим…' : `Разделить на ${rows.length} ${pluralRu(rows.length, ['часть', 'части', 'частей'])}`}</button>
    </form>
  </div>
}
