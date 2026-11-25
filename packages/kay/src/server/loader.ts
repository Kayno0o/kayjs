// Filesystem server loader: reads `dist/manifest.json` (or falls back to `--static` dir server) and loads built modules.

import type { BuildManifest } from '../build/index'
import type { KayConfig } from '../plugins/index'
import type { EmbeddedBody, KayApp, ServerOptions } from './http'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadConfig, resolveServerConfig } from '../plugins/index'
import { createServerFromEmbedded } from './index'
import { createStaticDirServer } from './static-dir'

let serverLoadSeq = 0

export async function createServer(options: ServerOptions): Promise<KayApp> {
  const root = resolve(options.root)
  const loadStamp = `${Date.now()}-${++serverLoadSeq}`
  const importModule = options.importModule ?? ((path: string) => import(`${path}?v=${loadStamp}`))
  const isDev = options.dev ?? (process.env.KAY_DEV === '1')

  // When a bundled `manifest.configFile` exists and plugins were not explicitly overridden,
  // load the bundled config module so it shares the exact same chunk instances as routes & actions.
  const initialOutDir = resolve(root, options.outDir ?? 'dist')
  const initialManifestPath = join(initialOutDir, 'manifest.json')
  let fileConfig: KayConfig
  let outDir: string
  let manifest: BuildManifest

  if (options.plugins === undefined && existsSync(initialManifestPath)) {
    outDir = initialOutDir
    manifest = JSON.parse(readFileSync(initialManifestPath, 'utf8')) as BuildManifest
    if (manifest.configFile !== undefined) {
      const cfgMod = await importModule(join(outDir, manifest.configFile))
      const loaded = (cfgMod.default ?? cfgMod) as KayConfig | undefined
      fileConfig = loaded !== undefined && typeof loaded === 'object' ? loaded : {}
    }
    else {
      fileConfig = await loadConfig(root)
    }
  }
  else {
    fileConfig = await loadConfig(root)
    outDir = resolve(root, options.outDir ?? fileConfig.outDir ?? 'dist')
    const manifestPath = join(outDir, 'manifest.json')
    if (!existsSync(manifestPath)) {
      const securityOpt = options.security ?? fileConfig.security
      const trustProxy = options.trustProxy ?? fileConfig.trustProxy ?? false
      if (existsSync(outDir) && readdirSync(outDir).length > 0) {
        return createStaticDirServer(
          outDir,
          options.assetPrefix ?? fileConfig.assetPrefix ?? '/_kay',
          securityOpt,
          (options.compress ?? fileConfig.compress) !== false,
          trustProxy,
          isDev,
        )
      }
      throw new Error(`kay server: missing ${manifestPath}. Run build() first.`)
    }
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BuildManifest
    if (options.plugins === undefined && manifest.configFile !== undefined) {
      const cfgMod = await importModule(join(outDir, manifest.configFile))
      const loaded = (cfgMod.default ?? cfgMod) as KayConfig | undefined
      if (loaded !== undefined && typeof loaded === 'object')
        fileConfig = loaded
    }
  }

  const runtimeConfig = resolveServerConfig(fileConfig, options)
  const clientDir = join(outDir, 'client')

  const modules: Record<string, unknown> = {}
  const assets: Record<string, EmbeddedBody> = {}
  const publicAssets: Record<string, EmbeddedBody> = {}
  const publicEtags: Record<string, string> = {}
  const prerenderedFiles: Record<string, string> = {}
  const srcPublicDir = resolve(root, fileConfig.publicDir ?? 'public')

  // Store file paths only (zero-copy Bun.file() serving, zero startup RAM bloat!)
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

  const loadMod = async (rel: string) => {
    if (!(rel in modules))
      modules[rel] = await importModule(join(outDir, rel))
  }

  for (const r of manifest.routes) {
    await loadMod(r.file)
    for (const l of r.layouts) await loadMod(l)
    for (const m of r.middlewares) await loadMod(m)
    if (r.prerendered) {
      for (const relHtml of Object.values(r.prerendered)) {
        const abs = join(outDir, relHtml)
        if (existsSync(abs))
          prerenderedFiles[relHtml] = abs
      }
    }
  }
  if (manifest.rootLayoutFile) await loadMod(manifest.rootLayoutFile)
  if (manifest.errorFile) await loadMod(manifest.errorFile)
  if (manifest.notFoundFile) await loadMod(manifest.notFoundFile)
  for (const a of manifest.actions) {
    await loadMod(a.file)
    for (const m of a.middlewares) await loadMod(m)
  }

  return createServerFromEmbedded({
    ...runtimeConfig,
    manifest,
    modules,
    assets,
    publicAssets,
    publicEtags,
    prerenderedFiles,
    root,
    outDir,
    publicDir: join(outDir, 'public'),
    dev: isDev,
  })
}
