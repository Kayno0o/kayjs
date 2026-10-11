import type { Subprocess } from 'bun'
import type { Browser, Page } from 'playwright-core'
import type { Variant } from './sites'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { median, milliseconds, table } from '../format'
import { ensureFree, killAll, processesIn, processTree, tracked, treeCpu, treeMemory } from './serve'
import { kayIn, label, VARIANTS, versionIn } from './sites'

type EditKind = 'template' | 'style' | 'server'
type Memory = ReturnType<typeof treeMemory>

interface Edit {
  ms: number
  // Shown by the dev server itself, or only once the page was reloaded by hand.
  by: 'itself' | 'reload'
  // The page kept a marker set on `window` and its scroll position.
  kept: boolean
  // The value typed into the page's first text field was still there; none when the page has no such field.
  field?: boolean | undefined
  // What the dev server logged its restarts within the edit took, summed; none for a server that logs none, as Astro's.
  restart?: number | undefined
  // CPU time of the dev server's processes over `EDIT_WINDOW_MS` from the write, or until shown when later, in ms.
  cpu: number
}

// Latency and the CPU time the dev server's processes spent meanwhile, in ms.
interface Timed {
  ms: number
  cpu: number
}

export interface DevResult {
  // What the dev server is, as `kay 1.38.0, the registry`.
  software: string
  cold: Timed[]
  warm: Timed[]
  // Per session: every page's first load, load events and requests summed.
  loads: (Timed & { requests: number })[]
  // CPU time the dev server spent while the edit page sat open, before the edits.
  idle: number[]
  edits: Record<EditKind, Edit[]>
  rest: Memory[]
  edited: Memory[]
}

// What the page exposes to the bench, from `WATCH` and the bench itself.
interface BenchWindow {
  __kayBenchMarker?: boolean
  __kayBenchShown: (kind: string, token: string) => Promise<number>
}

// Each side runs this many sessions, the sides alternating, the order reversed every other session.
const SESSIONS = count('DEV_SESSIONS', 3)
const WARM_STARTS = count('DEV_STARTS', 5)
const EDIT_ROUNDS = count('DEV_EDITS', 7)
const KINDS: EditKind[] = ['template', 'style', 'server']
const READY_TIMEOUT_MS = 60_000
const SHOW_TIMEOUT_MS = 10_000
const STOP_TIMEOUT_MS = 5000
// Between edits, so a rebuild never overlaps the next edit, and before memory is read.
const SETTLE_MS = 1000
// The CPU time of an edit is read over this long from its write, or until it showed when that took longer.
const EDIT_WINDOW_MS = 1500
const REST_MS = 2000
const SCROLL = 300
const VIEWPORT = { width: 1280, height: 800 }
// A path no page serves, the first a fresh dev server is asked for: answering it may build the not-found page and start the bundler, which the first loads then find ready.
const UNSERVED = '/kay-bench-ready'
// How `kay dev` reports a restart in its output.
const RESTARTED = /restarted in (\d+) ms/g
// How `kay dev` and Vite say their port was taken, before moving to another.
const PORT_TAKEN = /was in use|is in use/
const LOGS = ['dev.out.log', 'dev.err.log']
// The field the bench types into on the edit page, when it has one: a text input or a text area.
const FIELD = 'input:is(:not([type]), [type=text], [type=email], [type=search], [type=tel], [type=url]), textarea'
const TYPED = 'kay bench'
// What each dev server keeps between runs, cleared before a cold start.
const CACHES: Record<Variant['kind'], string[]> = { astro: ['.astro', 'node_modules/.vite', 'node_modules/.astro'], kay: ['.kay'] }

// Installed in every document: resolves once the page shows an edit's word, checked after every DOM mutation and every task, then two frames later, once a frame painted it. A reload lands in a new document, which takes up the edit sessionStorage names from its start.
// The word counts in the visible text only, not in props a script serializes, in whatever case the page renders it; textContent first, which needs no layout.
const WATCH = `(() => {
  let armed
  const arm = (kind, token) => {
    const shows = () => kind === 'style' ? getComputedStyle(document.documentElement).getPropertyValue('--kay-bench').trim() === token : (document.body?.textContent ?? '').includes(token) && document.body.innerText.toLowerCase().includes(token)
    let resolve
    let done = false
    const shown = new Promise(settle => { resolve = settle })
    const check = () => {
      if (done || !shows())
        return
      done = true
      observer.disconnect()
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.timeOrigin + performance.now())))
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

// A count from the environment, `fallback` when unset.
function count(name: string, fallback: number): number {
  const value = process.env[name]

  if (value === undefined)
    return fallback

  if (!(/^[1-9]\d*$/).test(value))
    throw new Error(`${name} must be a whole number above 0, not "${value}"`)

  return Number(value)
}

const devUrl = (variant: Variant, path: string) => `http://127.0.0.1:${variant.ports.dev}${path}`

