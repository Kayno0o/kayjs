import type { Database } from 'bun:sqlite'
import type { Elysia } from 'elysia'
import type { TrailingSlash } from '../config'
import type { LocaleSettings } from '../runtime/i18n'
import type { RedirectSet } from './runtime-redirects'
import { existsSync } from 'node:fs'
import { localePath, splitLocale } from '../runtime/i18n'
import { kayLog } from '../runtime/log'
import { openSqlite } from '../runtime/sqlite.server'
import { pathOf } from './log'
import { onReload } from './reload'
import { slashedPath, withoutSlash } from './routes'
import { redirectSet } from './runtime-redirects'

// Where the production server keeps the paths visitors asked for and found nothing at, next to the job store.
export const NOT_FOUND_FILE = 'data/not-found.sqlite'

// Past this many distinct paths, the least hit and oldest is forgotten for a new one, so a flood of made-up paths never grows the file nor pushes out a path real visitors keep coming to.
const MAX_PATHS = 1000
const MAX_REFERRERS = 8
const MAX_PATH_LENGTH = 512
const MAX_HOST_LENGTH = 253
// Fuzzy matching reads every known path, so only so many run a second.
const FUZZY_PER_SECOND = 20
const MAX_KNOWN = 5000
const SECOND_MS = 1000
const HOUR_MS = 3_600_000
// Hits wait this long in memory, then reach the file in one transaction, so a flood of missing paths costs the event loop one write, not four per request.
const FLUSH_MS = 1000
// The most distinct paths held back, past which the next one writes them all at once.
const MAX_PENDING = 256
// A path nobody asked for in this long is dropped with its referrers, as a made-up path can hold a name or an address.
const MAX_AGE_MS = 90 * 24 * HOUR_MS

const CONTROL_CHARACTERS = /\p{Cc}/u
const HTML_SUFFIX = /(?:\/index)?\.html?$/
const TRAILING_SLASHES = /\/+$/
// What scanners ask every site for, not a page anyone linked to: scripts and configuration of other stacks, dotfiles, the files a careless deploy leaves behind.
const SCANNED_FILE = /\.(?:php\d?|phtml|aspx?|jsp|cgi|env|sql|bak|ini|htaccess|htpasswd|git|svn|ds_store)(?:\/|$)/
const SCANNED_SEGMENT = /^(?:wp-[\w-]+|xmlrpc|phpmyadmin|pma|cgi-bin|boaform|actuator)$/
// What browsers and crawlers ask every site for, which a site without them is not missing a page for.
const DEFAULT_FILE = /^\/(?:favicon\.ico|robots\.txt|apple-touch-icon[\w-]*\.png)$/
const PARAM_SEGMENT = /:[A-Z_$][\w$]*/gi
const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g

export interface MissingPath {
  path: string
  hits: number
  firstAt: number
  lastAt: number
  // Where the path likely meant to go, and why that is thought.
  target?: string | undefined
  reason?: Reason | undefined
  // The hosts visitors came from, most first.
  referrers: { host: string, hits: number }[]
}

export type Reason = 'spelling' | 'locale' | 'slug' | 'similar'

export interface Suggestion {
  target: string
  reason: Reason
}

export interface MissingStore {
  hit: (path: string, referrer: string | undefined, suggest: (path: string) => Suggestion | undefined) => void
  list: () => MissingPath[]
  forget: (path: string) => void
  // The redirects an editor added, which share the file.
  redirects: RedirectSet
  close: () => void
}

// What a store holds back of a path: its hits since the last write, when they came, and the hosts they came from.
interface Pending {
  hits: number
  firstAt: number
  lastAt: number
  referrers: Map<string, number>
  suggest: (path: string) => Suggestion | undefined
}

// The writers of the stores open now, for the process to run as it exits and for a read of the file to run first.
const writers = new Set<() => void>()
let exitHooked = false

// Writes whatever the open stores hold back, so a read of their file sees every hit.
export function flushStores(): void {
  for (const write of writers) {
    try {
      write()
    }
    catch {
      // A store that cannot write fails its next hit, which tells of it.
    }
  }
}

