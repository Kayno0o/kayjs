import type { ClientManifest } from '../server/client'
import type { RouteFootprint } from './footprint'
import { join, relative, resolve } from 'node:path'
import { ASSET_PREFIX } from './assets'
import { writeAtomically } from './files'
import { ECOINDEX_VERSION, SWD_VERSION, VIEWPORT_WIDTH } from './footprint-models'

export interface Size {
  raw: number
  gzip: number
}

// Why a component is in the island list.
export interface IslandWhy {
  // What makes it an island, as `onClick, line 4`; for a static component that only becomes one when it passes an island a function, what may, as `onPick passed to Picker, line 8`.
  why?: string | undefined
  // The component renders as an island only when a page passes it what only an island sends, so a page may ship none of it.
  promoted?: boolean | undefined
}

export interface IslandSize extends IslandWhy {
  // The island's `.kay` file, relative to the root.
  file: string
  // What it loads beyond the entry, the chunks it shares with other islands included.
  size: Size
  // Those chunks' URLs, for a total over several islands to count a shared one once.
  chunks?: string[] | undefined
  // The modules weighing most in those chunks, with `kay build --analyze`.
  modules?: ModuleSize[] | undefined
}

export interface ModuleSize {
  // A file of the app relative to the root, or a package by name, its files summed.
  name: string
  // Minified, before compression.
  bytes: number
}

// What the browser loads for islands: the entry every page with one loads first, then each island's own chunks.
export interface SizeReport {
  entry?: { size: Size, chunks?: string[] | undefined, modules?: ModuleSize[] | undefined } | undefined
  islands: IslandSize[]
}

// What Bun's metafile says each output holds, by output path relative to the client directory.
export type ChunkInputs = Record<string, Record<string, { bytesInOutput?: number }>>

// Gzip at level 9 is the slowest part of measuring, so a file's size is kept by its content for the route table, which weighs the same chunks again.
const gzipped = new Map<string, number>()

export function gzipSize(bytes: Uint8Array<ArrayBuffer>): number {
  if (bytes.length === 0)
    return 0

  const key = `${bytes.length}:${Bun.hash(bytes).toString(36)}`
  let size = gzipped.get(key)

  if (size === undefined)
    gzipped.set(key, size = Bun.gzipSync(bytes, { level: 9 }).length)

  return size
}

const PACKAGE = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/
const KAY_ROOT = resolve(import.meta.dir, '../..')
const SHOWN_MODULES = 5

// Sizes read off the files the build wrote, gzip as most hosts serve them; `inputs` breaks each chunk down by module.
export async function sizeReport(root: string, dir: string, manifest: Omit<ClientManifest, 'styles'>, islands: Map<string, string>, why: Map<string, IslandWhy>, inputs?: ChunkInputs): Promise<SizeReport> {
  const sizes = new Map<string, Size>()
  const measure = async (url: string): Promise<Size> => {
    let size = sizes.get(url)

    if (size === undefined) {
      const file = Bun.file(join(dir, url.slice(ASSET_PREFIX.length)))
      // A URL the server answers itself, such as the public environment, has no file.
      const bytes = url.startsWith(ASSET_PREFIX) && await file.exists() ? await file.bytes() : new Uint8Array()

      sizes.set(url, size = { raw: bytes.length, gzip: gzipSize(bytes) })
    }

    return size
  }
  const total = async (urls: string[]): Promise<Size> => {
    const each = await Promise.all(urls.map(measure))

    return { raw: each.reduce((sum, size) => sum + size.raw, 0), gzip: each.reduce((sum, size) => sum + size.gzip, 0) }
  }
  const modules = (urls: string[]) => inputs === undefined ? undefined : heaviest(root, urls.map(url => inputs[url.slice(ASSET_PREFIX.length)] ?? {}))
  const entryChunks = manifest.entry === undefined ? [] : [manifest.entry, ...manifest.entryImports]
  const loaded = new Set(entryChunks)
  const report: SizeReport = { islands: [] }

  if (entryChunks.length > 0)
    report.entry = { size: await total(entryChunks), chunks: entryChunks, modules: modules(entryChunks) }

  for (const [id, chunks] of Object.entries(manifest.islands)) {
    const own = chunks.filter(chunk => !loaded.has(chunk))
    const file = islands.get(id)

    report.islands.push({ file: file === undefined ? id : relative(root, file).replaceAll('\\', '/'), size: await total(own), chunks: own, modules: modules(own), ...why.get(id) })
  }

  report.islands.sort((a, b) => b.size.gzip - a.size.gzip || a.file.localeCompare(b.file))

  return report
}

