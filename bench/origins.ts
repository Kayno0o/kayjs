import type { Browser, CDPSession } from 'playwright-core'
import type { CpuProfile, FrameOrigin, OriginBytes, Piece, SourceMapFile } from './attribution'
import { readdirSync } from 'node:fs'
import { cpus } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { decodeBundleMappings } from '../src/build/sourcemap'
import { buildClient } from '../src/server/client'
import { APP, BUNDLER, bytesByOrigin, ENGINE, GC, gzipSize, KAY, originOf, piecesOf, SOLID, sourceAt, timeByOrigin } from './attribution'
import { launch, openTable, OPERATIONS, serve, timeClick } from './browser'
import { kilobytes, milliseconds, table } from './format'

interface Chunk {
  pieces: Piece[]
  map: SourceMapFile
  segments: number[][][]
}

interface PageProfile {
  // Each origin's main-thread milliseconds per load.
  times: Map<string, number>
  // The chunks the page fetched, by file name.
  scripts: Set<string>
}

interface OperationProfile {
  name: string
  measured: number
  times: Map<string, number>
}

const ROOT = join(import.meta.dir, 'apps', 'kay')
const DIST = join(ROOT, '.kay', 'client', 'dist')
const LOADS = 10
const SAMPLES = 10
const SAMPLING_INTERVAL_US = 50
const SSR_RENDERS_LABEL = 'products page'
// Playwright's evaluations: nearly all of their time is the style and layout the timing loop forces once the DOM holds the result.
const LAYOUT = 'style and layout'
const INLINE = 'inline scripts'
const MAIN_ORIGINS = [SOLID, KAY, APP]
// The origins the operations table gives a column each; the rest are summed as "other".
const OPERATION_ORIGINS = [...MAIN_ORIGINS, GC, ENGINE, LAYOUT]
const JS_OUTPUT = /\.js$/

// The client kay serves, minified as in production, built with source maps so every byte and profiled function maps to its origin.
async function buildChunks(): Promise<Map<string, Chunk>> {
  await buildClient(ROOT, { minify: true, sourcemap: true, routes: 'routes' })

  const chunks = new Map<string, Chunk>()

  for (const file of readdirSync(DIST).filter(name => JS_OUTPUT.test(name))) {
    const mapFile = join(DIST, `${file}.map`)
    const map = await Bun.file(mapFile).json() as SourceMapFile

    chunks.set(file, { pieces: piecesOf(await Bun.file(join(DIST, file)).text(), map, mapFile), map, segments: decodeBundleMappings(map.mappings) })
  }

  return chunks
}

// A Chromium frame's origin: a chunk's function by the source its first character maps to, a native one left to its caller.
function browserOrigin(chunks: Map<string, Chunk>): FrameOrigin {
  return (frame) => {
    if (frame.url === '')
      return frame.scriptId === '0' ? undefined : LAYOUT

    const chunk = chunks.get(basename(new URL(frame.url).pathname))

    if (chunk === undefined)
      return INLINE

    const source = sourceAt(chunk.map, chunk.segments, frame.lineNumber, frame.columnNumber)

    return source === undefined ? BUNDLER : originOf(resolve(DIST, source))
  }
}

async function startProfiler(session: CDPSession): Promise<void> {
  await session.send('Profiler.enable')
  await session.send('Profiler.setSamplingInterval', { interval: SAMPLING_INTERVAL_US })
  await session.send('Profiler.start')
}

async function stopProfiler(session: CDPSession): Promise<CpuProfile> {
  return (await session.send('Profiler.stop')).profile as CpuProfile
}

function addTimes(into: Map<string, number>, times: Map<string, number>, scale: number): void {
  for (const [origin, time] of times)
    into.set(origin, (into.get(origin) ?? 0) + time * scale)
}

// Fresh loads with an empty cache, profiled from navigation to network idle.
async function profileLoads(browser: Browser, url: string, originOfFrame: FrameOrigin): Promise<PageProfile> {
  const times = new Map<string, number>()
  const scripts = new Set<string>()

  for (let load = 0; load < LOADS; load++) {
    const context = await browser.newContext()
    const page = await context.newPage()
    const session = await context.newCDPSession(page)

    page.on('response', (response) => {
      if (response.request().resourceType() === 'script')
        scripts.add(basename(new URL(response.url()).pathname))
    })
    await startProfiler(session)
    await page.goto(url, { waitUntil: 'networkidle' })
    addTimes(times, timeByOrigin(await stopProfiler(session), originOfFrame), 1 / 1000 / LOADS)
    await context.close()
  }

  return { times, scripts }
}

