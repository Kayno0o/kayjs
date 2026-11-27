// Standalone `--static` directory server (used when `outDir` holds exported HTML without `manifest.json`): every file is listed once at startup, so a request is a map lookup.

import type { FSWatcher } from 'node:fs'
import type { KayApp, KayServer } from './http'
import type { SecurityHeadersOptions, TrustProxy } from './security'
import type { FileSource, ServedFile } from './served-file'
import { readdirSync, readFileSync, realpathSync, statSync, watch } from 'node:fs'
import { extname, join, posix, resolve } from 'node:path'
import { CompressionCache, isCompressibleType } from './compress'
import { applyHstsHeader, MIME } from './http'
import { buildSecurityHeaderEntries, inlineStyleHashes, KAY_ISLAND_STYLE_HASH, resolveCspPolicy, resolveHstsValue, withCspHashes } from './security'
import { createFileServer, servedFile } from './served-file'

const isRead = (request: Request): boolean => request.method === 'GET' || request.method === 'HEAD'

const isContained = (target: string, root: string): boolean =>
  target === root || target.startsWith(`${root}/`) || target.startsWith(`${root}\\`)

/** The files under `absRoot` by their path from it, `/`-separated; a symlink counts only when it lands on a file inside `realRoot`. */
function listFiles(absRoot: string, realRoot: string): Map<string, string> {
  const files = new Map<string, string>()
  let entries: string[]
  try {
    entries = readdirSync(absRoot, { recursive: true, encoding: 'utf8' })
  }
  catch (err) {
    console.error(`kay start: could not list ${absRoot}: ${err instanceof Error ? err.message : String(err)}`)
    return files
  }
  for (const rel of entries) {
    const abs = join(absRoot, rel)
    try {
      const real = realpathSync(abs)
      if (isContained(real, realRoot) && statSync(real).isFile())
        files.set(rel.replaceAll('\\', '/'), real)
    }
    catch {
      continue // a dangling symlink, or a file removed while listing
    }
  }
  return files
}

/** The request path a URL answers to: decoded, dot segments resolved, no leading or trailing slash; undefined when it cannot name a file. */
function requestedRel(pathname: string): string | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  }
  catch {
    return undefined
  }
  if (decoded.includes('\0'))
    return undefined
  return posix.normalize(`/${decoded}`).replace(/^\/+/, '').replace(/\/+$/, '')
}

export function createStaticDirServer(
  outDir: string,
  assetPrefix: string,
  security: SecurityHeadersOptions | false | undefined,
  compressEnabled: boolean,
  trustProxy: TrustProxy,
  isDev = false,
): KayApp {
  const prefix = assetPrefix.replace(/^\/+/, '').replace(/\/$/, '')
  const absRoot = resolve(outDir)
  let realRoot = absRoot
  try {
    realRoot = realpathSync(absRoot)
  }
  catch {
    realRoot = absRoot // listed as empty below, which answers 404s
  }
  const compressCache = compressEnabled ? new CompressionCache() : undefined
  const securityEntries = buildSecurityHeaderEntries(security)
  const securityRecord = Object.fromEntries(securityEntries)
  const baseCsp = resolveCspPolicy(security)
  const htmlCsp = baseCsp !== undefined ? withCspHashes(baseCsp, { styleHashes: [KAY_ISLAND_STYLE_HASH] }) : undefined
  const hstsValue = resolveHstsValue(security)
  const withHsts = hstsValue === undefined || isDev
    ? (res: Response) => res
    : (res: Response, req: Request) => applyHstsHeader(res, req, hstsValue, trustProxy, isDev)
  const serveFile = createFileServer({ compressEnabled, compressCache, withHsts })

  function entryFor(rel: string, path: string, all: ReadonlyMap<string, string>): ServedFile {
    const ext = extname(rel).toLowerCase()
    const type = MIME[ext] ?? 'application/octet-stream'
    const isHtml = ext === '.html' || ext === '.htm'
    // An exported page's CSP gains the hashes of its own `<style>` blocks.
    const csp = isHtml && htmlCsp !== undefined ? withCspHashes(htmlCsp, { styleHashes: inlineStyleHashes(readFileSync(path, 'utf8')) }) : undefined
    const sidecar = (ext: string): FileSource | undefined => {
      const at = compressEnabled ? all.get(`${rel}.${ext}`) : undefined
      return at === undefined ? undefined : { path: at }
    }
    return servedFile({
      key: `sd:${path}`,
      source: { path },
      headers: {
        ...securityRecord,
        ...(csp !== undefined ? { 'content-security-policy': csp } : {}),
        'content-type': type,
        'cache-control': prefix !== '' && rel.startsWith(`${prefix}/`) ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate',
      },
      compressible: compressEnabled && isCompressibleType(type),
      br: sidecar('br'),
      gz: sidecar('gz'),
    })
  }

  // Each file at its own path, then `x.html` at `x` and `x/index.html` at `x`, a real file always winning.
  function buildTable(): { table: Map<string, ServedFile>, notFound: ServedFile | undefined } {
    const files = listFiles(absRoot, realRoot)
    const table = new Map<string, ServedFile>()
    for (const [rel, path] of files)
      table.set(rel, entryFor(rel, path, files))
    for (const [rel, entry] of [...table]) {
      if (rel.endsWith('.html') && !table.has(rel.slice(0, -5)))
        table.set(rel.slice(0, -5), entry)
    }
    for (const [rel, entry] of [...table]) {
      if (rel === 'index.html' || rel.endsWith('/index.html')) {
        const dir = rel.slice(0, -'index.html'.length).replace(/\/$/, '')
        if (!table.has(dir))
          table.set(dir, entry)
      }
    }
    return { table, notFound: table.get('404.html') }
  }

  let current = buildTable()
  // A file written in place is listed again; a `kay build` swap replaces the whole app (`start.ts`).
  let timer: ReturnType<typeof setTimeout> | undefined
  let watcher: FSWatcher | undefined
  try {
    watcher = watch(absRoot, { recursive: true }, () => {
      clearTimeout(timer)
      timer = setTimeout(() => current = buildTable(), 20)
    })
    watcher.unref()
  }
  catch (err) {
    console.warn(`kay start: files changed in ${absRoot} will be served only after a restart: ${err instanceof Error ? err.message : String(err)}`)
  }

  const handle = async (req: Request): Promise<Response> => {
    if (!isRead(req))
      return withHsts(new Response('Method Not Allowed', { status: 405, headers: { ...securityRecord, allow: 'GET, HEAD' } }), req)
    const rel = requestedRel(new URL(req.url).pathname)
    const found = rel === undefined ? undefined : current.table.get(rel)
    if (found !== undefined)
      return serveFile(req, found)
    if (current.notFound !== undefined)
      return serveFile(req, current.notFound, 404)
    return withHsts(new Response('Not Found', { status: 404, headers: securityRecord }), req)
  }

  const error = (): Response => new Response('Internal Server Error', {
    status: 500,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...securityRecord },
  })

  return {
    handle,
    serve(port = 3000, hostname = '127.0.0.1') {
      return Bun.serve({ port, hostname, idleTimeout: 30, development: false, fetch: handle, error })
    },
    reloadInto(server: KayServer) {
      server.reload({ routes: {}, fetch: handle, error })
    },
    async dispose() {
      clearTimeout(timer)
      watcher?.close()
    },
  }
}