// The modules of some chunks by the bytes they add, a package's files counted as one.
function heaviest(root: string, chunks: Record<string, { bytesInOutput?: number }>[]): ModuleSize[] {
  const bytes = new Map<string, number>()

  for (const chunk of chunks) {
    for (const [input, { bytesInOutput = 0 }] of Object.entries(chunk)) {
      if (bytesInOutput === 0)
        continue

      // Named relative to the working directory, as Bun names them; kay's own runtime is shown file by file, as what an island reaches of it is what weighs.
      const file = resolve(input)
      const own = relative(KAY_ROOT, file)
      const path = relative(root, file).replaceAll('\\', '/')
      const pkg = PACKAGE.exec(path)?.[1]
      const outside = own.startsWith('..') ? pkg ?? path : `kay/${own.replaceAll('\\', '/')}`
      const name = pkg === undefined && !path.startsWith('..') ? path : outside

      bytes.set(name, (bytes.get(name) ?? 0) + bytesInOutput)
    }
  }

  return [...bytes].map(([name, size]) => ({ name, bytes: size })).sort((a, b) => b.bytes - a.bytes).slice(0, SHOWN_MODULES)
}

// What one route ships, gzip: the scripts and stylesheets its page loads.
export interface RouteSize {
  // The route's pattern, `/blog/:slug`.
  route: string
  js: number
  css: number
  // The islands its pages render, by file, as the prerendered pages show them; those its components can reach when no page was prerendered.
  islands: string[]
  // How many pages the build prerendered for it; none when a server renders it per request.
  pages: number
  // How many pages the build kept on its own, as nothing marked them, which a server serves as prerendered ones.
  kept: number
  // For a route rendered per request, what stopped the build from keeping it, as `src/routes/index.kay:3 reads Date`: set for a page the build looked at, not one that takes params and lists none.
  stop?: string | undefined
  // The scripts are what the route's components can load rather than what a rendered page did, as no page of it was prerendered.
  estimated: boolean
}

export interface StageTime {
  name: string
  ms: number
}

// What a cache answered from disk and what had to be made again.
export interface CacheCount {
  name: string
  cached: number
  made: number
}

// What the report says besides the island sizes.
export interface BuildSummary {
  routes: RouteSize[]
  footprints: RouteFootprint[]
  stages: StageTime[]
  caches: CacheCount[]
}

// The sizes a build keeps under `.kay` for the next one to show its change against.
export interface StoredReport {
  version: 1
  // A static export weighs differently from a server build, so only the same kind is compared.
  exported: boolean
  entry?: number | undefined
  islands: Record<string, number>
  // `estimated` when no page of the route was prerendered, so its scripts are what its components can load.
  routes: Record<string, { js: number, css: number, estimated?: boolean | undefined }>
}

export function storedReport(report: SizeReport | undefined, summary: BuildSummary, exported: boolean): StoredReport {
  return {
    version: 1,
    exported,
    entry: report?.entry?.size.gzip,
    islands: Object.fromEntries((report?.islands ?? []).map(island => [island.file, island.size.gzip])),
    routes: Object.fromEntries(summary.routes.map(route => [route.route, { js: route.js, css: route.css, estimated: route.estimated }])),
  }
}

export async function readStoredReport(file: string, exported: boolean): Promise<StoredReport | undefined> {
  try {
    const stored = await Bun.file(file).json() as StoredReport

    return stored.version === 1 && stored.exported === exported ? stored : undefined
  }
  catch {
    return undefined
  }
}

