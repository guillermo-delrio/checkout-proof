// Layout check, copied from venue-programmer/web/scripts (needs the server on :8790 with web/dist built, and chromium).
// Default: phone widths 360 and 390 px. `--widths 1366` (or any list) also shoots desktop. At 360 and 390 px
// with mobile emulation it fails if a page is wider than the screen, or if opening any <details> (evidence, research
// trail results) widens it, or if a page is over its height budget (home 6,000 px at 390 and 5,000 at desktop; evidence pages 9,000 at 390), and saves a screenshot of each page to out/phone-*.png for a look.
// Note: under mobile emulation an overflowing page also widens `innerWidth`, so widths are compared with
// `documentElement.clientWidth`, which stays at the device width.
// usage: node web/scripts/check-phone.mjs [--base http://localhost:8790] [--widths 360,390,1366] [--out web-live]
//   (--out names the folder under out/ for the screenshots; default out/web/)
import { mkdirSync, writeFileSync } from 'node:fs'
import { browser, sleep } from './browser.mjs'

const args = process.argv.slice(2)
const BASE = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'http://localhost:8790'
const OUT = new URL(args.includes('--out') ? `../../out/${args[args.indexOf('--out') + 1]}/` : '../../out/web/', import.meta.url)
const WIDTHS = args.includes('--widths') ? args[args.indexOf('--widths') + 1].split(',').map(Number) : [360, 390]
const PAGES = ['/', '/proof/expresscart', '/proof/simple-clothing-store', '/scan?repo=mrvautin/expressCart']

const PROBE = `
  const de = document.documentElement, W = de.clientWidth, problems = []
  const name = (e) => e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className ? '.' + e.className.split(' ').join('.') : '')
  const scrolls = (e) => { for (let p = e.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') return true } return false }
  const report = (why) => {
    problems.push(why + ': page is ' + de.scrollWidth + 'px wide')
    const wide = [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > W + 1 && !scrolls(e))
    for (const e of wide.filter((e) => !wide.includes(e.parentElement)).slice(0, 3)) problems.push('  wider than the screen: ' + name(e))
  }
  if (de.scrollWidth > W + 1) report('closed')
  // Stray "0" (review r2): \`{list.length && <X/>}\` renders a bare 0 when the list is empty. Its signature is a text
  // node that is just a number, with elements (or nothing) on both sides, inside a parent that also holds elements.
  // "0 fail" (number then text) and a stat that is only "0" are not matched.
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const bare = []
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    if (!/^\\d+$/.test(n.textContent.trim())) continue
    const side = (x) => !x || (x.nodeType === 1)
    if (side(n.previousSibling) && side(n.nextSibling) && n.parentElement && n.parentElement.children.length > 0) bare.push(n)
  }
  if (bare.length) problems.push(bare.length + ' bare number(s) between elements (a stray {n && …}?), first in ' + name(bare[0].parentElement))
  // Side gutter: at phone width, text must start at least 16 px from the left edge. An inline \`padding\` shorthand
  // that zeroes .wrap's side padding (the Scan page bug, review r1) leaves every line touching the screen edge, which
  // the width probe above cannot see. Text inside a horizontal scroller (the nav strip) is exempt.
  if (W < 500) {
    const tight = [...document.querySelectorAll('main h1, main h2, main h3, main p, main li, main label, main input, main .kicker')]
      .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.left < 15.5 && (e.tagName === 'INPUT' || e.textContent.trim() !== '') })
      .filter((e) => !scrolls(e))
    // Every page link in the top nav must be visible without swiping (review r1: "Scan a repo" sat off-screen).
    for (const a of document.querySelectorAll('.nav a')) if (a.getBoundingClientRect().right > W + 0.5) problems.push('nav link cut off at the right edge: "' + a.textContent.trim() + '"')
    for (const e of tight.slice(0, 3)) problems.push('text closer than 16px to the left edge (' + Math.round(e.getBoundingClientRect().left) + 'px): ' + name(e) + ' "' + e.textContent.trim().slice(0, 30) + '"')
  }
  for (const d of document.querySelectorAll('details')) {
    d.open = true; await sleep(60)
    if (de.scrollWidth > W + 1) { report('with "' + (d.querySelector('summary')?.textContent ?? '').trim().slice(0, 40) + '" open'); d.open = false; break }
    d.open = false
  }
  return problems`

mkdirSync(OUT, { recursive: true })
let failures = 0
for (const w of WIDTHS) {
  const b = await browser({ width: w, height: 800 })
  try {
    await b.send('Page.enable')
    for (const page of PAGES) {
      await b.send('Page.navigate', { url: BASE + page })
      await sleep(3000)
      if (page.startsWith('/scan')) { await b.evaluate(`(async () => { for (let i = 0; i < 50 && !document.querySelector('form button'); i++) await new Promise((r) => setTimeout(r, 200)); document.querySelector('form button').click() })()`); await sleep(6000) }
      const problems = await b.evaluate(PROBE)
      const h = await b.evaluate('return document.documentElement.scrollHeight')
      console.log(`${w}px ${page}: height ${h}px`)
      // Height budget for the home page (21 Oct trim: it had grown to 11,000 px at 390 for a judge with 3 minutes).
      // Detail belongs behind <details> or on the evidence pages. Phones scale the 390 px budget by width.
      // Evidence pages (review r3: 11-16k px at 390): 9,000 px on phones; long lists fold behind <details> there.
      const budget = page === '/' ? (w < 500 ? Math.round(6000 * 390 / w) : 5000) : page.startsWith('/proof/') && w < 500 ? Math.round(9000 * 390 / w) : 0
      if (budget && h > budget) problems.push(`${page === '/' ? 'home page' : 'evidence page'} is ${h}px tall, over its ${budget}px budget: fold detail into <details>${page === '/' ? ' or move it to the evidence pages' : ' on phones'}`)
      for (const p of problems) console.log(`${w}px ${page}: ${p}`)
      failures += problems.length
      const shot = await b.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
      writeFileSync(new URL(`${w < 500 ? 'phone' : 'desktop'}-${w}-${page.replace(/\?.*/, '').replace(/\W+/g, '') || 'home'}.png`, OUT), Buffer.from(shot.result.data, 'base64'))
    }
  } finally {
    b.close()
  }
}
console.log(failures ? `\n${failures} phone layout problem(s)` : `phone layout ok: ${PAGES.length} pages at ${WIDTHS.join(', ')} px`)
process.exit(failures ? 1 : 0)
