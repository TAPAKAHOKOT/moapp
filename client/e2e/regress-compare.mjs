import { readdirSync, readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
const [a, b] = process.argv.slice(2)
const dirA = new URL(`./.shots/regress-${a}/`, import.meta.url).pathname, dirB = new URL(`./.shots/regress-${b}/`, import.meta.url).pathname
let worst = 0
for (const file of readdirSync(dirA).filter((f) => f.endsWith('.png')).sort()) {
  const A = PNG.sync.read(readFileSync(dirA + file)); let B
  try { B = PNG.sync.read(readFileSync(dirB + file)) } catch { console.log(`${file}: missing in ${b}`); continue }
  if (A.width !== B.width || A.height !== B.height) { console.log(`${file}: size ${A.width}x${A.height} vs ${B.width}x${B.height}`); worst = Math.max(worst, 1e9); continue }
  const n = pixelmatch(A.data, B.data, null, A.width, A.height, { threshold: 0.1 })
  worst = Math.max(worst, n)
  console.log(`${file}: ${n}`)
}
console.log('worst', worst)