// Written aside and renamed, so a build interrupted while writing keeps the report before it.
export async function writeStoredReport(file: string, stored: StoredReport): Promise<void> {
  try {
    await writeAtomically(file, JSON.stringify(stored))
  }
  catch {}
}

export interface ReportView {
  // Columns the terminal has, which no line runs past; none when the output is no terminal, whose log has room for whole paths.
  width?: number | undefined
  previous?: StoredReport | undefined
}

const SHOWN_ROUTES = 25

// The islands as `kay build` prints them, one line each, the heaviest first.
export function formatSizeReport(report: SizeReport, { width = Infinity, previous }: ReportView = {}): string {
  if (report.entry === undefined && report.islands.length === 0)
    return 'no JavaScript bundle: no page has an island'

  const compared = previous !== undefined
  const rows: [string, string, ModuleSize[] | undefined, string | undefined][] = [
    ...report.entry === undefined ? [] : [['entry, loaded by every page with an island', kilobytes(report.entry.size) + change(report.entry.size.gzip, previous?.entry, compared), report.entry.modules, undefined] satisfies [string, string, ModuleSize[] | undefined, string | undefined]],
    ...report.islands.map(island => [island.file, `+${kilobytes(island.size)}${change(island.size.gzip, previous?.islands[island.file], compared)}`, island.modules, becauseOf(island)] satisfies [string, string, ModuleSize[] | undefined, string | undefined]),
  ]
  const room = Math.max(...rows.map(([, size]) => size.length))
  const names = Math.min(Math.max(...rows.map(([name]) => name.length)), Math.max(20, width - 4 - room))

  return [
    'JavaScript, gzip (minified):',
    ...rows.flatMap(([name, size, shown, because]) => [
      `  ${shorten(name, names).padEnd(names)}  ${size}`,
      ...because === undefined ? [] : [`      ${shorten(because, Math.max(20, width - 8))}`],
      // An island holding nothing but its own file says nothing more broken down.
      ...(shown !== undefined && shown.length > 1 ? shown : []).map(module => `      ${shorten(module.name, Math.max(20, width - 20))}  ${(module.bytes / 1024).toFixed(1)} KB`),
    ]),
  ].join('\n')
}

// Why a component is in the list, one line: what makes it an island, or for a static one what would.
function becauseOf(island: IslandSize): string | undefined {
  if (island.why === undefined)
    return undefined

  return island.promoted === true ? `static unless it passes an island what only an island sends: ${island.why}` : `an island because of ${island.why}`
}

// One row per route, the heaviest first: its pattern, whether it was prerendered, kept or rendered per request, and what it loads; a page rendered per request gets a line saying what stopped the build from keeping it.
export function formatRouteTable(routes: RouteSize[], { width = Infinity, previous }: ReportView = {}): string {
  if (routes.length === 0)
    return ''

  const compared = previous !== undefined
  const ordered = routes.toSorted((a, b) => b.js + b.css - (a.js + a.css) || a.route.localeCompare(b.route))
  const shown = ordered.slice(0, SHOWN_ROUTES)
  const rows = shown.map((route) => {
    const before = previous?.routes[route.route]

    return [
      route.route,
      pagesLabel(route.pages, route.kept),
      `${route.estimated ? '~' : ''}${kb(route.js)}${change(route.js, before?.js, compared)}`,
      `${kb(route.css)}${change(route.css, before?.css, compared)}`,
    ] as const
  })
  const header = ['route', 'rendered', 'JS', 'CSS'] as const
  const widths = [0, 1, 2, 3].map(column => Math.max(...[header, ...rows].map(row => row[column as 0].length)))
  const name = Math.min(widths[0]!, Math.max(12, width - widths[1]! - widths[2]! - widths[3]! - 8))
  const hidden = ordered.length - shown.length

  return [
    shorten('Routes, gzip (~: scripts it can load, no page rendered at build):', width),
    ...[header, ...rows].flatMap((row, index) => [
      `  ${shorten(row[0], name).padEnd(name)}  ${row[1].padEnd(widths[1]!)}  ${row[2].padStart(widths[2]!)}  ${row[3].padStart(widths[3]!)}`,
      ...index > 0 && shown[index - 1]!.stop !== undefined ? [`      ${shorten(`not kept: ${shown[index - 1]!.stop}`, Math.max(20, width - 8))}`] : [],
    ]),
    ...hidden > 0 ? [`  and ${hidden} more route${hidden === 1 ? '' : 's'}, lighter than these`] : [],
    // A route past the cap keeps the reason it was not kept, which is what the build is to tell.
    ...ordered.slice(shown.length).filter(route => route.stop !== undefined).map(route => `      ${shorten(`not kept: ${route.route}: ${route.stop}`, Math.max(20, width - 8))}`),
  ].join('\n')
}

