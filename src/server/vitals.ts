import type { KayExtension } from '../config'
import type { Guard } from '../runtime/core'
import { KayError } from '../compiler/errors'
import { BASE_PATH } from './base'

export type { RouteVitals, VitalSummary } from './vitals-store'
export { memoryVitals, sqliteVitals, vitalsReport } from './vitals-store'
export type { VitalsStore } from './vitals-store'

// A guard built when the first request reaches it, so kay.config.ts imports nothing of the app's auth or database: `{ load: async () => (await import('./src/auth')).auth.guard({ require: 'admin' }) }`.
export interface LazyGuard {
  load: () => Guard | Promise<Guard>
}

export interface VitalsOptions {
  // Where the numbers are shown, `/vitals` by default.
  prefix?: string | undefined
  // Who may open the screen, such as kayjs-auth's `auth.guard({ require: 'admin' })`, or `{ load }` returning it, which runs on the first request rather than as kay.config.ts loads. Without one the screen stays closed, though the numbers are still collected.
  guard?: Guard | LazyGuard | undefined
  // Waits for the visitor's yes on the `kay_analytics` cookie before a view is reported. Left out, the numbers follow `analytics({ consent })` when the site has it, and are reported at once otherwise, as they hold no identifier.
  consent?: boolean | undefined
}

export const VITALS_PATH = '/_kay/vitals'
export const VITALS_SCRIPT_PATH = `${VITALS_PATH}.js`

const DEFAULT_PREFIX = '/vitals'

interface VitalsSettings {
  guard: Guard | undefined
}

let current: VitalsSettings = { guard: undefined }

// The settings the screen reads: what `vitals()` in kay.config.ts was given last.
export function vitalsSettings(): VitalsSettings {
  return current
}

// Reports the Web Vitals of real visitors from the app's own origin: a beacon of a few hundred bytes, loaded after the page, sends a view's LCP, CLS and INP once when the tab is hidden or a page swap replaces it, and the server keeps a 75th percentile per route over the last seven days in the app's `store.vitals`, shown under `prefix` behind `guard`.
// It sets no cookie and keeps neither an address nor a title: a view is counted in a bucket of its route.
// Only a production server (`NODE_ENV=production`) keeps a report: `kay dev` and a test answer the same and keep nothing.
export function vitals(options: VitalsOptions = {}): KayExtension {
  const { prefix = DEFAULT_PREFIX, guard, consent } = options
  const refuse = (reason: string): never => {
    throw new KayError('config-invalid', `kay: vitals ${reason}`)
  }

  if (typeof prefix !== 'string' || !BASE_PATH.test(prefix) || prefix === '/_kay' || prefix.startsWith('/_kay/'))
    refuse(`takes a prefix such as '/vitals', a path with no trailing slash outside /_kay; got ${JSON.stringify(prefix)}`)

  if (consent !== undefined && typeof consent !== 'boolean')
    refuse(`takes consent as true or false; got ${JSON.stringify(consent)}`)

  if (guard !== undefined && typeof guard !== 'function' && typeof (guard as { load?: unknown }).load !== 'function')
    refuse('takes a guard that is a function, or { load } returning one')

  current = { guard: guard === undefined ? undefined : lazily(guard) }

  return {
    name: 'kay/vitals',
    needsServer: true,
    server: async () => (await import('./vitals-server')).vitalsServer(options),
    routes: { dir: `${import.meta.dir}/vitals-routes`, prefix },
    config: { head: [{ tag: 'script', props: { src: VITALS_SCRIPT_PATH, async: true } }] },
  }
}

// A guard that loads on its first call, and tries again after a load that failed.
function lazily(guard: Guard | LazyGuard): Guard {
  if (typeof guard === 'function')
    return guard

  const { load: build } = guard
  let loaded: Promise<Guard> | undefined

  async function load(): Promise<Guard> {
    // Forgetting a failure must come after `loaded` is set, even when the loader throws at once.
    await Promise.resolve()

    try {
      return await build()
    }
    catch (error) {
      loaded = undefined

      throw error
    }
  }

  return async (ctx) => {
    loaded ??= load()

    return (await loaded)(ctx)
  }
}