async function profileOperations(browser: Browser, url: string, originOfFrame: FrameOrigin): Promise<OperationProfile[]> {
  const results: OperationProfile[] = []

  for (const operation of OPERATIONS) {
    const times = new Map<string, number>()
    let measured = 0

    for (let sample = 0; sample < SAMPLES; sample++) {
      const page = await openTable(browser, url, operation)
      const session = await page.context().newCDPSession(page)

      await startProfiler(session)
      measured += await timeClick(page, operation) / SAMPLES
      addTimes(times, timeByOrigin(await stopProfiler(session), originOfFrame), 1 / 1000 / SAMPLES)
      await page.close()
    }

    results.push({ name: operation.name, measured, times })
  }

  return results
}

async function profileServer(): Promise<Map<string, number>> {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'ssr-profile.ts'), 'kay'], { stdout: 'pipe', stderr: 'inherit', env: { ...process.env, NODE_ENV: 'production' } })
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited])

  if (code !== 0)
    throw new Error('profiling kay\'s server rendering failed')

  return new Map(Object.entries(JSON.parse(output) as Record<string, number>))
}

function sum(values: Iterable<number>): number {
  let total = 0

  for (const value of values)
    total += value

  return total
}

function percent(part: number, whole: number): string {
  return `${whole === 0 ? 0 : Math.round(part / whole * 100)}%`
}

// Solid, kay and the app first, then the rest by weight.
function ordered(origins: Iterable<string>, weight: (origin: string) => number): string[] {
  const rest = [...new Set(origins)].filter(origin => !MAIN_ORIGINS.includes(origin)).sort((a, b) => weight(b) - weight(a))

  return [...MAIN_ORIGINS, ...rest]
}

function bytesSection(pages: { name: string, scripts: Set<string> }[], chunks: Map<string, Chunk>): string {
  const files = pages.map(page => [...page.scripts].map(script => chunks.get(script)?.pieces ?? []))
  const bytes = files.map(bytesByOrigin)
  const raw = files.map(pieces => sum(pieces.flat().map(piece => Buffer.byteLength(piece.text))))
  const gzip = files.map(pieces => sum(pieces.map(file => gzipSize(file.map(piece => piece.text).join('')))))
  const cell = (origin: string, page: number) => {
    const entry: OriginBytes = bytes[page]!.get(origin) ?? { raw: 0, gzipSaved: 0 }

    return [`${kilobytes(entry.raw)} (${percent(entry.raw, raw[page]!)})`, `${kilobytes(entry.gzipSaved)} (${percent(entry.gzipSaved, gzip[page]!)})`]
  }

  return table(
    ['', ...pages.flatMap(page => [`${page.name} raw`, `${page.name} gzip saved`])],
    [
      ...ordered(bytes.flatMap(page => [...page.keys()]), origin => bytes[0]!.get(origin)?.raw ?? 0).map(origin => [origin, ...pages.flatMap((_page, index) => cell(origin, index))]),
      ['**total**', ...pages.flatMap((_page, index) => [kilobytes(raw[index]!), `${kilobytes(gzip[index]!)} gzip`])],
    ],
  )
}

function timesSection(columns: { name: string, times: Map<string, number> }[], format: (value: number) => string): string {
  const totals = columns.map(column => sum(column.times.values()))
  // An origin too small to show in any column is left out.
  const origins = ordered(columns.flatMap(column => [...column.times.keys()]), origin => sum(columns.map(column => column.times.get(origin) ?? 0)))
    .filter(origin => columns.some(column => Number(format(column.times.get(origin) ?? 0)) > 0))

  return table(
    ['', ...columns.map(column => column.name)],
    [
      ...origins.map(origin => [origin, ...columns.map((column, index) => `${format(column.times.get(origin) ?? 0)} (${percent(column.times.get(origin) ?? 0, totals[index]!)})`)]),
      ['**total**', ...totals.map(format)],
    ],
  )
}

