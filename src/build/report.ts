import type { ClientManifest } from '../server/client'
import { rename } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { ASSET_PREFIX } from './assets'

export interface Size {
  raw: number
  gzip: number
}

export interface IslandSize {
  // The island's `.kay` file, relative to the root.
  file: string
  // What it loads beyond the entry, the chunks it shares with other islands included.
  size: Size
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
  entry?: { size: Size, modules?: ModuleSize[] | undefined } | undefined
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
export async function sizeReport(root: string, dir: string, manifest: Omit<ClientManifest, 'styles'>, islands: Map<string, string>, inputs?: ChunkInputs): Promise<SizeReport> {
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
    report.entry = { size: await total(entryChunks), modules: modules(entryChunks) }

  for (const [id, chunks] of Object.entries(manifest.islands)) {
    const own = chunks.filter(chunk => !loaded.has(chunk))
    const file = islands.get(id)

    report.islands.push({ file: file === undefined ? id : relative(root, file).replaceAll('\\', '/'), size: await total(own), modules: modules(own) })
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
      const name = pkg === undefined && !path.startsWith('..') ? path : own.startsWith('..') ? pkg ?? path : `kay/${own.replaceAll('\\', '/')}`

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
  // How many pages the build prerendered for it; none when a server renders it per request.
  pages: number
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
  routes: Record<string, { js: number, css: number }>
}

export function storedReport(report: SizeReport | undefined, summary: BuildSummary, exported: boolean): StoredReport {
  return {
    version: 1,
    exported,
    entry: report?.entry?.size.gzip,
    islands: Object.fromEntries((report?.islands ?? []).map(island => [island.file, island.size.gzip])),
    routes: Object.fromEntries(summary.routes.map(route => [route.route, { js: route.js, css: route.css }])),
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
  const written = `${file}.${process.pid}.tmp`

  try {
    await Bun.write(written, JSON.stringify(stored))
    await rename(written, file)
  }
  catch {}
}

export interface ReportView {
  // Columns the terminal has; no line runs past it.
  width?: number | undefined
  previous?: StoredReport | undefined
}

const DEFAULT_WIDTH = 100
const SHOWN_ROUTES = 25

// The islands as `kay build` prints them, one line each, the heaviest first.
export function formatSizeReport(report: SizeReport, { width = DEFAULT_WIDTH, previous }: ReportView = {}): string {
  if (report.entry === undefined && report.islands.length === 0)
    return 'no JavaScript bundle: no page has an island'

  const compared = previous !== undefined
  const rows: [string, string, ModuleSize[] | undefined][] = [
    ...report.entry === undefined ? [] : [['entry, loaded by every page with an island', kilobytes(report.entry.size) + change(report.entry.size.gzip, previous?.entry, compared), report.entry.modules] satisfies [string, string, ModuleSize[] | undefined]],
    ...report.islands.map(island => [island.file, `+${kilobytes(island.size)}${change(island.size.gzip, previous?.islands[island.file], compared)}`, island.modules] satisfies [string, string, ModuleSize[] | undefined]),
  ]
  const room = Math.max(...rows.map(([, size]) => size.length))
  const names = Math.min(Math.max(...rows.map(([name]) => name.length)), Math.max(20, width - 4 - room))

  return [
    'JavaScript, gzip (minified):',
    ...rows.flatMap(([name, size, shown]) => [
      `  ${shorten(name, names).padEnd(names)}  ${size}`,
      // An island holding nothing but its own file says nothing more broken down.
      ...(shown !== undefined && shown.length > 1 ? shown : []).map(module => `      ${shorten(module.name, Math.max(20, width - 20))}  ${(module.bytes / 1024).toFixed(1)} KB`),
    ]),
  ].join('\n')
}

// One row per route, the heaviest first: its pattern, whether it was prerendered, and what it loads.
export function formatRouteTable(routes: RouteSize[], { width = DEFAULT_WIDTH, previous }: ReportView = {}): string {
  if (routes.length === 0)
    return ''

  const compared = previous !== undefined
  const ordered = routes.toSorted((a, b) => b.js + b.css - (a.js + a.css) || a.route.localeCompare(b.route))
  const shown = ordered.slice(0, SHOWN_ROUTES)
  const rows = shown.map((route) => {
    const before = previous?.routes[route.route]

    return [
      route.route,
      route.pages === 0 ? 'on request' : route.pages === 1 ? 'prerendered' : `prerendered x${route.pages}`,
      `${route.estimated ? '~' : ''}${kb(route.js)}${change(route.js, before?.js, compared)}`,
      `${kb(route.css)}${change(route.css, before?.css, compared)}`,
    ] as const
  })
  const header = ['route', 'rendered', 'JS', 'CSS'] as const
  const widths = [0, 1, 2, 3].map(column => Math.max(...[header, ...rows].map(row => row[column as 0].length)))
  const name = Math.min(widths[0]!, Math.max(12, width - widths[1]! - widths[2]! - widths[3]! - 8))
  const hidden = ordered.length - shown.length

  return [
    shorten('Routes, gzip (~: scripts it can load, no page prerendered):', width),
    ...[header, ...rows].map(row => `  ${shorten(row[0], name).padEnd(name)}  ${row[1].padEnd(widths[1]!)}  ${row[2].padStart(widths[2]!)}  ${row[3].padStart(widths[3]!)}`),
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

// Everything `kay build` prints after the build: the islands, the routes, the stages and the caches.
export function formatBuildReport(report: SizeReport | undefined, summary: BuildSummary, view: ReportView = {}): string {
  return [
    report === undefined ? '' : formatSizeReport(report, view),
    formatRouteTable(summary.routes, view),
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

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`
}

// The change since the last build as ` [+3.2 KB]`: nothing when it rounds to none or there was no build to compare to, `[new]` for what the last build did not have.
function change(bytes: number, before: number | undefined, compared: boolean): string {
  if (!compared)
    return ''

  if (before === undefined)
    return ' [new]'

  const delta = (bytes - before) / 1024

  if (Math.abs(delta) < 0.05)
    return ''

  return ` [${delta > 0 ? '+' : '-'}${Math.abs(delta).toFixed(1)} KB]`
}

function duration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`
}