// The path as it is counted: no trailing slash, so `/a` and `/a/` are one; undefined for one not worth keeping, a scanner's, too long, or not a path a visitor typed.
export function countedPath(pathname: string): string | undefined {
  if (pathname.length > MAX_PATH_LENGTH || !pathname.startsWith('/'))
    return undefined

  let decoded: string

  try {
    decoded = decodeURIComponent(pathname)
  }
  catch {
    return undefined
  }

  if (CONTROL_CHARACTERS.test(decoded) || DEFAULT_FILE.test(decoded.toLowerCase()) || scanned(decoded.toLowerCase()))
    return undefined

  const path = withoutSlash(pathname.replace(TRAILING_SLASHES, '')) || '/'

  return path.startsWith('/_kay/') ? undefined : path
}

function scanned(path: string): boolean {
  return SCANNED_FILE.test(path) || path.split('/').some(segment => SCANNED_SEGMENT.test(segment) || (segment.startsWith('.') && segment !== '.well-known' && segment.length > 1))
}

// The host a visit came from and nothing else of it: no path, query nor address.
export function referrerHost(header: string | null): string | undefined {
  if (header === null || header.length > 2048)
    return undefined

  try {
    const { protocol, host } = new URL(header)

    return (protocol === 'https:' || protocol === 'http:') && host !== '' && host.length <= MAX_HOST_LENGTH ? host.toLowerCase() : undefined
  }
  catch {
    return undefined
  }
}

// Where a missing path likely meant to go among the paths the site serves: the same page spelled another way, in another locale, under another parent with the same slug, or a near typo of a slug.
// What is not sure is not suggested.
export function suggester(known: Iterable<string>, settings?: LocaleSettings): (path: string) => Suggestion | undefined {
  const paths = [...known].slice(0, MAX_KNOWN).map(path => withoutSlash(path.replace(TRAILING_SLASHES, '')) || '/')
  let spelled: Map<string, string> | undefined
  let slugs: Map<string, string[]> | undefined
  let fuzzy: { at: number, count: number } = { at: 0, count: 0 }

  const index = () => {
    if (spelled && slugs)
      return { spelled, slugs }

    spelled = new Map()
    slugs = new Map()

    for (const path of paths) {
      spelled.set(simplified(path), path)

      const slug = lastSegment(path)
      const same = slugs.get(slug)

      if (same)
        same.push(path)
      else
        slugs.set(slug, [path])
    }

    return { spelled, slugs }
  }

  return (asked) => {
    const path = withoutSlash(asked.replace(TRAILING_SLASHES, '')) || '/'

    if (path === '/' || paths.length === 0)
      return undefined

    const { spelled, slugs } = index()
    const exact = spelled.get(simplified(path))

    if (exact === path)
      return undefined

    if (exact !== undefined)
      return { target: exact, reason: 'spelling' }

    if (settings && !settings.hosts) {
      const { path: bare } = splitLocale(settings, path)

      for (const locale of settings.locales) {
        const other = spelled.get(simplified(withoutSlash(localePath(settings, bare, locale))))

        if (other !== undefined && other !== path)
          return { target: other, reason: 'locale' }
      }
    }

    const slug = lastSegment(path)
    const same = (slugs.get(slug) ?? []).filter(other => other !== path)

    if (same.length === 1)
      return { target: same[0]!, reason: 'slug' }

    if (same.length > 1) {
      const parent = firstSegment(path)
      const near = same.filter(other => firstSegment(other) === parent)

      return near.length === 1 ? { target: near[0]!, reason: 'slug' } : undefined
    }

    const now = Date.now()

    if (now - fuzzy.at > SECOND_MS)
      fuzzy = { at: now, count: 0 }

    return fuzzy.count++ >= FUZZY_PER_SECOND ? undefined : similar(path, paths)
  }
}

