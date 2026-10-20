import { openSqlite } from '../runtime/sqlite.server'
import { appStore } from './app-store'
import { onReload } from './reload'

export type Vital = 'lcp' | 'cls' | 'inp'

export const VITALS: readonly Vital[] = ['lcp', 'cls', 'inp']

// The days a number looks back over, today's included.
export const WINDOW_DAYS = 7
export const DAY_MS = 86_400_000

// One view's value for a metric, as the bucket it falls in.
export interface VitalReading {
  vital: Vital
  bucket: number
}

export interface VitalCount {
  route: string
  vital: Vital
  bucket: number
  count: number
}

// What the app keeps of the vitals visitors reported: a count per route, metric, bucket and day, so a replica adds its views to the others' with one increment and the store holds a fixed number of rows however many views come.
export interface VitalsStore {
  // Counts one view's readings for a route on a UTC day, the days since 1970.
  add: (route: string, readings: VitalReading[], day: number) => void | Promise<void>
  // The counts of every day from `since` on, summed over the days, in every process sharing the store.
  counts: (since: number) => VitalCount[] | Promise<VitalCount[]>
  // Stops what the store runs in the background and lets go of its file.
  close?: () => void
}

// A bucket is a tenth of a natural-log step wide, about 10 %: a percentile read from buckets is within 5 % of the true value, and a metric takes at most 112 of them.
const STEPS = 10

// The most a page can report: milliseconds, and the layout shift score. The buckets count CLS in thousandths, so the three metrics share them.
export const MAXIMUM: Record<Vital, number> = { lcp: 60_000, cls: 10, inp: 60_000 }

export function bucketOf(value: number): number {
  return Math.round(Math.log1p(value) * STEPS)
}

export function valueOf(bucket: number): number {
  return Math.expm1(bucket / STEPS)
}

export const GOOD: Record<Vital, number> = { lcp: 2500, cls: 100, inp: 200 }
export const POOR: Record<Vital, number> = { lcp: 4000, cls: 250, inp: 500 }

export type Rating = 'good' | 'needs-improvement' | 'poor'

export interface VitalSummary {
  // The 75th percentile over the window: milliseconds, or the layout shift score for `cls`.
  value: number
  views: number
  rating: Rating
}

export interface RouteVitals {
  route: string
  lcp?: VitalSummary | undefined
  cls?: VitalSummary | undefined
  inp?: VitalSummary | undefined
}

const MAX_KEYS = 50_000
const SEPARATOR = '\u0000'

// Counts kept in this process's memory, gone when it stops.
export function memoryVitals(): VitalsStore {
  const counts = new Map<string, number>()

  return {
    add(route, readings, day) {
      for (const [key] of counts) {
        if (Number(key.slice(0, key.indexOf(SEPARATOR))) >= day - WINDOW_DAYS)
          break

        counts.delete(key)
      }

      for (const { vital, bucket } of readings) {
        const key = [day, route, vital, bucket].join(SEPARATOR)
        const known = counts.get(key)

        // A key the routes and buckets cannot make would only come from a store misused, so the count stops rather than grows.
        if (known !== undefined || counts.size < MAX_KEYS)
          counts.set(key, (known ?? 0) + 1)
      }
    },
    counts(since) {
      const summed = new Map<string, VitalCount>()

      for (const [key, count] of counts) {
        const [day, route, vital, bucket] = key.split(SEPARATOR)

        if (Number(day) < since)
          continue

        const name = [route, vital, bucket].join(SEPARATOR)
        const entry = summed.get(name) ?? { route: route!, vital: vital as Vital, bucket: Number(bucket), count: 0 }

        entry.count += count
        summed.set(name, entry)
      }

      return [...summed.values()]
    },
  }
}