// One row per route, the heaviest first: what a browser loads for its heaviest prerendered page, whole, with the DOM size, the request count, the EcoIndex grade and the carbon of a view; a route none of whose pages was prerendered is said to be unmeasured.
export function formatFootprintTable(footprints: RouteFootprint[], { width = Infinity }: ReportView = {}): string {
  if (footprints.length === 0)
    return ''

  const ordered = footprints.toSorted((a, b) => (b.footprint?.weight ?? -1) - (a.footprint?.weight ?? -1) || a.route.localeCompare(b.route))
  const shown = ordered.slice(0, SHOWN_ROUTES)
  const header = ['route', 'weight', 'requests', 'DOM', 'EcoIndex', 'gCO2e'] as const
  const rows = shown.map(({ route, footprint }) => footprint === undefined ? [route, '', '', '', '', ''] as const : [route, wholeSize(footprint.weight), String(footprint.requests), String(footprint.dom), `${footprint.grade} (${footprint.score})`, footprint.co2.toFixed(footprint.co2 < 0.1 ? 3 : 2)] as const)
  const widths = [0, 1, 2, 3, 4, 5].map(column => Math.max(...[header, ...rows].map(row => row[column as 0].length)))
  const name = Math.min(widths[0]!, Math.max(12, width - widths.slice(1).reduce((sum, each) => sum + each, 0) - 14))
  const note = (text: string) => `      ${shorten(text, Math.max(20, width - 8))}`
  const hidden = ordered.length - shown.length

  return [
    shorten(`Pages as a browser loads them (the heaviest prerendered page of each route; images read at ${VIEWPORT_WIDTH} px; EcoIndex ${ECOINDEX_VERSION}, Sustainable Web Design v${SWD_VERSION}; gCO2e per view):`, width),
    ...[header, ...rows].flatMap((row, index) => {
      const line = `  ${shorten(row[0], name).padEnd(name)}  ${row.slice(1).map((cell, column) => cell.padStart(widths[column + 1]!)).join('  ')}`

      if (index === 0)
        return [line]

      const { footprint, pages, path } = shown[index - 1]!

      if (footprint === undefined)
        return [`  ${shorten(row[0], name).padEnd(name)}  not measured: no page of it was prerendered`]

      const { parts, unweighed } = footprint
      const breakdown = Object.entries(parts).filter(([, bytes]) => bytes > 0).map(([part, bytes]) => `${part} ${wholeSize(bytes)}`).join(', ')

      return [line, note(`${breakdown}${pages > 1 ? `; heaviest of ${pages} pages, ${path}` : ''}${unweighed > 0 ? `; ${unweighed} request${unweighed === 1 ? '' : 's'} of unknown weight, not counted` : ''}`)]
    }),
    ...hidden > 0 ? [`  and ${hidden} more route${hidden === 1 ? '' : 's'}, lighter than these`] : [],
  ].join('\n')
}

