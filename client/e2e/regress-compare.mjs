// Сравнение двух прогонов: node regress-compare.mjs <a> <b> [набор] [--soft]
//   regress (по умолчанию) — попиксельно .shots/regress-<a>/ и regress-<b>/, строго: pixelmatch с порогом 0 и
//     includeAA, то есть отличается любой пиксель с любым сдвигом цвета, сглаживание краёв тоже. На каждый снимок —
//     число отличающихся пикселей, а у ненулевых ещё рамка отличий и самый большой сдвиг канала (1–3 из 255 —
//     растеризация: слой, сглаживание текста; десятки — видимое отличие). Картинки отличий (красным поверх
//     бледного снимка a) — в .shots/compare-regress-<a>-<b>/. Снимки, которых нет в одном из прогонов, — отличие.
//     --soft — прежний мягкий режим: порог 0.1 и без пикселей сглаживания (pixelmatch считает их шумом).
//     Журнал log.json сравнивается по ключам: высота прокрутки «Истории» (historyLength.*.scrollHeight) — с допуском
//     в одну строку списка (70 px), число нарисованных строк, отступ под ненарисованные и время дорисовки — только
//     для сведения (у ревизий с порциями и без них они разные по устройству), остальное — точно.
//     Код выхода 1, если отличается хоть один снимок или ключ журнала сверх допуска.
//   row-swipe или cards — сводки фаз из row-swipe.json / cards.json рядом: кадры реального времени между прогонами
//     плавают на кадр, поэтому сравниваются числа, а не пиксели.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
const args = process.argv.slice(2)
const soft = args.includes('--soft')
const [a, b, set = 'regress'] = args.filter((arg) => !arg.startsWith('--'))
if (!a || !b) { console.log('node regress-compare.mjs <a> <b> [regress|row-swipe|cards] [--soft]'); process.exit(2) }
const shots = new URL('./.shots/', import.meta.url).pathname
const dirA = `${shots}${set}-${a}/`, dirB = `${shots}${set}-${b}/`
const flat = (value, prefix = '') => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.entries(value).flatMap(([key, item]) => flat(item, `${prefix}${prefix ? '.' : ''}${key}`))
  : [[prefix, JSON.stringify(value)]]
const journal = (dir, name) => existsSync(dir + name) ? JSON.parse(readFileSync(dir + name, 'utf8')) : null

if (set !== 'regress') {
  const left = journal(dirA, `${set}.json`), right = journal(dirB, `${set}.json`)
  if (!left || !right) { console.log(`нет ${set}.json в ${left ? dirB : dirA}`); process.exit(2) }
  const valuesA = new Map(flat(left.summary)), valuesB = new Map(flat(right.summary))
  for (const key of new Set([...valuesA.keys(), ...valuesB.keys()])) {
    const same = valuesA.get(key) === valuesB.get(key)
    console.log(`${same ? '  ' : '≠ '}${key}: ${valuesA.get(key) ?? '—'}${same ? '' : ` → ${valuesB.get(key) ?? '—'}`}`)
  }
  process.exit(0)
}

const options = soft ? { threshold: 0.1 } : { threshold: 0, includeAA: true }
const out = `${shots}compare-${set}-${a}-${b}/`
rmSync(out, { recursive: true, force: true })
const pngs = (dir) => readdirSync(dir).filter((f) => f.endsWith('.png')).sort()
const filesA = pngs(dirA), filesB = pngs(dirB)
let failed = false
const differing = []

// Рамка отличий и самый большой сдвиг канала — по сырым байтам, без порогов.
function spread(A, B) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, delta = 0
  for (let y = 0; y < A.height; y++) for (let x = 0; x < A.width; x++) {
    const i = (y * A.width + x) * 4
    const d = Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2]), Math.abs(A.data[i + 3] - B.data[i + 3]))
    if (!d) continue
    delta = Math.max(delta, d)
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y)
  }
  return { box: x1 < 0 ? null : `${x0},${y0}–${x1},${y1}`, delta }
}

for (const file of filesA) {
  if (!filesB.includes(file)) { console.log(`${file}: нет в ${b}`); failed = true; continue }
  const A = PNG.sync.read(readFileSync(dirA + file)), B = PNG.sync.read(readFileSync(dirB + file))
  if (A.width !== B.width || A.height !== B.height) { console.log(`${file}: размер ${A.width}x${A.height} против ${B.width}x${B.height}`); failed = true; continue }
  const diff = new PNG({ width: A.width, height: A.height })
  const n = pixelmatch(A.data, B.data, diff.data, A.width, A.height, options)
  if (!n) { console.log(`${file}: 0`); continue }
  const { box, delta } = spread(A, B)
  differing.push({ file, n, delta })
  failed = true
  mkdirSync(out, { recursive: true })
  writeFileSync(out + file, PNG.sync.write(diff))
  console.log(`${file}: ${n} (рамка ${box}, сдвиг канала до ${delta})`)
}
for (const file of filesB) if (!filesA.includes(file)) { console.log(`${file}: только в ${b}`); failed = true }

// Журнал прогона: всё, кроме метки и адреса.
const TOLERANCE = 70
const tolerant = (key) => /^historyLength\.[^.]+\.[^.]+\.scrollHeight$/.test(key)
const informational = (key) => /^historyLength\.[^.]+\.[^.]+\.(rows|rest|waitedMs|fillMs)$/.test(key) || /^historyEnd\.[^.]+\.passes$/.test(key)
const logA = journal(dirA, 'log.json'), logB = journal(dirB, 'log.json')
if (logA && logB) {
  const pick = (data) => Object.fromEntries(Object.entries(data).filter(([key]) => !['label', 'base'].includes(key)))
  const left = new Map(flat(pick(logA))), right = new Map(flat(pick(logB)))
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const valueA = left.get(key), valueB = right.get(key)
    if (tolerant(key) && valueA !== undefined && valueB !== undefined) {
      const gap = Math.abs(Number(valueA) - Number(valueB))
      const over = gap > TOLERANCE
      if (over) failed = true
      if (gap) console.log(`журнал ${over ? '≠' : '≈'} ${key}: ${valueA} → ${valueB} (${gap} px, допуск ${TOLERANCE})`)
    } else if (valueA !== valueB) {
      if (!informational(key)) failed = true
      console.log(`журнал ${informational(key) ? '·' : '≠'} ${key}: ${valueA ?? '—'} → ${valueB ?? '—'}`)
    }
  }
} else console.log(`журнала нет в ${logA ? b : a}`)

const mode = soft ? 'мягко (порог 0.1, без сглаживания)' : 'строго (порог 0, со сглаживанием)'
console.log(`${mode}: ${filesA.length} снимков, отличаются ${differing.length}${differing.length ? `, отличия — ${out}` : ''}`)
if (differing.length) console.log(`больше всего: ${[...differing].sort((x, y) => y.n - x.n).slice(0, 5).map((item) => `${item.file} ${item.n}`).join(', ')}`)
process.exitCode = failed ? 1 : 0
