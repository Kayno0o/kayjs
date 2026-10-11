import type { ClientManifest } from '../server/client'
import { join, relative, resolve } from 'node:path'
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

      sizes.set(url, size = { raw: bytes.length, gzip: bytes.length === 0 ? 0 : Bun.gzipSync(bytes, { level: 9 }).length })
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

// The report as `kay build` prints it, one line per island, the heaviest first.
export function formatSizeReport(report: SizeReport): string {
  if (report.entry === undefined && report.islands.length === 0)
    return 'no JavaScript bundle: no page has an island'

  const rows: [string, string, ModuleSize[] | undefined][] = [
    ...report.entry === undefined ? [] : [['entry, loaded by every page with an island', kilobytes(report.entry.size), report.entry.modules] satisfies [string, string, ModuleSize[] | undefined]],
    ...report.islands.map(island => [island.file, `+${kilobytes(island.size)}`, island.modules] satisfies [string, string, ModuleSize[] | undefined]),
  ]
  const width = Math.max(...rows.map(([name]) => name.length))

  return [
    'JavaScript, gzip (minified):',
    ...rows.flatMap(([name, size, shown]) => [
      `  ${name.padEnd(width)}  ${size}`,
      // An island holding nothing but its own file says nothing more broken down.
      ...(shown !== undefined && shown.length > 1 ? shown : []).map(module => `      ${module.name}  ${(module.bytes / 1024).toFixed(1)} KB`),
    ]),
  ].join('\n')
}

function kilobytes(size: Size): string {
  return `${(size.gzip / 1024).toFixed(1)} KB (${(size.raw / 1024).toFixed(1)} KB)`
}
