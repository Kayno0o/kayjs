// Native `kay.config.ts` load, for the build, check and dev steps that run beside the bundled app.

import type { AppRuntimeContext } from './context'
import type { KayConfig } from './types'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createAppContext, getAppContext, runWithAppContext } from './context'

let configReloadSeq = 0

// In dev the query follows the file content: a save elsewhere reuses the loaded config and its plugin instances instead of re-running every factory.
function configSpecifier(configPath: string, fresh: boolean): string {
  if (fresh)
    return `${configPath}?v=fresh-${++configReloadSeq}`
  if (process.env.KAY_DEV === '1')
    return `${configPath}?v=${Bun.hash(readFileSync(configPath)).toString(36)}`
  return configPath
}

export async function loadConfig(root: string, options?: { fresh?: boolean, appContext?: AppRuntimeContext }): Promise<KayConfig> {
  const absRoot = resolve(root)
  const configPath = join(absRoot, 'kay.config.ts')
  if (!existsSync(configPath))
    return {}
  const spec = configSpecifier(configPath, options?.fresh === true)
  const active = options?.appContext ?? getAppContext()
  const ctx = active !== undefined && active.root === absRoot
    ? active
    : createAppContext({
        root: absRoot,
        outDir: join(absRoot, 'dist'),
        publicDir: join(absRoot, 'dist', 'public'),
        assetPrefix: '/_kay',
        dev: process.env.KAY_DEV === '1',
      })
  const mod = await runWithAppContext(ctx, () => import(spec)) as { default?: KayConfig }
  return mod.default ?? {}
}
