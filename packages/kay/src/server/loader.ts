// Filesystem server loader: reads `dist/manifest.json`, maps the built assets on disk, and starts the app from `dist/server/_entry.js` (or serves a `--static` dir).

import type { BuildManifest } from '../build/index'
import type { ServerEntry } from './app-entry'
import type { EmbeddedBody, KayApp, ServerOptions } from './http'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { SERVER_ENTRY_FILE } from '../build/server-entry'
import { loadConfig, resolveServerConfig } from '../plugins/index'
import { createStaticDirServer } from './static-dir'

let serverLoadSeq = 0

export async function createServer(options: ServerOptions): Promise<KayApp> {
  return (await startBuiltApp(options)).app
}

/** The app and the entry it was assembled from, whose bundled modules `testApp().import()` and the prerender step read. */
export async function startBuiltApp(options: ServerOptions): Promise<{ app: KayApp, entry?: ServerEntry | undefined }> {
  const built = await loadServerEntry(options)
  if (built.entry === undefined)
    return { app: await serveStaticDir(options, built.root, built.outDir) }
  const { root, outDir, manifest, entry } = built
  const clientDir = join(outDir, 'client')
  const assets: Record<string, EmbeddedBody> = {}
  const publicAssets: Record<string, EmbeddedBody> = {}
  const publicEtags: Record<string, string> = {}
  const prerenderedFiles: Record<string, string> = {}
  const srcPublicDir = resolve(root, entry.kayConfig.publicDir ?? 'public')

  // File paths only: Bun.file() serves them zero-copy, and nothing is read at startup.
  for (const rel of manifest.assets) {
    const abs = join(clientDir, rel)
    if (existsSync(abs)) {
      assets[rel] = abs
      if (existsSync(`${abs}.br`))
        assets[`${rel}.br`] = `${abs}.br`
      if (existsSync(`${abs}.gz`))
        assets[`${rel}.gz`] = `${abs}.gz`
    }
  }

  for (const rel of manifest.publicFiles ?? []) {
    const outAbs = join(outDir, 'public', rel)
    const abs = existsSync(outAbs) ? outAbs : join(srcPublicDir, rel)
    if (existsSync(abs)) {
      publicAssets[rel] = abs
      const st = statSync(abs)
      publicEtags[rel] = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`
    }
  }

  for (const r of manifest.routes) {
    for (const relHtml of Object.values(r.prerendered ?? {})) {
      const abs = join(outDir, relHtml)
      if (existsSync(abs))
        prerenderedFiles[relHtml] = abs
    }
  }

  const app = await entry.createApp({
    ...resolveServerConfig(undefined, options),
    manifest,
    assets,
    publicAssets,
    publicEtags,
    prerenderedFiles,
    root,
    outDir,
    publicDir: join(outDir, 'public'),
    dev: options.dev ?? (process.env.KAY_DEV === '1'),
    nodeEnv: options.nodeEnv,
    errorSink: options.errorSink,
  })
  return { app, entry }
}

type BuiltOutput =
  | { root: string, outDir: string, manifest: BuildManifest, entry: ServerEntry }
  | { root: string, outDir: string, entry?: undefined }

/** Finds the build output and imports its server entry; a `--static` export has none. */
async function loadServerEntry(options: ServerOptions): Promise<BuiltOutput> {
  const root = resolve(options.root)
  let outDir = resolve(root, options.outDir ?? 'dist')
  // kay.config.ts is read natively only to find an `outDir` it moved; the app itself runs from its bundled copy.
  if (options.outDir === undefined && !existsSync(join(outDir, 'manifest.json')))
    outDir = resolve(root, (await loadConfig(root, { dev: options.dev, nodeEnv: options.nodeEnv })).outDir ?? 'dist')
  const manifestPath = join(outDir, 'manifest.json')
  if (!existsSync(manifestPath)) {
    if (existsSync(outDir) && readdirSync(outDir).length > 0)
      return { root, outDir }
    throw new Error(`kay server: missing ${manifestPath}. Run build() first.`)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BuildManifest
  const entryPath = join(outDir, 'server', SERVER_ENTRY_FILE)
  if (!existsSync(entryPath))
    throw new Error(`kay server: missing ${entryPath}, the server entry kay build writes. Run kay build again.`)
  const stamp = `${Date.now()}-${++serverLoadSeq}`
  const importModule = options.importModule ?? ((path: string) => import(`${path}?v=${stamp}`))
  const entry = await importModule(entryPath) as unknown as ServerEntry
  return { root, outDir, manifest, entry }
}

async function serveStaticDir(options: ServerOptions, root: string, outDir: string): Promise<KayApp> {
  const config = await loadConfig(root, { dev: options.dev, nodeEnv: options.nodeEnv })
  return createStaticDirServer(
    outDir,
    options.assetPrefix ?? config.assetPrefix ?? '/_kay',
    options.security ?? config.security,
    (options.compress ?? config.compress) !== false,
    options.trustProxy ?? config.trustProxy ?? false,
    options.dev ?? (process.env.KAY_DEV === '1'),
  )
}
