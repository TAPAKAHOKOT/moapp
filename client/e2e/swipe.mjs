import { mkdirSync, existsSync } from 'node:fs'
import { launch, openApp, acceptDeviceLink, SHOTS, sleep, touchDrag } from './common.mjs'

// Frame-capture the entry swipe from the blank card in both directions and log DOM state per frame.
const link = process.argv.find((arg) => arg.includes('#/device/'))
const kind = process.argv.slice(2).find((arg) => arg === 'chromium') ?? 'webkit'
const dir = `${SHOTS}swipe-${kind}/`
mkdirSync(dir, { recursive: true })
const { browser, context, page, statePath } = await launch(kind)
if (link) await acceptDeviceLink(page, context, statePath, link)
await openApp(page)

const snapshot = () => page.evaluate(() => {
  const track = document.querySelector('.entry-track')
  const pager = document.querySelector('.pager')
  const live = document.querySelector('.entry-card:not(.aside)')
  const asides = [...document.querySelectorAll('.entry-card.aside')].map((a) => `${a.className.replace('entry-card aside ', '')}:${a.querySelector('.eyebrow')?.textContent}/${a.querySelector('.amount-value')?.textContent}`)
  return {
    transform: track?.style.transform || '(none)',
    transition: track?.style.transition || '(none)',
    pagerScroll: pager?.scrollLeft,
    liveTitle: live?.querySelector('.eyebrow')?.textContent,
    liveAmount: live?.querySelector('.amount-value')?.textContent,
    asides,
    preview: Boolean(document.querySelector('.entry-lower-preview')),
    previewOpacity: document.querySelector('.entry-lower-preview')?.style.opacity,
    actions: document.querySelector('.entry-actions')?.style.opacity,
    editing: document.querySelector('.entry-view')?.classList.contains('editing'),
  }
})

async function run(name, from, to, opts) {
  console.log(`\n=== ${name} ===`)
  console.log('before', JSON.stringify(await snapshot()))
  const drag = touchDrag(page, '.swipe-area', from, to, opts)
  const frames = []
  for (let i = 0; i < 40; i++) {
    frames.push(await snapshot())
    await page.screenshot({ path: `${dir}${name}-${String(i).padStart(2, '0')}.png`, clip: { x: 0, y: 48, width: 393, height: 200 } })
    await sleep(25)
  }
  await drag
  await sleep(500)
  console.log('after', JSON.stringify(await snapshot()))
  let previous = ''
  frames.forEach((f, i) => { const s = JSON.stringify(f); if (s !== previous) { console.log(i, s); previous = s } })
}

// Dead end: finger moves right-to-left (dx<0) from the blank card, nothing newer exists.
await run('deadend-left', { x: 300, y: 150 }, { x: 60, y: 150 }, { steps: 10, stepDelay: 30 })
// Valid: finger moves left-to-right (dx>0) into the newest saved expense.
await run('to-older', { x: 60, y: 150 }, { x: 330, y: 150 }, { steps: 10, stepDelay: 30 })
// From the newest expense, back to the blank card (dx<0).
await run('back-to-blank', { x: 330, y: 150 }, { x: 40, y: 150 }, { steps: 10, stepDelay: 30 })
// Quick double flick: two gestures in a row before the first settles.
console.log('\n=== double flick ===')
console.log('before', JSON.stringify(await snapshot()))
await touchDrag(page, '.swipe-area', { x: 60, y: 150 }, { x: 330, y: 150 }, { steps: 6, stepDelay: 10 })
await sleep(60)
await touchDrag(page, '.swipe-area', { x: 60, y: 150 }, { x: 330, y: 150 }, { steps: 6, stepDelay: 10 })
for (let i = 0; i < 12; i++) { console.log(i, JSON.stringify(await snapshot())); await sleep(60) }
await sleep(600)
console.log('after', JSON.stringify(await snapshot()))
await browser.close()
