import { join } from 'node:path'
import process from 'node:process'
import { plugin } from 'bun'
import { loadConfig } from '../config'

let registered: { root: string, settings: string } | undefined
// The plugin is imported when first registered, as it brings the compiler, which a compiled server, its pages bundled, never needs.
let ready: Promise<void> | undefined

// Lets this process import `.kay` files as server modules; the loader is global, so one process serves one project, with one set of library settings.
// Without `settings`, the project's `kay.config.ts` gives them, so whichever caller registers first renders libraries as the app configured them.
// Under `kay dev`, every element carries its source position for its inspector.
export async function registerLoader(root: string, settings?: Record<string, string>): Promise<void> {
  const chosen = settings ?? (await loadConfig(root)).settings ?? {}
  const key = JSON.stringify(Object.entries(chosen).sort(([a], [b]) => a.localeCompare(b)))

  if (registered === undefined) {
    registered = { root, settings: key }
    ready = (async () => {
      const { kay } = await import('../build/plugin')

      await plugin(kay({ target: 'ssr', root, cacheDir: join(root, '.kay', 'cache'), settings: chosen, inspect: underKayDev() }))
    })()
  }
  else if (registered.root !== root) {
    throw new Error(`kay: the .kay loader is registered for ${registered.root}; one process serves one project`)
  }
  else if (registered.settings !== key) {
    throw new Error(`kay: the .kay loader is registered with other library settings than ${JSON.stringify(chosen)}; one process renders libraries with one set`)
  }

  await ready
}

// A server `kay dev` started, which it tells how many changes came before it.
export function underKayDev(): boolean {
  return process.env.KAY_DEV_CODE !== undefined
}