function similar(path: string, paths: string[]): Suggestion | undefined {
  const slug = lastSegment(path)
  const depth = path.split('/').length
  const allowed = Math.max(1, Math.floor(slug.length / 4))
  let best: { path: string, distance: number } | undefined
  let tie = false

  if (slug.length < 4 || slug.length > 64)
    return undefined

  for (const other of paths) {
    const candidate = lastSegment(other)

    if (other === path || other.split('/').length !== depth || Math.abs(candidate.length - slug.length) > allowed)
      continue

    const distance = editDistance(slug, candidate, allowed)

    if (distance > allowed)
      continue

    if (best === undefined || distance < best.distance) {
      best = { path: other, distance }
      tie = false
    }
    else if (distance === best.distance) {
      tie = true
    }
  }

  return best && !tie ? { target: best.path, reason: 'similar' } : undefined
}

// The edits between two short texts, giving up (with a number past `limit`) once every way is over it.
function editDistance(a: string, b: string, limit: number): number {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index)

  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    let least = i

    for (let j = 1; j <= b.length; j++) {
      const value = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))

      next.push(value)
      least = Math.min(least, value)
    }

    if (least > limit)
      return limit + 1

    row = next
  }

  return row[b.length]!
}

function simplified(path: string): string {
  const lower = path.toLowerCase().replace(HTML_SUFFIX, '')

  return lower === '' ? '/' : lower
}

function lastSegment(path: string): string {
  const lower = simplified(path)

  return lower.slice(lower.lastIndexOf('/') + 1)
}

function firstSegment(path: string): string {
  const end = path.indexOf('/', 1)

  return end === -1 ? path.slice(1) : path.slice(1, end)
}

