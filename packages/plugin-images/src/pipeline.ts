// Variant encoding pipeline helpers shared by @kayjs/images build loader and Markdown image optimizer.

import type { ImageAsset } from './helpers'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { basename, extname, join } from 'node:path'

export const ALLOWED_IMAGE_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.avif',
  '.gif',
  '.svg',
  '.ico',
  '.bmp',
  '.tiff',
  '.tif',
])


// Bun runs every image's onLoad at once, so a limit per image multiplies: every magick call takes one of these slots, half the cores and at most 8 for the whole build.
export const ENCODE_SLOTS = Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2)))
// One thread and bounded memory each (magick spills to its disk cache past the limit), killed after two minutes.
const MAGICK_LIMITS = ['-limit', 'thread', '1', '-limit', 'memory', '512MiB', '-limit', 'map', '1GiB']
const MAGICK_TIMEOUT_MS = 120_000

// Resolved from the current PATH, as `hasMagick()` checks it: a bare `magick` would come from the PATH the process started with.
let magickBin: { path: string | undefined, bin: string } | undefined
function magickBinary(): string {
  const path = process.env.PATH
  if (magickBin === undefined || magickBin.path !== path)
    magickBin = { path, bin: Bun.which('magick', { PATH: path ?? '' }) ?? 'magick' }
  return magickBin.bin
}

let activeSlots = 0
const waitingForSlot: (() => void)[] = []

async function takeSlot(): Promise<void> {
  if (activeSlots < ENCODE_SLOTS) {
    activeSlots++
    return
  }
  // The caller releasing a slot hands it straight to the next in line.
  await new Promise<void>(resolve => waitingForSlot.push(resolve))
}

function releaseSlot(): void {
  const next = waitingForSlot.shift()
  if (next !== undefined)
    next()
  else
    activeSlots--
}

export interface MagickResult {
  ok: boolean
  stdout: Uint8Array<ArrayBuffer>
  /** Why it failed: magick's stderr, or the timeout. */
  error: string
}

/** Runs `magick <args>` in one of the build's slots, with its limits and timeout; stderr is read so a chatty run cannot fill the pipe and stall. */
export async function runMagick(args: readonly string[], stdin?: Response): Promise<MagickResult> {
  // A subcommand such as `identify` stays first, its options after it.
  const bin = magickBinary()
  const argv = args[0] === 'identify' ? [bin, 'identify', ...MAGICK_LIMITS, ...args.slice(1)] : [bin, ...MAGICK_LIMITS, ...args]
  await takeSlot()
  try {
    const proc = Bun.spawn(argv, { stdin: stdin ?? 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: MAGICK_TIMEOUT_MS, killSignal: 'SIGKILL' })
    const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text()])
    const error = proc.signalCode === 'SIGKILL' ? `timed out after ${MAGICK_TIMEOUT_MS / 1000} s` : stderr.trim()
    return { ok: exitCode === 0, stdout: new Uint8Array(stdout), error }
  }
  finally {
    releaseSlot()
  }
}

export interface CachedImageMeta {
  width: number
  height: number
  files: { rel: string, width: number, format: string }[]
}

export interface VariantEncodeJob {
  fileName: string
  cachedFile: string
  width: number
  format: 'avif' | 'webp'
  quality: number
}

export interface VariantPipelineConfig {
  widths: number[]
  formats: ('avif' | 'webp')[]
  quality: number
  avifQuality: number
  cachePrefix: string
}


// EXIF orientations 5 to 8, which `-auto-orient` turns a quarter.
const QUARTER_TURNS = new Set(['LeftTop', 'RightTop', 'RightBottom', 'LeftBottom'])

function parseMagickDimensions(stdout: string): { width: number, height: number } | undefined {
  const parts = stdout.trim().split(/\s+/)
  const w = Number(parts[0])
  const h = Number(parts[1])
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0)
    return undefined
  return QUARTER_TURNS.has(parts[2] ?? '') ? { width: h, height: w } : { width: w, height: h }
}

/** The size the variants will have, after `-auto-orient`, for a file whose header kay cannot read. */
export async function identifyImageAsync(filePath: string): Promise<{ width: number, height: number } | undefined> {
  const result = await runMagick(['identify', '-ping', '-format', '%w %h %[orientation]', `${filePath}[0]`])
  if (!result.ok)
    return undefined
  return parseMagickDimensions(new TextDecoder().decode(result.stdout))
}


