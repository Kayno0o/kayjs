import type { Subprocess } from 'bun'
import type { Browser, Page } from 'playwright-core'
import type { Variant } from './sites'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { median, milliseconds, table } from '../format'
import { processTree, treeMemory } from './serve'
import { label, VARIANTS } from './sites'

type EditKind = 'template' | 'style' | 'server'
type Memory = ReturnType<typeof treeMemory>

interface Edit {
  ms: number
  // Shown by the dev server itself, or only once the page was reloaded by hand.
  by: 'itself' | 'reload'
  // The page kept a marker set on `window` and its scroll position.
  kept: boolean
}

export interface DevResult {
  cold: number[]
  warm: number[]
  // Per session: every page's first load, load events and requests summed.
  loads: { ms: number, requests: number }[]
  edits: Record<EditKind, Edit[]>
  rest: Memory[]
  edited: Memory[]
}

// Each side runs this many sessions, the sides alternating, the order reversed every other session.
const SESSIONS = 2
const WARM_STARTS = Number(process.env.DEV_STARTS ?? 5)
const EDIT_ROUNDS = Number(process.env.DEV_EDITS ?? 7)
const KINDS: EditKind[] = ['template', 'style', 'server']
const READY_TIMEOUT_MS = 60_000
const SHOW_TIMEOUT_MS = 10_000
const STOP_TIMEOUT_MS = 5000
// Between edits, so a rebuild never overlaps the next edit, and before memory is read.
const SETTLE_MS = 1000
const REST_MS = 2000
const SCROLL = 300
const VIEWPORT = { width: 1280, height: 800 }
// A path no page serves, which a dev server answers without building a page.
const UNSERVED = '/kay-bench-ready'
// What each dev server keeps between runs, cleared before a cold start.
const CACHES: Record<Variant['kind'], string[]> = { astro: ['.astro', 'node_modules/.vite', 'node_modules/.astro'], kay: ['.kay'] }

// Installed in every document: resolves once the page shows an edit's word, checked after every DOM mutation and every task. A reload lands in a new document, which takes up the edit sessionStorage names from its start.
const WATCH = `(() => {
  let armed
  const arm = (kind, token) => {
    const shows = () => kind === 'style' ? getComputedStyle(document.documentElement).getPropertyValue('--kay-bench').trim() === token : (document.body?.textContent ?? '').includes(token)
    let resolve
    let done = false
    const shown = new Promise(settle => { resolve = settle })
    const check = () => {
      if (done || !shows())
        return
      done = true
      observer.disconnect()
      resolve(performance.timeOrigin + performance.now())
    }
    const observer = new MutationObserver(check)
    const channel = new MessageChannel()
    observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true })
    channel.port1.onmessage = () => {
      check()
      if (!done)
        channel.port2.postMessage(null)
    }
    channel.port2.postMessage(null)
    armed = { token, shown }
    try { sessionStorage.setItem('kay-bench', JSON.stringify({ kind, token })) } catch {}
  }
  window.__kayBenchShown = (kind, token) => {
    if (armed?.token !== token)
      arm(kind, token)
    return armed.shown
  }
  try {
    const pending = JSON.parse(sessionStorage.getItem('kay-bench') ?? 'null')
    if (pending)
      arm(pending.kind, pending.token)
  } catch {}
})()`

const now = () => performance.timeOrigin + performance.now()
const devUrl = (variant: Variant, path: string) => `http://127.0.0.1:${variant.ports.dev}${path}`