// Counts kept in a SQLite file every process of the machine opening it shares, one row per day, route, metric and bucket.
// The file is opened by the first call that needs it, so loading a config that names it, to build or check, creates nothing.
export function sqliteVitals(path: string): VitalsStore {
  let opened: VitalsStore | undefined
  let closed = false
  const open = (): VitalsStore => {
    if (closed)
      throw new Error('kay: the vitals store was closed')

    return opened ??= openVitals(path)
  }

  // A reload closes the file for the module that named the store, whichever module first used it; the module running again names a store of its own.
  onReload(() => opened?.close?.())

  return {
    add: async (route, readings, day) => open().add(route, readings, day),
    counts: async since => open().counts(since),
    close: () => {
      closed = true
      opened?.close?.()
    },
  }
}

function openVitals(path: string): VitalsStore {
  const db = openSqlite(path)

  db.run('CREATE TABLE IF NOT EXISTS kay_vitals (day INTEGER NOT NULL, route TEXT NOT NULL, vital TEXT NOT NULL, bucket INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (day, route, vital, bucket))')

  const add = db.query('INSERT INTO kay_vitals (day, route, vital, bucket, count) VALUES (?1, ?2, ?3, ?4, 1) ON CONFLICT (day, route, vital, bucket) DO UPDATE SET count = count + 1')
  const read = db.query<VitalCount, [number]>('SELECT route, vital, bucket, SUM(count) AS count FROM kay_vitals WHERE day >= ? GROUP BY route, vital, bucket')
  const prune = db.query('DELETE FROM kay_vitals WHERE day < ?')
  const write = db.transaction((route: string, readings: VitalReading[], day: number) => {
    for (const { vital, bucket } of readings)
      add.run(day, route, vital, bucket)
  })
  let pruned = -1

  return {
    add(route, readings, day) {
      // Once a day per process: what a day older than the window counted is of no use.
      if (day !== pruned) {
        pruned = day
        prune.run(day - WINDOW_DAYS)
      }

      write(route, readings, day)
    },
    counts: since => read.all(since),
    close: () => db.close(),
  }
}

let fallback: VitalsStore | undefined

// The app's `store.vitals`, else this process's memory.
export function vitalsStore(): VitalsStore {
  return appStore()?.vitals ?? (fallback ??= memoryVitals())
}

function rated(vital: Vital, value: number): Rating {
  if (value <= GOOD[vital])
    return 'good'

  return value <= POOR[vital] ? 'needs-improvement' : 'poor'
}

// The nearest-rank 75th percentile of buckets with their counts: the first bucket the running total reaches three quarters of the views at.
function percentile(buckets: Map<number, number>, views: number): number {
  const target = Math.ceil(views * 0.75)
  let seen = 0

  for (const bucket of [...buckets.keys()].toSorted((a, b) => a - b)) {
    seen += buckets.get(bucket)!

    if (seen >= target)
      return valueOf(bucket)
  }

  return 0
}

// Every route that has views in the window, with the 75th percentile of each metric it has, routes in name order.
export async function vitalsReport(now = Date.now()): Promise<RouteVitals[]> {
  const rows = await vitalsStore().counts(Math.floor(now / DAY_MS) - WINDOW_DAYS + 1)
  const byRoute = new Map<string, Map<Vital, Map<number, number>>>()

  for (const { route, vital, bucket, count } of rows) {
    const vitals = byRoute.get(route) ?? new Map<Vital, Map<number, number>>()
    const buckets = vitals.get(vital) ?? new Map<number, number>()

    buckets.set(bucket, (buckets.get(bucket) ?? 0) + count)
    vitals.set(vital, buckets)
    byRoute.set(route, vitals)
  }

  return [...byRoute].toSorted(([a], [b]) => a < b ? -1 : 1).map(([route, vitals]) => {
    const entry: RouteVitals = { route }

    for (const vital of VITALS) {
      const buckets = vitals.get(vital)

      if (buckets === undefined)
        continue

      const views = [...buckets.values()].reduce((sum, count) => sum + count, 0)
      const value = percentile(buckets, views)

      entry[vital] = { value: vital === 'cls' ? value / 1000 : value, views, rating: rated(vital, value) }
    }

    return entry
  })
}
