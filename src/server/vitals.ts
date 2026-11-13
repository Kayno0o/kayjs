import type { KayExtension } from '../config'
import type { Guard } from '../runtime/core'
import type { GuardOption } from './lazy-guard'
import { KayError } from '../compiler/errors'
import { BASE_PATH } from './base'
import { isGuardOption, joinGuards } from './lazy-guard'

export type { GuardOption, LazyGuard } from './lazy-guard'

export type { RouteVitals, VitalSummary } from './vitals-store'
export { vitalsReport } from './vitals-store'
export type { VitalsStore } from './vitals-store'

export interface VitalsOptions {
  // Where the numbers are shown, `/vitals` by default.
  prefix?: string | undefined
  // Who may open the screen, such as kayjs-auth's `auth.guard({ require: 'admin' })`, a list of guards run in order, or `{ load }` returning one, which runs on the first request rather than as kay.config.ts loads. Without one the screen stays closed, though the numbers are still collected; `false` opens it to everyone.
  guard?: GuardOption | false | undefined
  // `true` waits for the visitor's yes on the `kay_analytics` cookie before a view is reported and `false` never waits. Left out, the numbers follow `analytics({ awaitConsent })` when the site has it, and are reported at once otherwise, as they hold no identifier.
  awaitConsent?: boolean | undefined

}

export const VITALS_PATH = '/_kay/vitals'
export const VITALS_SCRIPT_PATH = `${VITALS_PATH}.js`

const DEFAULT_PREFIX = '/vitals'

const open: Guard = () => undefined

function guardOf(guard: GuardOption | false | undefined): Guard | undefined {
  if (guard === undefined)
    return undefined

  return guard === false ? open : joinGuards(guard)
}

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
  const { prefix = DEFAULT_PREFIX, guard } = options
  const { awaitConsent } = options
  const refuse = (reason: string): never => {
    throw new KayError('config-invalid', `kay: vitals ${reason}`)
  }

  if ('consent' in options)
    refuse('takes awaitConsent, not consent, which 1.103 dropped')

  if (typeof prefix !== 'string' || !BASE_PATH.test(prefix) || prefix === '/_kay' || prefix.startsWith('/_kay/'))
    refuse(`takes a prefix such as '/vitals', a path with no trailing slash outside /_kay; got ${JSON.stringify(prefix)}`)

  if (awaitConsent !== undefined && typeof awaitConsent !== 'boolean')
    refuse(`takes awaitConsent as true or false; got ${JSON.stringify(awaitConsent)}`)

  if (guard !== undefined && guard !== false && !isGuardOption(guard))
    refuse('takes a guard that is a function, a list of them, or { load } returning one, or false')

  current = { guard: guardOf(guard) }

  return {
    name: 'kay/vitals',
    needsServer: true,
    server: async () => (await import('./vitals-server')).vitalsServer(options),
    routes: { dir: `${import.meta.dir}/vitals-routes`, prefix },
    config: { head: [{ tag: 'script', props: { src: VITALS_SCRIPT_PATH, defer: true } }] },
  }
}
