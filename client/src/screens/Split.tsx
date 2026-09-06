import { useState } from 'react'
import type { Currency } from '../types'
import { amountNumber, pluralRu } from '../format'
import { amountToMinor, formatAmountInput } from '../utils'
import { tap, useDialog } from '../ui'

// Столько же частей принимает сервер (MAX_EXPENSE_PARTS): дальше это уже отдельные записи, а не деление платежа.
export const MAX_PARTS = 10

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
  const [amounts, setAmounts] = useState<string[]>(() => ['', ''])
  const dialogRef = useDialog(onClose, !busy)
  const decimals = currencies.find((item) => item.code === currency)?.decimals ?? 2
  const draft = splitDraft(amounts, totalMinor, currency, currencies)
  const change = (index: number, amount: string) => setAmounts((value) => value.map((item, position) => (position === index ? amount : item)))
  const addRow = () => { tap(6); setAmounts((value) => [...value.slice(0, -1), '', value[value.length - 1]!]) }
  const removeRow = (index: number) => { tap(5); setAmounts((value) => value.filter((_, position) => position !== index)) }
  const hint = draft.remainder < 0 ? `Части больше платежа на ${amountNumber(-draft.remainder, currency, currencies)} ${currency}`
    : draft.remainder === 0 ? 'На последнюю часть ничего не осталось'
    : !draft.valid ? 'Укажите суммы частей — последняя посчитается сама'
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
      <ol className="split-rows">
        {amounts.map((amount, index) => {
          const last = index === amounts.length - 1
          return <li key={index} className={last ? 'split-row remainder' : 'split-row'}>
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
                  value={formatAmountInput(amount)}
                  onChange={(event) => change(index, sanitizeAmount(event.target.value, decimals))}
                />}
            {!last && amounts.length > 2 && <button type="button" className="icon-button split-remove" disabled={busy} onClick={() => removeRow(index)} aria-label={`Убрать часть ${index + 1}`}>×</button>}
          </li>
        })}
      </ol>
      {amounts.length < MAX_PARTS && draft.remainder > 0 && <button type="button" className="split-add" disabled={busy} onClick={addRow}>Ещё часть</button>}
      {(hint || error) && <p className={error ? 'form-error' : 'split-hint'} role={error ? 'alert' : 'status'}>{error || hint}</p>}
      <button className="primary" disabled={!draft.canSave || busy}>{busy ? 'Делим…' : `Разделить на ${amounts.length} ${pluralRu(amounts.length, ['часть', 'части', 'частей'])}`}</button>
    </form>
  </div>
}
