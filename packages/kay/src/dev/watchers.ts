// kay dev's file watchers: src/, the routes and public folders, the root's kay.config.ts, plugin watchPaths, and the folders of the files the last build read.

import type { FSWatcher } from 'node:fs'
import type { loadConfig } from '../plugins/index'
import { existsSync, realpathSync, statSync, watch } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isInNodeModules } from '../build/files'
import { createAppContext, resolvePlugins, runWithAppContext } from '../plugins/index'

export type ChangeKind = 'css' | 'code' | 'full' | 'config'

type KayConfig = Awaited<ReturnType<typeof loadConfig>>

// A source edit changes the bundled bytes; any other file (content, data, public/) may be read when a module loads.
const CODE_FILE_RE = /\.(?:[cm]?[jt]sx?|css)$/

export function srcChangeKind(name: string): ChangeKind {
  if (name.endsWith('.css') && !name.endsWith('.module.css'))
    return 'css'
  return CODE_FILE_RE.test(name) ? 'code' : 'full'
}

const isInsideDir = (parent: string, target: string): boolean =>
  target === parent || target.startsWith(`${parent}/`) || target.startsWith(`${parent}\\`)

export interface DevWatcherOptions {
  root: string
  devRoot: string
  srcDir: string
  routesDir: string | undefined
  schedule: (kind: ChangeKind) => void
}

export function createDevWatchers({ root, devRoot, srcDir, routesDir, schedule }: DevWatcherOptions) {
  const rootWatchers: FSWatcher[] = []
  const dirWatchers = new Map<string, FSWatcher>()
  const pluginWatchers: FSWatcher[] = []
  const graphWatchers = new Map<string, FSWatcher>()
  let activeRoutesDir = resolve(root, routesDir ?? 'src/routes')
  let activePublicDir = resolve(root, 'public')

  function isCoveredByStaticWatchers(dir: string): boolean {
    if (dir === root)
      return false
    for (const base of dirWatchers.keys()) {
      if (isInsideDir(base, dir))
        return true
    }
    return false
  }

  function syncStatic(cfg: KayConfig): void {
    activeRoutesDir = resolve(root, routesDir ?? cfg.routesDir ?? 'src/routes')
    activePublicDir = resolve(root, cfg.publicDir ?? 'public')
    const desired = new Map<string, (filename: string) => void>()
    if (existsSync(srcDir))
      desired.set(srcDir, name => schedule(srcChangeKind(name)))
    if (!isInsideDir(srcDir, activeRoutesDir) && existsSync(activeRoutesDir))
      desired.set(activeRoutesDir, name => schedule(srcChangeKind(name)))
    if (existsSync(activePublicDir))
      desired.set(activePublicDir, () => schedule('full'))
    for (const [dir, w] of dirWatchers) {
      if (!desired.has(dir)) {
        w.close()
        dirWatchers.delete(dir)
      }
    }
    for (const [dir, handler] of desired) {
      if (dirWatchers.has(dir))
        continue
      dirWatchers.set(dir, watch(dir, { recursive: true }, (_ev, filename) => {
        handler(typeof filename === 'string' ? filename : '')
      }))
    }
  }

  return {
    get publicDir(): string {
      return activePublicDir
    },
    syncStatic,

    refreshPlugins(cfg: KayConfig, assetPrefix: string): void {
      for (const w of pluginWatchers)
        w.close()
      pluginWatchers.length = 0
      const seen = new Set<string>(dirWatchers.keys())
      const watchCtx = createAppContext({ root, outDir: devRoot, publicDir: activePublicDir, assetPrefix, site: cfg.site, dev: true })
      for (const plugin of resolvePlugins(cfg.plugins)) {
        const paths = runWithAppContext(watchCtx, () =>
          typeof plugin.watchPaths === 'function' ? plugin.watchPaths(root) : (plugin.watchPaths ?? []))
        for (const p of paths) {
          const abs = resolve(root, p)
          if (seen.has(abs) || !existsSync(abs))
            continue
          seen.add(abs)
          const isDir = statSync(abs).isDirectory()
          pluginWatchers.push(watch(abs, isDir ? { recursive: true } : {}, () => schedule('full')))
        }
      }
    },

    syncBuild(watchedFiles: ReadonlySet<string>): void {
      const nextDirs = new Set<string>()
      let realRoot: string
      try {
        realRoot = realpathSync(root)
      }
      catch {
        realRoot = root
      }
      for (const file of watchedFiles) {
        if (isInNodeModules(file))
          continue
        if (isInsideDir(devRoot, file) || isInsideDir(join(root, '.kay-cache'), file))
          continue
        const dir = dirname(file)
        // Root is already watched non-recursively for `kay.config.ts`; skip if it's only kay.config.ts itself.
        if (dir === root || dir === realRoot) {
          if (file === join(root, 'kay.config.ts') || file === join(realRoot, 'kay.config.ts'))
            continue
        }
        if (isCoveredByStaticWatchers(dir))
          continue
        nextDirs.add(dir)
      }
      for (const [dir, watcher] of graphWatchers) {
        if (!nextDirs.has(dir)) {
          watcher.close()
          graphWatchers.delete(dir)
        }
      }
      for (const dir of nextDirs) {
        if (graphWatchers.has(dir) || !existsSync(dir))
          continue
        try {
          graphWatchers.set(dir, watch(dir, (_ev, filename) => {
            const name = typeof filename === 'string' ? filename : ''
            schedule(srcChangeKind(name))
          }))
        }
        catch (err) {
          console.warn(`[kay dev] could not watch ${dir}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    },

    // The root, non-recursively: kay.config.ts, and a public, routes or src folder created after startup.
    watchRoot(currentConfig: () => KayConfig): void {
      rootWatchers.push(watch(root, (_ev, filename) => {
        if (filename === 'kay.config.ts') {
          schedule('config')
          return
        }
        const changed = typeof filename === 'string' && filename !== '' ? resolve(root, filename) : undefined
        for (const dir of [activePublicDir, activeRoutesDir, srcDir]) {
          if (!dirWatchers.has(dir) && existsSync(dir) && (changed === undefined || isInsideDir(changed, dir))) {
            syncStatic(currentConfig())
            schedule(dir === activePublicDir ? 'full' : 'code')
            break
          }
        }
      }))
    },

    close(): void {
      for (const w of [...rootWatchers, ...dirWatchers.values(), ...pluginWatchers, ...graphWatchers.values()])
        w.close()
      rootWatchers.length = 0
      pluginWatchers.length = 0
      dirWatchers.clear()
      graphWatchers.clear()
    },
  }
}
