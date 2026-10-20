import type { AnyElysia, Elysia } from 'elysia'
import type { VitalsOptions } from './vitals'
import type { Vital, VitalReading } from './vitals-store'
import process from 'node:process'
import { kayLog } from '../runtime/log'
import { isCrossSite } from './actions'
import { appStore } from './app-store'
import { routerPath } from './base'
import { declined } from './consent-cookie'
import { readCapped } from './errors'
import { clientAddress, overLimit } from './protection'
import { siteFacts } from './site-facts'
import { VITALS_PATH, VITALS_SCRIPT_PATH } from './vitals'
import { vitalsScript } from './vitals-script'
import { bucketOf, DAY_MS, MAXIMUM, vitalsStore } from './vitals-store'

// A report is a path and three numbers: past this it is no report.
const MAX_BODY_BYTES = 512
const MAX_PATH_LENGTH = 2048
const REPORTS_PER_MINUTE = 300
const MINUTE_MS = 60_000
const RATE_NAME = 'kay:vitals'
const LOCAL_PATH = /^\/(?!\/)[^?#\s\\]*$/
const READINGS: readonly [Vital, string][] = [['lcp', 'l'], ['cls', 'c'], ['inp', 'i']]

interface Report {
  path: string
  readings: VitalReading[]
}

// The script and the route taking a view's numbers.
// The plugin is a function so it knows the app it is used by, whose pages the reported paths are matched against.
export function vitalsServer(options: VitalsOptions): AnyElysia {
  warnWithoutStore()

  // The visitor's yes is awaited when the app says so or its analytics notice asks for it.
  const asking = (app: Elysia): boolean => options.consent === true || siteFacts(app)?.asksConsent === true
  const plugin = (app: Elysia) => app
    .get(VITALS_SCRIPT_PATH, () => new Response(vitalsScript(asking(app)), { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600' } }))
    .post(VITALS_PATH, async ({ request, server }) => {
      if (isCrossSite(request))
        return new Response(null, { status: 403 })

      if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES)
        return new Response(null, { status: 413 })

      if (overLimit(RATE_NAME, clientAddress(request, server), REPORTS_PER_MINUTE, MINUTE_MS) !== undefined)
        return new Response(null, { status: 429 })

      const text = await readCapped(request, MAX_BODY_BYTES)

      if (text === undefined)
        return new Response(null, { status: 413 })

      const report = readReport(text)

      if (report === undefined)
        return new Response(null, { status: 400 })

      const facts = siteFacts(app)

      // A development server, a test, a visitor who has not agreed where a yes is needed and one who opted out are answered as a counted view, as is a path no page serves, so nothing tells them apart.
      if (process.env.NODE_ENV === 'production' && !declined(request, asking(app))) {
        const route = facts?.pageRoute(routerPath(report.path, facts.base))

        if (route !== undefined)
          await vitalsStore().add(route, report.readings, Math.floor(Date.now() / DAY_MS))
      }

      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
    }, { parse: 'none' })

  return plugin as unknown as AnyElysia
}

// The numbers a browser reported, or undefined when anything is off: each is a finite, whole-or-not number within what a page can take, and at least one is there.
function readReport(text: string): Report | undefined {
  let body: Record<string, unknown>

  try {
    body = JSON.parse(text) as Record<string, unknown>
  }
  catch {
    return undefined
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return undefined

  const { p } = body

  if (typeof p !== 'string' || p.length > MAX_PATH_LENGTH || !LOCAL_PATH.test(p))
    return undefined

  const readings: VitalReading[] = []

  for (const [vital, key] of READINGS) {
    const value = body[key]

    if (value === undefined || value === null)
      continue

    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAXIMUM[vital])
      return undefined

    readings.push({ vital, bucket: bucketOf(vital === 'cls' ? value * 1000 : value) })
  }

  return readings.length === 0 ? undefined : { path: p, readings }
}

let warned = false

// Counts in this process's memory are lost at a restart and are not shared with another replica, which a production site is likely to want otherwise.
function warnWithoutStore(): void {
  if (warned || process.env.NODE_ENV !== 'production' || appStore()?.vitals !== undefined)
    return

  warned = true
  kayLog('warn', 'vitals: no store.vitals in kay.config.ts, so the numbers live in this process and start again at each restart; store: sqliteData(\'data/app.sqlite\') keeps them and adds up replicas')
}