// Each side's dev server on each site that names what to edit, interleaved: startups cold and warm, every page's first load, edits timed to the screen, and memory before and after them.
export async function development(browser: Browser): Promise<Map<Variant, DevResult>> {
  const variants = VARIANTS.filter(variant => variant.site.dev !== undefined)
  const results = new Map<Variant, DevResult>(await Promise.all(variants.map(async (variant): Promise<[Variant, DevResult]> => [variant, { software: variant.kind === 'astro' ? `Astro ${await versionIn(variant.devDir, 'astro')}` : await kayIn(variant.devDir), cold: [], warm: [], loads: [], idle: [], edits: { template: [], style: [], server: [] }, rest: [], edited: [] }])))

  for (let session = 0; session < SESSIONS; session++) {
    for (const variant of session % 2 === 0 ? variants : variants.toReversed()) {
      const result = results.get(variant)!

      console.error(`dev server ${session + 1}/${SESSIONS}: ${label(variant)}`)

      for (const cache of CACHES[variant.kind])
        rmSync(join(variant.devDir, cache), { recursive: true, force: true })

      result.cold.push(await startup(variant))

      for (let start = 0; start < WARM_STARTS; start++)
        result.warm.push(await startup(variant))

      const server = await startDev(variant)

      try {
        await untilServed(variant, server, UNSERVED)
        const before = treeCpu(server.pid, variant.devDir)
        const loads = await firstLoads(browser, variant)

        result.loads.push({ ...loads, cpu: cpuSince(variant, server, before) })
        await editSession(browser, variant, server, result)
      }
      finally {
        await stopDev(variant, server)
      }
    }
  }

  return results
}

// Astro runs under Bun, as jb-peinture's own dev script runs it. Neither CLI has a flag to refuse another port, so the port is checked free first.
async function startDev(variant: Variant): Promise<Subprocess> {
  await ensureFree(variant.ports.dev, label(variant))

  return spawnDev(variant)
}

function spawnDev(variant: Variant): Subprocess {
  const port = String(variant.ports.dev)

  freshLogs(variant.devDir)

  return tracked(Bun.spawn(variant.kind === 'astro' ? [process.execPath, 'x', '--bun', 'astro', 'dev', '--port', port, '--host', '127.0.0.1'] : [process.execPath, 'x', 'kay', 'dev', '--port', port], {
    cwd: variant.devDir,
    stdout: Bun.file(join(variant.devDir, 'dev.out.log')),
    stderr: Bun.file(join(variant.devDir, 'dev.err.log')),
    env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }, ...variant.site.devEnv },
  }))
}

// Written over from its start, a longer log of the last server would keep its size, and an edit's restarts be read from its old lines.
export function freshLogs(dir: string) {
  for (const log of LOGS)
    rmSync(join(dir, log), { force: true })
}

// The CPU time the dev server spent since `before`, never below 0, as a process leaving the tree takes its time with it.
function cpuSince(variant: Variant, server: Subprocess, before: number): number {
  return Math.max(0, treeCpu(server.pid, variant.devDir) - before)
}

// From spawning the dev server to its first 200 on the home page.
async function startup(variant: Variant): Promise<Timed> {
  await ensureFree(variant.ports.dev, label(variant))

  const started = performance.now()
  const server = spawnDev(variant)

  try {
    await untilServed(variant, server, '/')

    return { ms: performance.now() - started, cpu: treeCpu(server.pid, variant.devDir) }
  }
  finally {
    await stopDev(variant, server)
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

    const logs = await Promise.all(LOGS.map(async log => Bun.file(join(variant.devDir, log)).text()))

    if (logs.some(log => PORT_TAKEN.test(log)))
      throw new Error(`${label(variant)}: the dev server found ${variant.ports.dev} taken and moved to another port; see dev.out.log in ${variant.devDir}`)

    await Bun.sleep(5)
  }

  throw new Error(`${label(variant)}: the dev server did not serve ${path} on ${variant.ports.dev}, exit code ${server.exitCode}; see dev.err.log in ${variant.devDir}`)
}

