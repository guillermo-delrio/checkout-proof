// A headless Chromium driven over the DevTools protocol, for the browser checks (check-phone, check-nav). Each call
// starts its own browser on a random port with its own profile, so checks can run side by side.
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Widths below 500 px use mobile emulation (snap Chromium's window cannot be narrower). */
export async function browser({ width = 1366, height = 800 } = {}) {
  const port = 9400 + Math.floor(Math.random() * 500)
  const dir = `${process.env.HOME}/.cache/check-browser-${port}`
  const mobile = width < 500
  const chrome = spawn(
    'chromium-browser',
    [`--user-data-dir=${dir}`, '--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--window-size=${mobile ? 500 : width},${height}`, 'about:blank'],
    { stdio: 'ignore' },
  )
  let targets
  for (let i = 0; i < 75 && !targets?.length; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
    } catch {}
    await sleep(200)
  }
  if (!targets?.length) throw new Error('chromium did not start (is chromium-browser installed?)')
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))
  let n = 0
  const pending = new Map()
  const listeners = new Map()
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data)
    if (d.id) {
      pending.get(d.id)?.(d)
      pending.delete(d.id)
    } else for (const f of listeners.get(d.method) ?? []) f(d.params)
  }
  const send = (method, params = {}) => new Promise((r) => (pending.set(++n, r), ws.send(JSON.stringify({ id: n, method, params }))))
  /** The next event of this kind (e.g. 'Page.loadEventFired', after 'Page.enable'). */
  const once = (method) =>
    new Promise((r) => {
      const set = listeners.get(method) ?? new Set()
      listeners.set(method, set)
      const f = (params) => (set.delete(f), r(params))
      set.add(f)
    })
  if (mobile) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true })
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  }
  const evaluate = async (body) => {
    const r = await send('Runtime.evaluate', { expression: `(async () => { const sleep = (ms) => new Promise(r => setTimeout(r, ms)); ${body} })()`, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400))
    return r.result?.result?.value
  }
  const close = () => {
    ws.close()
    chrome.kill()
    setTimeout(() => rmSync(dir, { recursive: true, force: true }), 500)
  }
  return { send, once, evaluate, close }
}