function operationsSection(operations: OperationProfile[]): string {
  const others = [...new Set(operations.flatMap(operation => [...operation.times.keys()]))].filter(origin => !OPERATION_ORIGINS.includes(origin))
  const otherTime = (operation: OperationProfile) => sum(others.map(origin => operation.times.get(origin) ?? 0))

  return table(
    ['operation', 'measured (ms)', 'profiled (ms)', ...OPERATION_ORIGINS, 'other', `${SOLID} share`],
    operations.map((operation) => {
      const profiled = sum(operation.times.values())
      const solid = operation.times.get(SOLID) ?? 0

      return [
        operation.name,
        milliseconds(operation.measured),
        milliseconds(profiled),
        ...OPERATION_ORIGINS.map(origin => milliseconds(operation.times.get(origin) ?? 0)),
        milliseconds(otherTime(operation)),
        `**${percent(solid, profiled)}**`,
      ]
    }),
  )
}

async function packageVersion(name: string): Promise<string> {
  return (await Bun.file(join(import.meta.dir, '..', 'node_modules', name, 'package.json')).json() as { version: string }).version
}

async function commit(): Promise<string> {
  const head = (await Bun.$`git rev-parse --short HEAD`.cwd(import.meta.dir).text()).trim()
  const dirty = (await Bun.$`git status --porcelain -- ../src`.cwd(import.meta.dir).text()).trim() !== ''

  return dirty ? `${head} with uncommitted changes under src/` : head
}

console.error('server rendering')

const server = await profileServer()

console.error('building the client with source maps')

const chunks = await buildChunks()
const browser = await launch()

try {
  const app = await serve('kay', { KAY_BENCH_PREBUILT: '1' })

  try {
    const originOfFrame = browserOrigin(chunks)

    console.error('page loads')

    const products = await profileLoads(browser, app.url, originOfFrame)
    const tablePage = await profileLoads(browser, `${app.url}/table`, originOfFrame)

    console.error('table operations')

    const operations = await profileOperations(browser, app.url, originOfFrame)
    const markdown = [
      '# Where kay\'s bytes and time go',
      '',
      `- ${cpus()[0]?.model ?? 'unknown CPU'}, ${cpus().length} threads`,
      `- Bun ${Bun.version}, Chromium ${browser.version()} headless`,
      `- kay ${await commit()}, solid-js ${await packageVersion('solid-js')}, @solidjs/web ${await packageVersion('@solidjs/web')}`,
      `- run on ${new Date().toISOString().slice(0, 10)}`,
      '',
      `How much of what kay costs is Solid's, to weigh replacing its runtime and compiler. ${SOLID} is solid-js, @solidjs/signals, @solidjs/web and seroval; ${KAY} is kay's runtime and the entry it generates; ${APP} is the bench app's components as Solid's compiler wrote them and its shared data. Reproduce with \`bun run bench:origins\`; the cross-framework numbers are in results.md.`,
      '',
      '## JS shipped',
      '',
      'The client kay builds for production, every byte attributed through its source maps. Raw bytes add up to the files\' size; "gzip saved" is how much smaller the gzipped files get without that origin\'s bytes, so it does not add up to the total.',
      '',
      bytesSection([{ name: 'products', scripts: products.scripts }, { name: 'table', scripts: tablePage.scripts }], chunks),
      '',
      '## Server rendering',
      '',
      `Microseconds per render of the ${SSR_RENDERS_LABEL}, from Bun's CPU profiler over warm in-process renders. A native function, such as a string method, counts for the JavaScript that called it.`,
      '',
      timesSection([{ name: 'µs per render', times: server }], value => value.toFixed(0)),
      '',
      '## Page loads in Chromium',
      '',
      `Main-thread milliseconds per fresh load up to network idle, from Chromium's CPU profiler sampling every ${SAMPLING_INTERVAL_US} µs, means of ${LOADS} loads. A DOM call counts for the JavaScript that made it, so the time a replacement would still spend creating nodes is in Solid's share. ${ENGINE} is Chromium's own work outside any script: parsing, style, layout. ${INLINE} are the page's inline scripts.`,
      '',
      timesSection([{ name: 'products', times: products.times }, { name: 'table', times: tablePage.times }], milliseconds),
      '',
      '## Table operations in Chromium',
      '',
      `The operations of results.md, ${SAMPLES} profiled samples each, means in ms. "measured" is the click-to-DOM time as results.md times it, "profiled" the time the profiler saw over the same window. ${LAYOUT} is the work the timing forces with \`offsetHeight\` once the DOM holds the result: what Chromium spends laying out the rows, whoever made them.`,
      '',
      operationsSection(operations),
      '',
    ].join('\n')

    await Bun.write(join(import.meta.dir, 'origins.md'), markdown)
    console.log(markdown)
  }
  finally {
    app.stop()
  }
}
finally {
  await browser.close()
}
