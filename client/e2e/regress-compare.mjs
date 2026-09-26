// Попиксельное сравнение двух прогонов: node regress-compare.mjs <a> <b> [набор]
//   набор — regress (по умолчанию), row-swipe или cards: каталоги .shots/<набор>-<a>/ и .shots/<набор>-<b>/.
// Печатает число отличающихся пикселей на снимок (pixelmatch, порог 0.1), снимки, которых нет в одном из прогонов, и
// расхождения журналов: у regress — log.json (ширина документа после «Настроек», конец «Истории», высота аналитики),
// у покадровых — сводки фаз. Картинки отличий (отличающиеся пиксели красным) — в .shots/compare-<набор>-<a>-<b>/.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
const [a, b, set = 'regress'] = process.argv.slice(2)
if (!a || !b) { console.log('node regress-compare.mjs <a> <b> [regress|row-swipe|cards]'); process.exit(2) }
const shots = new URL('./.shots/', import.meta.url).pathname
const dirA = `${shots}${set}-${a}/`, dirB = `${shots}${set}-${b}/`
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

// Журналы: всё, кроме метки и адреса; у покадровых — только сводки (сырые кадры реального времени дрожат на миллисекунды).
const journal = (dir) => [`log.json`, `${set}.json`].map((name) => dir + name).filter(existsSync).map((path) => JSON.parse(readFileSync(path, 'utf8')))[0]
const flat = (value, prefix = '') => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.entries(value).flatMap(([key, item]) => flat(item, `${prefix}${prefix ? '.' : ''}${key}`))
  : [[prefix, JSON.stringify(value)]]
const journalA = journal(dirA), journalB = journal(dirB)
if (journalA && journalB) {
  const pick = (data) => data.summary ?? Object.fromEntries(Object.entries(data).filter(([key]) => !['label', 'base'].includes(key)))
  const left = new Map(flat(pick(journalA))), right = new Map(flat(pick(journalB)))
  for (const key of new Set([...left.keys(), ...right.keys()])) if (left.get(key) !== right.get(key)) console.log(`журнал ${key}: ${left.get(key) ?? '—'} → ${right.get(key) ?? '—'}`)
}
console.log(`${filesA.length} снимков, отличаются ${differing}${differing ? `, отличия — ${out}` : ''}`)
console.log('worst', worst)
