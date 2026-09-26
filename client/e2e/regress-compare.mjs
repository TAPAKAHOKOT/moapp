// Сравнение двух прогонов: node regress-compare.mjs <a> <b> [набор]
//   regress (по умолчанию) — попиксельно .shots/regress-<a>/ и regress-<b>/: число отличающихся пикселей на снимок
//     (pixelmatch, порог 0.1), снимки, которых нет в одном из прогонов, картинки отличий (красным) в
//     .shots/compare-regress-<a>-<b>/ и расхождения log.json (ширина документа после «Настроек», конец «Истории», высота аналитики);
//   row-swipe или cards — сводки фаз из row-swipe.json / cards.json рядом: кадры реального времени между прогонами
//     плавают на кадр, поэтому сравниваются числа, а не пиксели.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
const [a, b, set = 'regress'] = process.argv.slice(2)
if (!a || !b) { console.log('node regress-compare.mjs <a> <b> [regress|row-swipe|cards]'); process.exit(2) }
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

const out = `${shots}compare-${set}-${a}-${b}/`
rmSync(out, { recursive: true, force: true })
const pngs = (dir) => readdirSync(dir).filter((f) => f.endsWith('.png')).sort()
const filesA = pngs(dirA), filesB = pngs(dirB)
let worst = 0, differing = 0
for (const file of filesA) {
  if (!filesB.includes(file)) { console.log(`${file}: missing in ${b}`); worst = Math.max(worst, 1e9); continue }
  const A = PNG.sync.read(readFileSync(dirA + file)), B = PNG.sync.read(readFileSync(dirB + file))
  if (A.width !== B.width || A.height !== B.height) { console.log(`${file}: size ${A.width}x${A.height} vs ${B.width}x${B.height}`); worst = Math.max(worst, 1e9); continue }
  const diff = new PNG({ width: A.width, height: A.height })
  const n = pixelmatch(A.data, B.data, diff.data, A.width, A.height, { threshold: 0.1 })
  worst = Math.max(worst, n)
  if (n) { differing++; mkdirSync(out, { recursive: true }); writeFileSync(out + file, PNG.sync.write(diff)) }
  console.log(`${file}: ${n}`)
}
for (const file of filesB) if (!filesA.includes(file)) console.log(`${file}: only in ${b}`)

// Журнал прогона: всё, кроме метки и адреса.
const logA = journal(dirA, 'log.json'), logB = journal(dirB, 'log.json')
if (logA && logB) {
  const pick = (data) => Object.fromEntries(Object.entries(data).filter(([key]) => !['label', 'base'].includes(key)))
  const left = new Map(flat(pick(logA))), right = new Map(flat(pick(logB)))
  for (const key of new Set([...left.keys(), ...right.keys()])) if (left.get(key) !== right.get(key)) console.log(`журнал ${key}: ${left.get(key) ?? '—'} → ${right.get(key) ?? '—'}`)
}
console.log(`${filesA.length} снимков, отличаются ${differing}${differing ? `, отличия — ${out}` : ''}`)
console.log('worst', worst)
