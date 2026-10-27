// Shot list for the Checkout Proof video, draft 3 (tools/video/README.md). Pages: the live site, no sign-in.
// Targets from video-probe.mjs on the live site (25 Oct; out/probe/) and the page source (web/src).
//
// The live run (s06) is always a replay of saved job eaa8a827 (22 Oct 18:00 UTC, original shop, 78 s, both FAIL):
// the click on "Run the original" is answered in the browser and never sent, the page shows "Running…" until s06b,
// and then that run's saved result, read from the live site (GET /api/rerun/<id>). Capture spends no live run.
import { goto } from '../../../tools/video/capture.mjs'

const H = 'https://checkout-proof-149219545146.us-central1.run.app'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const m = (mark) => ({ mark }) // the exact words on the page
const REPLAY = 'eaa8a827-83e1-4b8c-ae61-d10f22b0bdb8'
let released = false // s06b sets it: the replayed run's result may show from then on
async function replay(page) {
  await page.route('**/api/rerun', async (r) => {
    if (r.request().method() !== 'POST') return r.continue()
    await r.fulfill({ status: 202, json: { id: REPLAY, kind: 'original', expectedVerdict: 'FAIL', state: 'running', startedAt: new Date().toISOString(), progress: [], expected: 2 } })
  })
  await page.route(new RegExp(`/api/rerun/${REPLAY}(\\?|$)`), async (r) => {
    if (!released) return r.fulfill({ json: { id: REPLAY, kind: 'original', expectedVerdict: 'FAIL', state: 'running', startedAt: new Date(Date.now() - 8000).toISOString(), progress: [], expected: 2 } })
    return r.continue()
  })
}
const IN = 0.1 // pause between pages inside a section; sections end with the default

async function ready(page) {
  await page.mouse.move(2, 2).catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {})
  // The pages fetch their evidence JSON after load; wait for the first section heading.
  await page.waitForSelector('h1, h2', { timeout: 30000 }).catch(() => {})
  await sleep(1200)
}

async function setup(page) {
  // Checked again in s06b, where the page itself loads the run; here only a warning if the API answers oddly.
  let j = null
  for (let i = 0; i < 3 && !j; i++) {
    const r = await page.request.get(`${H}/api/rerun/${REPLAY}`, { headers: { accept: 'application/json' } })
    try { j = await r.json() } catch { console.log(`setup: /api/rerun answered ${r.status()} ${(await r.text()).slice(0, 80)}`); await sleep(3000) }
  }
  if (j && (j.state !== 'done' || (j.results ?? []).filter((x) => x.verdict === 'FAIL').length !== 2)) throw new Error(`saved run ${REPLAY} is not a finished 2-FAIL run: s06 cannot be replayed`)
}

const step = (n) => ({ css: '.step', nth: n })
const card = (n) => ({ css: '#plain-catch .catch-step', nth: n })

