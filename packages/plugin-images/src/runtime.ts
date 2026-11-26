// In-memory runtime image store, non-blocking Bun.spawn encoders, and build-phase task coordination for @kayjs/images.

import type { ServerPluginAPI } from '@kayjs/kay/config'
import { serviceKey } from '@kayjs/kay/config'

export interface RuntimeImagePayload {
  body: Uint8Array<ArrayBuffer> | string
  contentType: string
  etag: string
}

interface LazyEntry {
  resolved?: RuntimeImagePayload | undefined
  pending?: Promise<RuntimeImagePayload | undefined> | undefined
  load?: (() => Promise<RuntimeImagePayload | undefined>) | undefined
}

export interface RuntimeImageStore {
  setStatic(pathname: string, body: Uint8Array<ArrayBuffer> | string, contentType: string): void
  setLazy(pathname: string, load: () => Promise<RuntimeImagePayload | undefined>): void
  has(pathname: string): boolean
  serve(pathname: string, request: Request): Promise<Response | undefined>
}

export const RUNTIME_IMAGE_STORE_SERVICE = serviceKey<RuntimeImageStore>('kay.images.runtimeStore')

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
}

export function mimeForImageExt(ext: string): string {
  return IMAGE_MIME[ext.toLowerCase()] ?? 'application/octet-stream'
}

export function computeEtag(body: Uint8Array | string): string {
  return `W/"${Bun.hash(body).toString(36)}"`
}

function etagMatchesHeader(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch)
    return false
  const trimmed = ifNoneMatch.trim()
  if (trimmed === '*')
    return true
  const strip = (v: string) => (v.startsWith('W/') || v.startsWith('w/') ? v.slice(2) : v)
  const target = strip(etag)
  return trimmed.split(',').some(part => strip(part.trim()) === target)
}

export function createRuntimeImageStore(maxEntries = 256): RuntimeImageStore {
  const entries = new Map<string, LazyEntry>()

  function put(pathname: string, entry: LazyEntry): void {
    entries.delete(pathname)
    entries.set(pathname, entry)
    if (entries.size > maxEntries) {
      const oldest = entries.keys().next()
      if (!oldest.done)
        entries.delete(oldest.value)
    }
  }

  return {
    setStatic(pathname, body, contentType) {
      put(pathname, { resolved: { body, contentType, etag: computeEtag(body) } })
    },
    setLazy(pathname, load) {
      if (entries.has(pathname))
        return
      put(pathname, { load })
    },
    has(pathname) {
      return entries.has(pathname)
    },
    async serve(pathname, request) {
      const entry = entries.get(pathname)
      if (entry === undefined)
        return undefined
      // Refresh LRU position
      entries.delete(pathname)
      entries.set(pathname, entry)

      let payload = entry.resolved
      if (payload === undefined && entry.load !== undefined) {
        entry.pending ??= entry.load().then((res) => {
          if (res !== undefined) {
            entry.resolved = res
            entry.load = undefined
          }
          entry.pending = undefined
          return res
        }).catch(() => {
          entry.pending = undefined
          return undefined
        })
        payload = await entry.pending
      }
      if (payload === undefined)
        return undefined

      const headers: Record<string, string> = {
        'content-type': payload.contentType,
        'cache-control': 'public, max-age=31536000, immutable',
        'etag': payload.etag,
      }
      if (etagMatchesHeader(request.headers.get('if-none-match'), payload.etag))
        return new Response(null, { status: 304, headers })
      if (request.method === 'HEAD')
        return new Response(null, { status: 200, headers })
      return new Response(payload.body, { status: 200, headers })
    },
  }
}

export function registerRuntimeImageMiddleware(api: ServerPluginAPI, store: RuntimeImageStore): void {
  const serveRuntime = async (ctx: { request: Request, url: URL }, next: () => Promise<Response>): Promise<Response> => {
    if (ctx.request.method === 'GET' || ctx.request.method === 'HEAD') {
      const served = await store.serve(ctx.url.pathname, ctx.request)
      if (served !== undefined)
        return served
    }
    return next()
  }
  api.use(serveRuntime, { scope: '/og' })
  api.use(serveRuntime, { scope: '/img' })
}