// The store in a SQLite file, so a restart or a deploy keeps the counts and the command reading them needs no server.
export function missingStore(path: string, closedByReload = true): MissingStore {
  const db: Database = openSqlite(path)

  db.run('CREATE TABLE IF NOT EXISTS kay_missing (path TEXT PRIMARY KEY, hits INTEGER NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, target TEXT, reason TEXT)')
  db.run('CREATE TABLE IF NOT EXISTS kay_missing_referrers (path TEXT NOT NULL, host TEXT NOT NULL, hits INTEGER NOT NULL, PRIMARY KEY (path, host))')

  const bump = db.query<{ hits: number, target: string | null }, [string, number, number, number]>('INSERT INTO kay_missing (path, hits, first_at, last_at) VALUES (?1, ?4, ?2, ?3) ON CONFLICT (path) DO UPDATE SET hits = hits + ?4, last_at = ?3 RETURNING hits, target')
  const count = db.query<{ total: number }, []>('SELECT COUNT(*) AS total FROM kay_missing')
  const known = db.query<{ hits: number }, [string]>('SELECT hits FROM kay_missing WHERE path = ?')
  const evict = db.query<{ path: string }, []>('DELETE FROM kay_missing WHERE path = (SELECT path FROM kay_missing ORDER BY hits, last_at LIMIT 1) RETURNING path')
  const referrers = db.query<{ total: number }, [string]>('SELECT COUNT(*) AS total FROM kay_missing_referrers WHERE path = ?')
  const hasReferrer = db.query<{ hits: number }, [string, string]>('SELECT hits FROM kay_missing_referrers WHERE path = ? AND host = ?')
  const addReferrer = db.query('INSERT INTO kay_missing_referrers (path, host, hits) VALUES (?1, ?2, ?3) ON CONFLICT (path, host) DO UPDATE SET hits = hits + ?3')
  const suggested = db.query('UPDATE kay_missing SET target = ?2, reason = ?3 WHERE path = ?1')
  const rows = db.query<{ path: string, hits: number, first_at: number, last_at: number, target: string | null, reason: string | null }, []>('SELECT path, hits, first_at, last_at, target, reason FROM kay_missing ORDER BY hits DESC, last_at DESC')
  const hosts = db.query<{ path: string, host: string, hits: number }, []>('SELECT path, host, hits FROM kay_missing_referrers ORDER BY hits DESC, host')
  const removed = db.query('DELETE FROM kay_missing WHERE path = ?')
  const removedHosts = db.query('DELETE FROM kay_missing_referrers WHERE path = ?')

  const aged = db.query('DELETE FROM kay_missing WHERE last_at < ?')
  const orphans = db.query('DELETE FROM kay_missing_referrers WHERE path NOT IN (SELECT path FROM kay_missing)')
  let purgedAt = 0

  // At most once an hour, and on opening, so a site nobody mistypes a URL of keeps nothing old and one that gets many hits pays one delete.
  const purge = (now: number): void => {
    if (now - purgedAt < HOUR_MS)
      return

    purgedAt = now
    aged.run(now - MAX_AGE_MS)
    orphans.run()
  }

  purge(Date.now())

  const redirects = redirectSet(db)

  const pending = new Map<string, Pending>()
  let timer: Timer | undefined
  // A write that failed in the background, which the next hit throws for the caller to tell of.
  let failure: unknown

  const record = db.transaction((batch: [string, Pending][]) => {
    for (const [path, { hits: seen, firstAt, lastAt, referrers: hosts, suggest }] of batch) {
      if (!known.get(path) && count.get()!.total >= MAX_PATHS) {
        const evicted = evict.get()

        if (evicted)
          removedHosts.run(evicted.path)
      }

      const { hits, target } = bump.get(path, firstAt, lastAt, seen)!

      // A single hit may be a typo or a scanner's guess, so only a path asked for twice is worth the matching.
      if (hits >= 2 && hits - seen < 2 && target === null) {
        const found = suggest(path)

        if (found)
          suggested.run(path, found.target, found.reason)
      }

      for (const [host, more] of hosts) {
        if (hasReferrer.get(path, host) || referrers.get(path)!.total < MAX_REFERRERS)
          addReferrer.run(path, host, more)
      }
    }
  })

  const flush = (): void => {
    clearTimeout(timer)
    timer = undefined

    if (pending.size === 0)
      return

    const batch = [...pending]

    pending.clear()
    purge(Date.now())
    record(batch)
  }

  writers.add(flush)

  if (!exitHooked) {
    exitHooked = true
    process.on('exit', flushStores)
  }

  const settle = (): void => {
    writers.delete(flush)

    try {
      flush()
    }
    catch {
      // The file goes away with its connection, the held hits with it.
    }

    db.close()
  }

  // A reload runs the module that opened the store again, which opens its own.
  if (closedByReload)
    onReload(settle)

  return {
    hit(path, referrer, suggest) {
      if (failure !== undefined) {
        const error = failure

        failure = undefined
        pending.clear()

        throw error
      }

      const now = Date.now()
      const held = pending.get(path)

      if (held) {
        held.hits += 1
        held.lastAt = now
        held.suggest = suggest
      }
      else {
        pending.set(path, { hits: 1, firstAt: now, lastAt: now, referrers: new Map(), suggest })
      }

      const hosts = pending.get(path)!.referrers

      if (referrer !== undefined && (hosts.has(referrer) || hosts.size < MAX_REFERRERS))
        hosts.set(referrer, (hosts.get(referrer) ?? 0) + 1)

      if (pending.size >= MAX_PENDING) {
        flush()
      }
      else if (timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined

          try {
            flush()
          }
          catch (error) {
            failure = error
          }
        }, FLUSH_MS)

        timer.unref()
      }
    },
    list() {
      flush()

      const byPath = new Map<string, MissingPath['referrers']>()

      for (const { path, host, hits } of hosts.all())
        byPath.set(path, [...byPath.get(path) ?? [], { host, hits }])

      return rows.all().map(row => ({ path: row.path, hits: row.hits, firstAt: row.first_at, lastAt: row.last_at, target: row.target ?? undefined, reason: (row.reason ?? undefined) as Reason | undefined, referrers: byPath.get(row.path) ?? [] }))
    },
    forget(path) {
      flush()
      removed.run(path)
      removedHosts.run(path)
    },
    redirects,
    close: settle,
  }
}

let current: MissingStore | undefined
// The requests a page route took, which are the only routes of the app whose 404 means a page is missing.
const pageRequests = new WeakSet<Request>()