export default {
  width: 1280,
  pad: 0.15,
  setup,
  ready,
  cardCss: 'body{background:#f4f1ea;color:#1b211d} h1{font-size:64px;font-family:Georgia,serif} p{color:#3a423d;font-size:28px} .s{color:#6b726d} b{color:#1d6b43}',
  scenes: [
    { id: 'title', dur: 1.7, card: { title: 'Checkout Proof', lines: ['An AI upgrades PayPal checkouts.', '<b>The PayPal sandbox proves it.</b>'] } },

    // 1. The problem, then what Checkout Proof is (home: "The problem", then "How it works")
    { id: 's01a', url: `${H}/`, pad: IN,
      scroll: [[0, { text: "Open source still runs PayPal's old checkout.", within: 'section' }, { move: 0.05 }]],
      glow: [['Many online shops', { text: "Open source still runs PayPal's old checkout.", within: 'h2' }, 2.6], ['older integrations', { css: '.stat', nth: 1 }, 1.8]] },
    { id: 's01b',
      scroll: [[0, { css: 'h1' }, { move: 0.05 }], [{ at: 'Claude, an AI model', plus: -0.9 }, { text: 'Scan. Upgrade. Prove, and repair.', within: 'section' }, { move: 0.05 }]],
      glow: [['Checkout Proof upgrades', { css: 'h1' }, 4.5], ['Claude, an AI model', step(1), 3.6], ['Every paid order needs', m("Money rules compare the shop's record with PayPal's,"), 6],
        ['makes test payments', m("The shop's own server runs against the sandbox:"), 4], ['Some tests copy', m('PayPal-Mock-Response declines'), 3],
        ['Plain code, not AI', m('Verdicts: deterministic code'), 4]] },

    // 2. A bug in the old code: the expressCart hero run, original then upgraded
    { id: 's02a', url: `${H}/proof/expresscart`, pad: IN,
      scroll: [[0, { css: 'h1' }, { move: 0.05 }], [{ at: 'In one, a buyer', plus: -0.4 }, { text: 'payment page shows 480.00 EUR', within: '.tl-item' }, { center: true, move: 0.9 }],
        [{ at: 'Back in the shop', plus: -0.3 }, { text: 'buyer removes the boots', within: '.tl-item' }, { center: true, move: 0.6 }]],
      glow: [['The first shop tested', { css: 'h1' }, 3], ['starts a 480 euro order', { text: 'payment page shows 480.00 EUR', within: '.tl-item' }, 2.4],
        ['then cancels', { text: 'buyer cancels at PayPal', within: '.tl-item' }, 2.6],
        ['removes most of the items', { text: 'buyer removes the boots', within: '.tl-item' }, 2.4], ['pays 85 euros', { text: 'buyer logs in and pays', within: '.tl-item' }, 2.4]] },
    { id: 's02b',
      scroll: [[0, { css: '#hero .receipt' }, { center: true, move: 0.5 }]],
      glow: [['PayPal took 85 euros', { css: '#hero .receipt .receipt-col.pp' }, 2.4], ['But the shop marked', { css: '#hero .receipt .receipt-col.shop' }, 5.5],
        ['the same test passes', { css: '#hero .receipt' }, 4.5]],
      zoom: [['PayPal took 85 euros', { css: '#hero .receipt' }, 7.5, 1.3]],
      do: [["After Claude's upgrade", async (page) => { await page.locator('#hero .tabs button', { hasText: 'Upgraded shop' }).click() }, 600]] },

    // 3. Results: both shops, before and after (home)
    { id: 's03', url: `${H}/`,
      scroll: [[0, { text: 'What the original shops got wrong, and the upgrade fixed.', within: 'section' }, { move: 0.05 }]],
      glow: [['a second open-source shop', { css: '.target-card h3', nth: 1 }, 2.6],
        ['Across the two original shops', { css: '.target-card .v.bad', nth: 0 }, 3.6], ['Across the two original shops', { css: '.target-card .v.bad', nth: 1 }, 3.6],
        ['all nine are fixed', { css: '.target-card .v.good', nth: 0 }, 4], ['all nine are fixed', { css: '.target-card .v.good', nth: 1 }, 4]] },

    // 4. Claude's own bug on the plain prompt, and the fix from the evidence (simple-clothing-store)
    { id: 's04', url: `${H}/proof/simple-clothing-store`,
      scroll: [[0, { css: '#plain-catch' }, { move: 0.05 }]],
      glow: [['Checkout Proof also catches', { css: '#plain-catch .kicker' }, 3.4], ['only a plain request', { css: '#plain-catch .kicker' }, 3],
        ['accepted just 1 euro', { css: '#plain-catch .receipt' }, 5]],
      zoom: [[{ at: 'In a separate test', plus: 0.5 }, { css: '#plain-catch .receipt' }, 30, 1.5]] },
    { id: 's05',
      // Zoomed on Claude's step: the third card's count belongs to the whole suite (watch round 105).
      // Zoomed on Claude's step for the whole scene: the third card's 21 of 22 includes a sandbox-buyer timeout
      // (watch rounds 105 and 107), which the narration leaves out (owner, 25 Oct; read rounds 108-111).
      glow: [['sent the failing tests', card(1), 4.5], ['In under a minute', { css: '#plain-catch .catch-fig', nth: 0 }, 3.5], ['On the next test run', card(1), 2.6]],
      zoom: [[0.02, card(1), 30, 3.2]] },

    // 5. Live: watch the original lose money (a replay of saved job eaa8a827, see the header)
    { id: 's06a', url: `${H}/proof/simple-clothing-store#rerun`, pad: IN,
      scroll: [[0, { text: 'Run the proof yourself, now.', within: 'h3' }, { move: 0.05 }]],
      glow: [['one button runs two tests', { css: '.rerun-choice.red' }, 5], ['a red failed test', m('Red is the right result here'), 2.6]],
      do: [['It still has its old bugs', async (page) => { await replay(page); await page.locator('.rerun-choice.red button').click() }, 1500]] },
    { id: 's06b',
      // Frames wait here until the replayed run shows: the video cuts from "Running…" to the result.
      setup: async (page) => {
        released = true
        await page.waitForFunction(() => document.querySelectorAll('.live-red').length >= 2, null, { timeout: 240000 })
        await sleep(800)
      },
      scroll: [[0, { css: '.rerun-grid' }, { move: 0.6 }]],
      // The runner reports currency first, then two-tabs: the glows follow the words, not the order.
      glow: [['both tests fail', { css: '.rerun-grid' }, 2.4], ['One order is paid twice', { css: '.live-red', nth: 1 }, 2.6], ['62 Mexican pesos', { css: '.live-red' }, 3]] },

    // 6. Close: what to try on the live site, and the line (home hero)
    { id: 's07', url: `${H}/`,
      // Centred on the buttons: the links show, and the next section's headline stays below the captions (watch round 113).
      scroll: [[0, { css: 'a.btn' }, { center: true, move: 0.05 }], ['same money rule', { css: 'h1' }, { move: 0.8 }]],
      glow: [['scan any public GitHub repo', { css: '.hero-links a', nth: 1 }, 3], ['re-run the tests', { css: 'a.btn', nth: 0 }, 3.4],
        ['same money rule', { css: '.hero-receipt' }, 3.4], ["Don't just upgrade", { css: 'h1' }, 4.5]] },
    { id: 'end', dur: 2.2, card: { title: 'Checkout Proof', lines: ['checkout-proof-149219545146.us-central1.run.app', 'Everything runs in the PayPal sandbox. No real money moves.', '<span class="s">Narration: synthetic voice (Kokoro TTS)</span>'] } },
  ],
}
