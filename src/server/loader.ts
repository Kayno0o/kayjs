import { join } from 'node:path'
import process from 'node:process'
import { plugin } from 'bun'
import { loadConfig } from '../config'

// `early` when `kay dev` registered it ahead of the entry, guessing the project from the working directory and its `kay.config.ts`.
let registered: { root: string, settings: string, early: boolean } | undefined
// The plugin is imported when first registered, as it brings the compiler, which a compiled server, its pages bundled, never needs.
let ready: Promise<void> | undefined

// Lets this process import `.kay` files as server modules; the loader is global, so one process serves one project, with one set of library settings.
// Without `settings`, the project's `kay.config.ts` gives them, so whichever caller registers first renders libraries as the app configured them.
// Under `kay dev`, every element carries its source position for its inspector.
export async function registerLoader(root: string, settings?: Record<string, string>): Promise<void> {
  const chosen = settings ?? (await loadConfig(root)).settings ?? {}
  const key = JSON.stringify(Object.entries(chosen).sort(([a], [b]) => a.localeCompare(b)))

  if (registered?.early === true) {
    await ready

    // `pages()` names another project or other settings than `kay dev` guessed: the loader starts over with them, for the modules still to load.
    if (registered.root !== root || registered.settings !== key) {
      plugin.clearAll()
      registered = undefined
    }
    else {
      registered.early = false
    }
  }

  if (registered === undefined) {
    registered = { root, settings: key, early: false }
    ready = register(root, chosen)
  }
  else if (registered.root !== root) {
    throw new Error(`kay: the .kay loader is registered for ${registered.root}; one process serves one project`)
  }
  else if (registered.settings !== key) {
    throw new Error(`kay: the .kay loader is registered with other library settings than ${JSON.stringify(chosen)}; one process renders libraries with one set`)
  }

  await ready
}

// For `kay dev`: what the entry imports before it calls `pages()`, such as a mailer rendering `.kay` mails, loads as the app's pages do.
export async function registerEarlyLoader(root: string): Promise<void> {
  await registerLoader(root)

  registered!.early = true
}

async function register(root: string, settings: Record<string, string>): Promise<void> {
  const { kay } = await import('../build/plugin')

  await plugin(kay({ target: 'ssr', root, cacheDir: join(root, '.kay', 'cache'), settings, inspect: underKayDev() }))
}

// A server `kay dev` started, which it tells how many changes came before it.
export function underKayDev(): boolean {
  return process.env.KAY_DEV_CODE !== undefined
}