// Each side's dev server on each site that names what to edit, interleaved: startups cold and warm, every page's first load, edits timed to the screen, and memory before and after them.
export async function development(browser: Browser): Promise<Map<Variant, DevResult>> {
  const variants = VARIANTS.filter(variant => variant.site.dev !== undefined)
  const results = new Map<Variant, DevResult>(variants.map(variant => [variant, { cold: [], warm: [], loads: [], edits: { template: [], style: [], server: [] }, rest: [], edited: [] }]))

  for (let session = 0; session < SESSIONS; session++) {
    for (const variant of session % 2 === 0 ? variants : variants.toReversed()) {
      const result = results.get(variant)!

      console.error(`dev server ${session + 1}/${SESSIONS}: ${label(variant)}`)

      for (const cache of CACHES[variant.kind])
        rmSync(join(variant.devDir, cache), { recursive: true, force: true })

      result.cold.push(await startup(variant))

      for (let start = 0; start < WARM_STARTS; start++)
        result.warm.push(await startup(variant))

      const server = startDev(variant)

      try {
        await untilServed(variant, server, UNSERVED)
        result.loads.push(await firstLoads(browser, variant))
        await editSession(browser, variant, server, result)
      }
      finally {
        await stopDev(server)
      }
    }
  }

  return results
}

// Astro runs under Bun, as jb-peinture's own dev script runs it.
function startDev(variant: Variant): Subprocess {
  const port = String(variant.ports.dev)

  return Bun.spawn(variant.kind === 'astro' ? [process.execPath, 'x', '--bun', 'astro', 'dev', '--port', port, '--host', '127.0.0.1'] : [process.execPath, 'x', 'kay', 'dev', '--port', port], {
    cwd: variant.devDir,
    stdout: Bun.file(join(variant.devDir, 'dev.out.log')),
    stderr: Bun.file(join(variant.devDir, 'dev.err.log')),
    env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }, ...variant.site.devEnv },
  })
}

// Milliseconds from spawning the dev server to its first 200 on the home page.
async function startup(variant: Variant): Promise<number> {
  const started = performance.now()
  const server = startDev(variant)

  try {
    await untilServed(variant, server, '/')

    return performance.now() - started
  }
  finally {
    await stopDev(server)
  }
}

// Waits for the server to answer `path`: with a 200 for a page, with anything for the path no page serves.
async function untilServed(variant: Variant, server: Subprocess, path: string): Promise<void> {
  const started = performance.now()

  while (performance.now() - started < READY_TIMEOUT_MS && server.exitCode === null) {
    try {
      const response = await fetch(devUrl(variant, path))

      await response.arrayBuffer()

      if (response.status === 200 || path === UNSERVED)
        return
    }
    catch {}
    await Bun.sleep(5)
  }

  throw new Error(`${label(variant)}: the dev server did not serve ${path} on ${variant.ports.dev}, exit code ${server.exitCode}; see dev.err.log in ${variant.devDir}`)
}

// The dev server and every process it started, as kay's spare server and client builder.
async function stopDev(server: Subprocess): Promise<void> {
  const tree = processTree(server.pid)

  server.kill()
  await Promise.race([server.exited, Bun.sleep(STOP_TIMEOUT_MS)])

  for (const pid of tree) {
    try {
      process.kill(pid, 'SIGKILL')
    }
    catch {}
  }

  await server.exited
}

async function newContext(browser: Browser) {
  const context = await browser.newContext({ viewport: VIEWPORT })

  // A map frame or analytics would time another host.
  await context.route(url => url.hostname !== '127.0.0.1', async route => route.abort())

  return context
}

// Every page loaded once, each in a fresh context, on a server that built none of them yet.
async function firstLoads(browser: Browser, variant: Variant): Promise<{ ms: number, requests: number }> {
  let ms = 0
  let requests = 0

  for (const path of variant.site.pages) {
    const context = await newContext(browser)
    const page = await context.newPage()

    await page.goto(devUrl(variant, path), { waitUntil: 'load', timeout: READY_TIMEOUT_MS })
    await page.waitForFunction(() => (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).loadEventEnd > 0)

    const load = await page.evaluate(() => ({ ms: (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).loadEventEnd, requests: performance.getEntriesByType('resource').length + 1 }))

    ms += load.ms
    requests += load.requests
    await context.close()
  }

  return { ms, requests }
}