export function writeFileAtomic(dstPath: string, data: string | Uint8Array): void {
  const tmpPath = `${dstPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  writeFileSync(tmpPath, data)
  try {
    renameSync(tmpPath, dstPath)
  }
  catch {
    rmSync(tmpPath, { force: true })
  }
}

function variantTmpPath(dstPath: string): string {
  const ext = extname(dstPath)
  const stem = ext !== '' ? dstPath.slice(0, -ext.length) : dstPath
  return `${stem}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}${ext}`
}

/**
 * Writes one format's variants of an image in a single `magick` run: the source is decoded and oriented once, kept as `mpr:src`, and each width resized from it.
 * A run that fails part way keeps the variants it wrote before failing, and warns with the widths it left out.
 */
async function encodeFormatAsync(srcPath: string, jobs: readonly VariantEncodeJob[]): Promise<void> {
  const tmpPaths = jobs.map(job => variantTmpPath(job.cachedFile))
  const result = await runMagick([
    `${srcPath}[0]`,
    '-auto-orient',
    '-strip',
    '-write',
    'mpr:src',
    '+delete',
    ...jobs.flatMap((job, i) => ['(', 'mpr:src', '-resize', `${job.width}x>`, '-quality', String(job.quality), '-write', tmpPaths[i]!, '+delete', ')']),
    'null:',
  ])
  // magick writes the variants in order, so after a failed run only the last file it wrote can be cut short.
  if (!result.ok) {
    const last = tmpPaths.findLastIndex(tmpPath => existsSync(tmpPath))
    if (last !== -1)
      rmSync(tmpPaths[last]!, { force: true })
  }
  const missing: number[] = []
  for (const [i, job] of jobs.entries()) {
    const tmpPath = tmpPaths[i]!
    if (existsSync(tmpPath)) {
      try {
        renameSync(tmpPath, job.cachedFile)
      }
      catch {
        rmSync(tmpPath, { force: true })
      }
    }
    if (!existsSync(job.cachedFile))
      missing.push(job.width)
  }
  if (missing.length > 0)
    console.warn(`@kayjs/images: magick could not encode ${srcPath} at ${missing.map(w => `${w}w`).join(', ')} (${jobs[0]!.format}), so those variants are left out: ${result.error || 'no output'}`)
}

/** Encodes the jobs not in the cache yet, one `magick` run per format, and returns every job whose file is now in the cache, in plan order. */
export async function encodeVariants(srcPath: string, jobs: readonly VariantEncodeJob[]): Promise<VariantEncodeJob[]> {
  const byFormat = new Map<VariantEncodeJob['format'], VariantEncodeJob[]>()
  for (const job of jobs) {
    if (existsSync(job.cachedFile))
      continue
    const group = byFormat.get(job.format)
    if (group === undefined)
      byFormat.set(job.format, [job])
    else
      group.push(job)
  }
  await Promise.all([...byFormat.values()].map(group => encodeFormatAsync(srcPath, group)))
  return jobs.filter(job => existsSync(job.cachedFile))
}

// Bumped when the same source and options give other variants or sizes, so a cache from before is not reused: 2 sizes photos after their EXIF orientation (#3676).
const VARIANT_CACHE_VERSION = 2

export function computeImageKey(srcPath: string, rawBytes: Uint8Array, cfg: VariantPipelineConfig): { hash: string, stem: string, rawFileName: string } {
  const ext = extname(srcPath).toLowerCase()
  const hash = Bun.hash(`${VARIANT_CACHE_VERSION}:${Bun.hash(rawBytes)}:${cfg.widths.join(',')}:${cfg.formats.join(',')}:${cfg.quality}:${cfg.avifQuality}`).toString(36)
  const stem = basename(srcPath, extname(srcPath)).toLowerCase().replace(/[^a-z0-9-_]/g, '-')
  return { hash, stem, rawFileName: `${stem}-${hash}${ext}` }
}

export function readCachedMeta(metaPath: string, cacheRoot: string, cachePrefix: string): CachedImageMeta | undefined {
  if (!existsSync(metaPath))
    return undefined
  try {
    const parsed = JSON.parse(readFileSync(metaPath, 'utf8')) as CachedImageMeta
    if (parsed.files.every(f => existsSync(join(cacheRoot, `${cachePrefix}${basename(f.rel)}`))))
      return parsed
  }
  catch {
    return undefined
  }
  return undefined
}

export function planVariantJobs(
  dims: { width: number, height: number },
  stem: string,
  hash: string,
  cacheRoot: string,
  cfg: VariantPipelineConfig,
): VariantEncodeJob[] {
  const targetWidths = cfg.widths.filter(w => w < dims.width)
  targetWidths.push(dims.width)
  const jobs: VariantEncodeJob[] = []
  for (const w of targetWidths) {
    for (const fmt of cfg.formats) {
      const fileName = `${stem}-${hash}-${w}w.${fmt}`
      jobs.push({
        fileName,
        cachedFile: join(cacheRoot, `${cfg.cachePrefix}${fileName}`),
        width: w,
        format: fmt,
        quality: fmt === 'avif' ? cfg.avifQuality : cfg.quality,
      })
    }
  }
  return jobs
}

export function assembleImageAsset(
  meta: CachedImageMeta,
  cacheRoot: string,
  cachePrefix: string,
  urlPrefix: string,
  emitVariant: (rel: string, fileName: string, cachedFile: string) => void,
): ImageAsset {
  const webpEntries: string[] = []
  const avifEntries: string[] = []
  let fallbackSrc = ''

  for (const f of meta.files) {
    const fileName = basename(f.rel)
    const cachedFile = join(cacheRoot, `${cachePrefix}${fileName}`)
    emitVariant(f.rel, fileName, cachedFile)
    const url = `${urlPrefix}/${f.rel}`
    if (f.format === 'webp') {
      webpEntries.push(`${url} ${f.width}w`)
      fallbackSrc = url
    }
    else if (f.format === 'avif') {
      avifEntries.push(`${url} ${f.width}w`)
      if (fallbackSrc === '')
        fallbackSrc = url
    }
  }

  return {
    src: fallbackSrc,
    width: meta.width,
    height: meta.height,
    ...(webpEntries.length > 0 ? { webpSrcset: webpEntries.join(', ') } : {}),
    ...(avifEntries.length > 0 ? { avifSrcset: avifEntries.join(', ') } : {}),
  }
}
