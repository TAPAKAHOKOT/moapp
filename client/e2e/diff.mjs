import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
const dir = new URL('./.shots/swipe-webkit/', import.meta.url).pathname
const load = (f) => PNG.sync.read(readFileSync(dir + f))
for (const run of ['to-older', 'back-to-blank', 'deadend-left']) {
  const out = []
  for (let i = 1; i < 40; i++) {
    const a = load(`${run}-${String(i - 1).padStart(2, '0')}.png`), b = load(`${run}-${String(i).padStart(2, '0')}.png`)
    const n = pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.1 })
    if (n > 0) out.push(`${i - 1}→${i}: ${n}`)
  }
  console.log(run, out.join('  '))
}