// The edit page open, marked and scrolled: memory at rest, then each kind of edit in turn, then memory again, the files put back after.
async function editSession(browser: Browser, variant: Variant, server: Subprocess, result: DevResult): Promise<void> {
  const { page: path, [variant.kind]: edits } = variant.site.dev!
  const files = { template: join(variant.devDir, edits.template.file), server: join(variant.devDir, edits.server.file), style: join(variant.devDir, edits.style) }
  const originals = new Map(await Promise.all(Object.values(files).map(async file => [file, await Bun.file(file).text()] as const)))
  const edited = (kind: EditKind, token: string) => {
    const original = originals.get(files[kind])!

    if (kind === 'style')
      return `${original}\n:root { --kay-bench: ${token}; }\n`

    const { text } = edits[kind]

    if (!original.includes(text))
      throw new Error(`${label(variant)}: ${files[kind]} holds no "${text}" to edit`)

    return original.replace(text, () => `${text} ${token}`)
  }
  const context = await newContext(browser)
  let sequence = 0

  await context.addInitScript(WATCH)

  try {
    const page = await context.newPage()

    await page.goto(devUrl(variant, path), { waitUntil: 'load', timeout: READY_TIMEOUT_MS })
    await Bun.sleep(REST_MS)
    result.rest.push(treeMemory(server.pid))

    for (let round = 0; round < EDIT_ROUNDS; round++) {
      for (const kind of KINDS) {
        const token = `kb${++sequence}q`

        result.edits[kind].push(await timeEdit(page, kind, token, files[kind], edited(kind, token)))
        await Bun.sleep(SETTLE_MS)
      }
    }

    result.edited.push(treeMemory(server.pid))
  }
  finally {
    await context.close()
    await Promise.all([...originals].map(async ([file, text]) => Bun.write(file, text)))
    await Bun.sleep(SETTLE_MS)
  }
}

// From the file write to the page showing the edit's word, or from a reload by hand when the dev server shows nothing by itself.
async function timeEdit(page: Page, kind: EditKind, token: string, file: string, content: string): Promise<Edit> {
  const scrolled = await page.evaluate((scroll) => {
    (window as unknown as { __kayBenchMarker: boolean }).__kayBenchMarker = true
    // Past a smooth scroll the sites may set, which would still be moving when read.
    scrollTo({ top: scroll, behavior: 'instant' })

    return scrollY
  }, SCROLL)

  await page.evaluate(([kind, token]) => {
    void (window as unknown as { __kayBenchShown: (kind: string, token: string) => Promise<number> }).__kayBenchShown(kind!, token!)
  }, [kind, token])

  const written = now()

  await Bun.write(file, content)

  let by: Edit['by'] = 'itself'
  let from = written
  let shown = await shownBy(page, kind, token, written + SHOW_TIMEOUT_MS)

  if (shown === undefined) {
    by = 'reload'
    from = now()
    await page.reload({ waitUntil: 'commit' })
    shown = await shownBy(page, kind, token, from + SHOW_TIMEOUT_MS)
  }

  if (shown === undefined)
    throw new Error(`a ${kind} edit of ${file} never showed, a reload included`)

  const kept = await page.evaluate(scroll => (window as unknown as { __kayBenchMarker?: boolean }).__kayBenchMarker === true && Math.abs(scrollY - scroll) <= 1, scrolled)

  return { ms: shown - from, by, kept }
}

// When the page showed the word, across the reloads the dev server makes; undefined past the deadline.
async function shownBy(page: Page, kind: EditKind, token: string, deadline: number): Promise<number | undefined> {
  while (now() < deadline) {
    let timer: Timer | undefined
    const timeout = new Promise<'late'>((resolve) => {
      timer = setTimeout(resolve, deadline - now(), 'late')
    })

    try {
      const shown = await Promise.race([watch(page, kind, token), timeout])

      if (typeof shown === 'number')
        return shown

      if (shown === 'late')
        return undefined
    }
    finally {
      clearTimeout(timer)
    }

    // The document went away with a reload: the next one watches from its start.
    await Bun.sleep(10)
  }

  return undefined
}