export function pageRequested(request: Request): void {
  pageRequests.add(request)
}

// The store this process's server holds open, opened when `create` or the file exists: what a request for a missing path reads and counts in.
export function sharedStore(file: string, create: boolean): MissingStore | undefined {
  if (current)
    return current

  if (!create && file !== ':memory:' && !existsSync(file))
    return undefined

  current = missingStore(file)

  return current
}

// Closes the shared store after it failed, so the next request opens it again.
export function dropStore(): void {
  try {
    current?.close()
  }
  catch {
    // Closed already.
  }

  current = undefined
}

// The file the server keeps its store in: memory under test.
export function storeFile(file?: string): string {
  return file ?? (process.env.NODE_ENV === 'test' ? ':memory:' : NOT_FOUND_FILE)
}

export function isPageRequest(request: Request): boolean {
  return pageRequests.has(request)
}

// The paths counted so far by this process's server, for the tests of the server.
export function missingPaths(): MissingPath[] {
  return current?.list() ?? []
}

// Counts the pages a visitor asked for with a GET that answered 404, in production: the path without its query, the host of the referrer, never an address or a header.
// The file is opened by the first one, so a site nobody mistypes a URL of writes nothing.
export function countMissing<App extends Elysia>(app: App, options: { known: () => Iterable<string>, settings?: LocaleSettings | undefined, trailingSlash?: TrailingSlash | undefined, file?: string | undefined }): App {
  let suggest: ReturnType<typeof suggester> | undefined
  let told = false
  const file = storeFile(options.file)

  // Global, as a plugin's hook reaches the routes the app adds after it too: only what no route took, or a page route, is counted.
  app.onAfterResponse({ as: 'global' }, ({ request, set, responseValue, route }) => {
    const answered = responseValue instanceof Response ? responseValue : undefined
    const status = answered ? answered.status : set.status

    if (status !== 404 || request.method !== 'GET' || (route && !pageRequests.has(request)) || answered?.headers.get('content-type')?.includes('json') === true)
      return

    const path = countedPath(pathOf(request.url))

    if (path === undefined)
      return

    try {
      sharedStore(file, true)!.hit(path, referrerHost(request.headers.get('referer')), (missing) => {
        suggest ??= suggester(options.known(), options.settings)

        const found = suggest(missing)

        return found && { ...found, target: slashedPath(found.target, options.trailingSlash) }
      })
    }
    catch (error) {
      // Counting never costs a visitor their answer; a store that failed is opened again by the next one, and the first failure is told.
      dropStore()

      if (!told) {
        told = true
        kayLog('warn', `the paths visitors found nothing at cannot be recorded in ${file}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  })

  return app
}

// Whether a redirect of the config takes a path: `:name` stands for a segment, a final `*` for the rest.
export function answeredBy(redirects: string[]): (path: string) => boolean {
  const patterns = redirects.map((from) => {
    const star = from.endsWith('/*')
    const body = (star ? from.slice(0, -2) : from).replace(REGEX_SPECIALS, '\\$&').replace(PARAM_SEGMENT, '[^/]+')

    return new RegExp(`^${body}${star ? '(?:/.*)?' : ''}$`)
  })

  return path => patterns.some(pattern => pattern.test(path))
}

// The old paths of the `redirects` the running app serves, which the paths it lists leave out.
let redirected: string[] = []

export function knowRedirects(redirects: string[]): void {
  redirected = redirects
}

// The paths visitors found nothing at that no `redirects` entry answers, most hit first, for a library's screen: this process's store while it has one open, else the file the production server keeps (or `file`), which asking never creates.
export function unansweredPaths(file?: string): MissingPath[] {
  const answered = answeredBy(redirected)

  if (file === undefined && current)
    return current.list().filter(row => !answered(row.path))

  file ??= NOT_FOUND_FILE

  if (!existsSync(file))
    return []

  flushStores()

  const store = missingStore(file)

  try {
    return store.list().filter(row => !answered(row.path))
  }
  finally {
    store.close()
  }
}
