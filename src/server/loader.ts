import { join } from 'node:path'
import { plugin } from 'bun'
import { kay } from '../build/plugin'
import { loadConfig } from '../config'

let registered: { root: string, settings: string } | undefined

// Lets this process import `.kay` files as server modules; the loader is global, so one process serves one project, with one set of library settings.
// Without `settings`, the project's `kay.config.ts` gives them, so whichever caller registers first renders libraries as the app configured them.
export async function registerLoader(root: string, settings?: Record<string, string>): Promise<void> {
  const chosen = settings ?? (await loadConfig(root)).settings ?? {}
  const key = JSON.stringify(Object.entries(chosen).sort(([a], [b]) => a.localeCompare(b)))

  if (registered === undefined) {
    plugin(kay({ target: 'ssr', root, cacheDir: join(root, '.kay', 'cache'), settings: chosen }))
    registered = { root, settings: key }
  }
  else if (registered.root !== root) {
    throw new Error(`kay: the .kay loader is registered for ${registered.root}; one process serves one project`)
  }
  else if (registered.settings !== key) {
    throw new Error(`kay: the .kay loader is registered with other library settings than ${JSON.stringify(chosen)}; one process renders libraries with one set`)
  }
}