async function watch(page: Page, kind: EditKind, token: string): Promise<number | 'gone'> {
  try {
    return await page.evaluate(async ([kind, token]) => (window as unknown as { __kayBenchShown: (kind: string, token: string) => Promise<number> }).__kayBenchShown(kind!, token!), [kind, token])
  }
  catch {
    return 'gone'
  }
}

// The dev section of the results, one column a site's side.
export function devSection(results: Map<Variant, DevResult>): string[] {
  const variants = [...results.keys()]

  if (variants.length === 0)
    return []

  const spread = (values: number[], format = milliseconds) => values.length === 0 ? '-' : `${format(median(values))} (${format(Math.min(...values))} to ${format(Math.max(...values))})`
  const mebibytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(0)
  const memory = (memories: Memory[]) => memories.length === 0 ? '-' : `${mebibytes(median(memories.map(entry => entry.pss)))} (${mebibytes(median(memories.map(entry => entry.rss)))}), ${median(memories.map(entry => entry.processes))} processes`
  const edit = (edits: Edit[]) => {
    const itself = edits.filter(entry => entry.by === 'itself')
    const reloaded = edits.filter(entry => entry.by === 'reload')

    return itself.length === 0 ? `never by itself; ${spread(reloaded.map(entry => entry.ms))} from a reload by hand` : `${spread(itself.map(entry => entry.ms))}${reloaded.length === 0 ? '' : `, ${reloaded.length} only after a reload by hand`}`
  }
  const row = (name: string, value: (result: DevResult) => string) => [name, ...variants.map(variant => value(results.get(variant)!))]

  return [
    '## Dev server',
    '',
    `Each side's dev server (\`astro dev\` under Bun, \`kay dev\`) run from a copy of the site on its own port, ${SESSIONS} sessions a side, the sides alternating. Figures are medians, with the range in brackets. Browser: headless Chromium, ${VIEWPORT.width}x${VIEWPORT.height}, unthrottled over loopback, the site's own CSP enforced.`,
    '',
    `- **Startup:** from spawning the dev server to its first 200 on the home page, once with its caches cleared (\`.astro\` and \`node_modules/.vite\`, or \`.kay\`) and ${WARM_STARTS} times warm, every session.`,
    '- **First load:** every page once on a fresh server, each in a fresh browser context: load events and requests summed over the pages.',
    `- **Edits:** the site's edit page is open with a marker set on \`window\` and scrolled ${SCROLL} px. One edit a kind in turn, ${EDIT_ROUNDS} rounds a session, each timed from the file write to the page showing it, checked after every DOM mutation and every task. The template edit adds a word to a text of the page's template, the style edit appends a rule to the site's stylesheet, the server code edit adds a word to a value the page's server code renders (Astro's frontmatter, kay's page script), only in the copies. An edit not shown after ${SHOW_TIMEOUT_MS / 1000} s is shown by reloading the page by hand, timed from that reload.`,
    `- **Memory:** proportional (resident) memory of the dev server's whole process tree, in MiB: at rest with the edit page open, then after the ${KINDS.length * EDIT_ROUNDS} edits of a session. Resident memory counts the pages its processes share once each.`,
    '',
    table(['', ...variants.map(label)], [
      row('startup, caches cleared (ms)', result => spread(result.cold)),
      row('startup, warm (ms)', result => spread(result.warm)),
      row('first load of every page, load events summed (ms)', result => spread(result.loads.map(load => load.ms))),
      row('requests for them', result => spread(result.loads.map(load => load.requests), count => count.toFixed(0))),
      ...KINDS.map(kind => row(`${kind === 'server' ? 'server code' : kind} edit to screen (ms)`, result => edit(result.edits[kind]))),
      row('page state kept through the edit (template / style / server)', result => `${KINDS.map(kind => result.edits[kind].filter(entry => entry.kept).length).join(' / ')} of ${result.edits.template.length}`),
      row('memory at rest, PSS (RSS)', result => memory(result.rest)),
      row('memory after the edits, PSS (RSS)', result => memory(result.edited)),
    ]),
    '',
  ]
}