// The stages with the time each took.
export function formatStages(stages: StageTime[]): string {
  if (stages.length === 0)
    return ''

  const width = Math.max(...stages.map(stage => stage.name.length))

  return ['Stages (the check and the bundle run side by side):', ...stages.map(stage => `  ${stage.name.padEnd(width)}  ${duration(stage.ms)}`)].join('\n')
}

export function formatCaches(caches: CacheCount[]): string {
  if (caches.length === 0)
    return ''

  const width = Math.max(...caches.map(cache => cache.name.length))

  return ['Caches under .kay/cache:', ...caches.map(cache => `  ${`${cache.name}:`.padEnd(width + 1)} ${cache.cached} cached, ${cache.made} made`)].join('\n')
}

const SHOWN_REMOVED = 10

// What the last build had and this one does not, which `[change]` cannot show as it only compares what is still there.
export function formatRemoved(report: SizeReport | undefined, summary: BuildSummary, previous: StoredReport | undefined, width = Infinity): string {
  if (previous === undefined)
    return ''

  const islands = new Set((report?.islands ?? []).map(island => island.file))
  const routes = new Set(summary.routes.map(route => route.route))
  const gone = [
    ...previous.entry !== undefined && report?.entry === undefined ? [{ kind: 'entry', name: 'loaded by every page with an island', gzip: previous.entry }] : [],
    ...Object.entries(previous.islands).filter(([file]) => !islands.has(file)).map(([file, gzip]) => ({ kind: 'island', name: file, gzip })),
    ...Object.entries(previous.routes).filter(([route]) => !routes.has(route)).map(([route, size]) => ({ kind: 'route', name: route, gzip: size.js + size.css })),
  ]

  if (gone.length === 0)
    return ''

  const hidden = gone.length - SHOWN_REMOVED

  return [
    'Removed since the last build:',
    ...gone.slice(0, SHOWN_REMOVED).map(each => `${shorten(`  ${each.kind.padEnd(6)}  ${each.name}`, Math.max(20, width - 16))}  was ${kb(each.gzip)}`),
    ...hidden > 0 ? [`  and ${hidden} more`] : [],
  ].join('\n')
}

// Everything `kay build` prints after the build: the islands, the routes, what went, the stages and the caches.
export function formatBuildReport(report: SizeReport | undefined, summary: BuildSummary, view: ReportView = {}): string {
  return [
    report === undefined ? '' : formatSizeReport(report, view),
    formatRouteTable(summary.routes, view),
    formatFootprintTable(summary.footprints, view),
    formatRemoved(report, summary, view.previous, view.width),
    formatStages(summary.stages),
    formatCaches(summary.caches),
  ].filter(part => part !== '').join('\n\n')
}

// Beyond `room` characters the middle goes, as a path's start and its end say most.
export function shorten(text: string, room: number): string {
  if (text.length <= room)
    return text

  const keep = room - 3
  const tail = Math.ceil(keep / 2)

  return `${text.slice(0, keep - tail)}...${text.slice(text.length - tail)}`
}

function kilobytes(size: Size): string {
  return `${kb(size.gzip)} (${(size.raw / 1024).toFixed(1)} KB)`
}

function pagesLabel(pages: number, kept: number): string {
  if (pages === 0 && kept > 0)
    return kept === 1 ? 'kept' : `kept x${kept}`

  if (pages === 0)
    return 'on request'

  return pages === 1 ? 'prerendered' : `prerendered x${pages}`
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`
}

function wholeSize(bytes: number): string {
  if (bytes < 1024)
    return `${bytes} B`

  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : kb(bytes)
}

// The change since the last build as ` [+3.2 KB]`: nothing when it rounds to none or there was no build to compare to, `[new]` for what the last build did not have.
function change(bytes: number, before: number | undefined, compared: boolean): string {
  if (!compared)
    return ''

  if (before === undefined)
    return ' [new]'

  const delta = (bytes - before) / 1024

  return Math.abs(delta) < 0.05 ? '' : ` [${delta > 0 ? '+' : '-'}${Math.abs(delta).toFixed(1)} KB]`
}

function duration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`
}