// The dev server and every process it started, as kay's spare server and client builder, and whatever still runs in its copy, as a spare it respawned while stopping, which left its tree.
async function stopDev(variant: Variant, server: Subprocess): Promise<void> {
  const tree = processTree(server.pid)

  server.kill()
  await Promise.race([server.exited, Bun.sleep(STOP_TIMEOUT_MS)])
  await killAll([...tree, ...processTree(server.pid), ...processesIn(variant.devDir)])
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

// The edit page open, marked and scrolled: memory at rest, then each kind of edit in turn, a first round as a warm-up, then memory again, the files put back after.
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
  const log = join(variant.devDir, 'dev.out.log')
  let sequence = 0

  await context.addInitScript(WATCH)

  try {
    const page = await context.newPage()

    await page.goto(devUrl(variant, path), { waitUntil: 'load', timeout: READY_TIMEOUT_MS })
    // Past what loading the page set off, as the bundler's first build.
    await Bun.sleep(SETTLE_MS)
    const resting = treeCpu(server.pid, variant.devDir)

    await Bun.sleep(REST_MS)
    result.idle.push(cpuSince(variant, server, resting))
    result.rest.push(treeMemory(server.pid))

    for (let round = 0; round <= EDIT_ROUNDS; round++) {
      for (const kind of KINDS) {
        const token = `kb${++sequence}q`
        const logged = Bun.file(log).size
        const before = treeCpu(server.pid, variant.devDir)
        const started = now()
        const edit = await timeEdit(page, kind, token, files[kind], edited(kind, token))

        await Bun.sleep(Math.max(0, started + EDIT_WINDOW_MS - now()))
        const cpu = cpuSince(variant, server, before)

        await Bun.sleep(SETTLE_MS)

        if (round > 0)
          result.edits[kind].push({ ...edit, restart: restartsIn(await Bun.file(log).slice(logged).text()), cpu })
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
async function timeEdit(page: Page, kind: EditKind, token: string, file: string, content: string): Promise<Omit<Edit, 'restart' | 'cpu'>> {
  const scrolled = await page.evaluate((scroll) => {
    (window as unknown as BenchWindow).__kayBenchMarker = true
    // Past a smooth scroll the sites may set, which would still be moving when read.
    scrollTo({ top: scroll, behavior: 'instant' })

    return scrollY
  }, SCROLL)
  const typed = await page.evaluate(({ selector, value }) => {
    const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)

    if (field)
      field.value = value

    return field !== null
  }, { selector: FIELD, value: TYPED })

  await page.evaluate(({ kind, token }) => {
    void (window as unknown as BenchWindow).__kayBenchShown(kind, token)
  }, { kind, token })

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

  const kept = await page.evaluate(scroll => (window as unknown as BenchWindow).__kayBenchMarker === true && Math.abs(scrollY - scroll) <= 1, scrolled)
  const field = typed ? await page.evaluate(selector => document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)?.value, FIELD) === TYPED : undefined

  return { ms: shown - from, by, kept, field }
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
    return await page.evaluate(async ({ kind, token }) => (window as unknown as BenchWindow).__kayBenchShown(kind, token), { kind, token })
  }
  catch {
    return 'gone'
  }
}

// The restarts a dev server's output reports, their times summed; undefined when it reports none.
export function restartsIn(output: string): number | undefined {
  const times = [...output.matchAll(RESTARTED)].map(match => Number(match[1]))

  return times.length === 0 ? undefined : times.reduce((sum, time) => sum + time, 0)
}

// The dev section of the results, one column a site's side.
export function devSection(results: Map<Variant, DevResult>): string[] {
  const variants = [...results.keys()]

  if (variants.length === 0)
    return []

  const spread = (values: number[], format = milliseconds) => values.length === 0 ? '-' : `${format(median(values))} (${format(Math.min(...values))} to ${format(Math.max(...values))})`
  const mebibytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(0)
  const memory = (memories: Memory[]) => memories.length === 0 ? '-' : `${mebibytes(median(memories.map(entry => entry.pss)))} (${mebibytes(median(memories.map(entry => entry.rss)))}), ${median(memories.map(entry => entry.processes))} processes`
  const cpu = (entries: { cpu: number }[]) => entries.length === 0 ? '' : `; CPU ${milliseconds(median(entries.map(entry => entry.cpu)))}`
  const timed = (entries: Timed[]) => `${spread(entries.map(entry => entry.ms))}${cpu(entries)}`
  const edit = (edits: Edit[]) => {
    const itself = edits.filter(entry => entry.by === 'itself')
    const reloaded = edits.filter(entry => entry.by === 'reload')

    return `${itself.length === 0 ? `never by itself; ${spread(reloaded.map(entry => entry.ms))} from a reload by hand` : `${spread(itself.map(entry => entry.ms))}${reloaded.length === 0 ? '' : `, ${reloaded.length} only after a reload by hand`}`}${cpu(edits)}`
  }
  const restarts = (edits: Edit[]) => {
    const restarted = edits.flatMap(entry => entry.restart ?? [])

    return restarted.length === 0 ? 'none logged' : `${spread(restarted)}${restarted.length === edits.length ? '' : `, in ${restarted.length} of ${edits.length}`}`
  }
  const row = (name: string, value: (result: DevResult) => string) => [name, ...variants.map(variant => value(results.get(variant)!))]

  return [
    '## Dev server',
    '',
    `Each side's dev server (\`astro dev\` under Bun, \`kay dev\`) run from a copy of the site on its own port, ${SESSIONS} sessions a side, the sides alternating. Figures are medians, with the range in brackets. Browser: headless Chromium, ${VIEWPORT.width}x${VIEWPORT.height}, unthrottled over loopback, the site's own CSP enforced.`,
    '',
    `- **Startup:** from spawning the dev server to its first 200 on the home page, once with its caches cleared (\`.astro\` and \`node_modules/.vite\`, or \`.kay\`) and ${WARM_STARTS} times warm, every session.`,
    `- **First load:** every page once, each in a fresh browser context, on a server that has only answered \`${UNSERVED}\`, a path no page serves, which may have built its not-found page and started its bundler: load events and requests summed over the pages.`,
    `- **Edits:** the site's edit page is open with a marker set on \`window\` and scrolled ${SCROLL} px. One edit a kind in turn, a first round as a warm-up, then ${EDIT_ROUNDS} rounds a session, each timed from the file write to the frame after the one that painted it, its word in the page's visible text, checked after every DOM mutation and every task. Of that, the server restart is what \`kay dev\` logs its restarts within the edit took; the rest is the browser's. The template edit adds a word to a text of the page's template, the style edit appends a rule to the site's stylesheet, the server code edit adds a word to a value the page's server code renders (Astro's frontmatter, kay's page script), only in the copies, whose config the site's \`prepareDev\` may adjust to run locally (jb-peinture's Astro config sends Vite's reloads to its public host, which its copy sends to the dev server). An edit not shown after ${SHOW_TIMEOUT_MS / 1000} s is shown by reloading the page by hand, timed from that reload. The state kept is the marker and the scroll position, and apart, a value typed into the page's first text field when it has one.`,
    `- **CPU:** beside each figure, the median CPU time the dev server's whole process tree spent meanwhile, in ms, the servers a restart stopped included: until the first 200 for a startup, over the first loads, and for an edit over the ${EDIT_WINDOW_MS / 1000} s from its write, or until shown when that took longer. Idle CPU is read ${SETTLE_MS / 1000} s after the edit page loaded.`,
    `- **Memory:** proportional (resident) memory of the dev server's whole process tree, in MiB: at rest with the edit page open, then after the ${KINDS.length * EDIT_ROUNDS} edits of a session. Resident memory counts the pages its processes share once each.`,
    '',
    table(['', ...variants.map(label)], [
      row('dev server', result => result.software),
      row('startup, caches cleared (ms)', result => timed(result.cold)),
      row('startup, warm (ms)', result => timed(result.warm)),
      row('first load of every page, load events summed (ms)', result => timed(result.loads)),
      row('requests for them', result => spread(result.loads.map(load => load.requests), count => count.toFixed(0))),
      ...KINDS.flatMap(kind => [
        row(`${kind === 'server' ? 'server code' : kind} edit to screen (ms)`, result => edit(result.edits[kind])),
        row('of which server restart (ms)', result => restarts(result.edits[kind])),
      ]),
      row('page state kept through the edit (template / style / server)', result => `${KINDS.map(kind => result.edits[kind].filter(entry => entry.kept).length).join(' / ')} of ${result.edits.template.length}`),
      row('form field value kept (template / style / server)', result => result.edits.template.some(entry => entry.field !== undefined) ? `${KINDS.map(kind => result.edits[kind].filter(entry => entry.field === true).length).join(' / ')} of ${result.edits.template.length}` : 'no text field on the edit page'),
      row(`CPU while the edit page sits open ${REST_MS / 1000} s (ms)`, result => spread(result.idle)),
      row('memory at rest, PSS (RSS)', result => memory(result.rest)),
      row('memory after the edits, PSS (RSS)', result => memory(result.edited)),
    ]),
    '',
  ]
}
