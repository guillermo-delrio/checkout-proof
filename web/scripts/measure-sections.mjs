// Section heights per page at a given width: where the phone page's length goes.
// usage: node web/scripts/measure-sections.mjs [--base http://localhost:8790] [--width 390]
import { browser, sleep } from './browser.mjs'
const args = process.argv.slice(2)
const BASE = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'http://localhost:8790'
const W = args.includes('--width') ? Number(args[args.indexOf('--width') + 1]) : 390
const PAGES = ['/', '/proof/expresscart', '/proof/simple-clothing-store']
const b = await browser({ width: W, height: 800 })
try {
  await b.send('Page.enable')
  for (const p of PAGES) {
    await b.send('Page.navigate', { url: BASE + p })
    await sleep(3000)
    const r = await b.evaluate(`return [document.documentElement.scrollHeight, [...document.querySelectorAll('main > *, #root > * > *, section')].filter((e) => e.tagName === 'SECTION' || e.parentElement.tagName === 'MAIN').map((e) => [e.id || (e.querySelector('h1,h2')?.textContent ?? e.className).slice(0, 40), Math.round(e.getBoundingClientRect().height)]).filter((x) => x[1] > 150)]`)
    console.log(`${W}px ${p}: ${r[0]}px`)
    for (const [n, h] of r[1]) console.log(`   ${String(h).padStart(6)}  ${n}`)
  }
} finally { b.close() }