// Build-phase coordination shared across native and bundled copies of @kayjs/images in the same process.
interface BuildPhaseState {
  activeOutDirs: Set<string>
  tasks: Map<string, Promise<void>[]>
}

const BUILD_STATE_KEY = Symbol.for('kay.images.buildState')

function buildState(): BuildPhaseState {
  const g = globalThis as Record<symbol, BuildPhaseState | undefined>
  return (g[BUILD_STATE_KEY] ??= { activeOutDirs: new Set(), tasks: new Map() })
}

export function enterBuildPhase(outDir: string): void {
  buildState().activeOutDirs.add(outDir)
}

export function leaveBuildPhase(outDir: string): void {
  const state = buildState()
  state.activeOutDirs.delete(outDir)
  state.tasks.delete(outDir)
}

export function isBuildPhase(outDir: string): boolean {
  return buildState().activeOutDirs.has(outDir)
}

export function queueBuildTask(outDir: string, task: Promise<void>): void {
  const state = buildState()
  let list = state.tasks.get(outDir)
  if (list === undefined) {
    list = []
    state.tasks.set(outDir, list)
  }
  list.push(task)
}

export async function flushBuildPhase(outDir: string): Promise<void> {
  const state = buildState()
  try {
    while (true) {
      const pending = state.tasks.get(outDir)
      if (pending === undefined || pending.length === 0)
        break
      state.tasks.set(outDir, [])
      await Promise.all(pending)
    }
  }
  finally {
    state.activeOutDirs.delete(outDir)
    state.tasks.delete(outDir)
  }
}

let magickCache: { path: string | undefined, available: boolean } | undefined
let rsvgCache: { path: string | undefined, available: boolean } | undefined

export function hasMagick(): boolean {
  const envPath = process.env.PATH
  if (magickCache === undefined || magickCache.path !== envPath)
    magickCache = { path: envPath, available: (envPath ?? '') !== '' && Bun.which('magick', { PATH: envPath! }) !== null }
  return magickCache.available
}

export function hasRsvgConvert(): boolean {
  const envPath = process.env.PATH
  if (rsvgCache === undefined || rsvgCache.path !== envPath)
    rsvgCache = { path: envPath, available: (envPath ?? '') !== '' && Bun.which('rsvg-convert', { PATH: envPath! }) !== null }
  return rsvgCache.available
}

/** Non-blocking SVG->PNG rasterization over stdin/stdout pipes (zero temp files, works on read-only FS). */
export async function rasterizeSvgToPngBytesAsync(svg: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (hasRsvgConvert()) {
    const proc = Bun.spawn(['rsvg-convert'], { stdin: new Response(svg), stdout: 'pipe', stderr: 'pipe' })
    const [exitCode, buf] = await Promise.all([proc.exited, new Response(proc.stdout).arrayBuffer()])
    if (exitCode === 0 && buf.byteLength > 8)
      return new Uint8Array(buf)
  }
  if (hasMagick()) {
    const proc = Bun.spawn(['magick', 'svg:-', 'png:-'], { stdin: new Response(svg), stdout: 'pipe', stderr: 'pipe' })
    const [exitCode, buf] = await Promise.all([proc.exited, new Response(proc.stdout).arrayBuffer()])
    if (exitCode === 0 && buf.byteLength > 8)
      return new Uint8Array(buf)
  }
  return undefined
}

/** Non-blocking image variant encoding via stdout pipe (zero temp files, works on read-only FS). */
export async function encodeVariantToBytesAsync(
  srcPath: string,
  width: number,
  format: 'avif' | 'webp',
  quality: number,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (!hasMagick())
    return undefined
  const proc = Bun.spawn(
    ['magick', `${srcPath}[0]`, '-auto-orient', '-strip', '-resize', `${width}x>`, '-quality', String(quality), `${format}:-`],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const [exitCode, buf] = await Promise.all([proc.exited, new Response(proc.stdout).arrayBuffer()])
  if (exitCode === 0 && buf.byteLength > 0)
    return new Uint8Array(buf)
  return undefined
}
