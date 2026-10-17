import type { Database } from 'bun:sqlite'
import type { Elysia } from 'elysia'
import type { LocaleSettings } from '../runtime/i18n'
import { localePath, splitLocale } from '../runtime/i18n'
import { openSqlite } from '../runtime/sqlite.server'
import { pathOf } from './log'
import { onReload } from './reload'
import { withoutSlash } from './routes'

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

const CONTROL_CHARACTERS = /\p{Cc}/u
const HTML_SUFFIX = /(?:\/index)?\.html?$/
const TRAILING_SLASHES = /\/+$/
// What scanners ask every site for, not a page anyone linked to: scripts and configuration of other stacks, dotfiles, the files a careless deploy leaves behind.
const SCANNED_FILE = /\.(?:php\d?|phtml|aspx?|jsp|cgi|env|sql|bak|ini|htaccess|htpasswd|git|svn|ds_store)(?:\/|$)/
const SCANNED_SEGMENT = /^(?:wp-[\w-]+|xmlrpc|phpmyadmin|pma|cgi-bin|vendor|boaform|actuator)$/

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
  close: () => void
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

  if (CONTROL_CHARACTERS.test(decoded) || scanned(decoded.toLowerCase()))
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
export function missingStore(path: string): MissingStore {
  const db: Database = openSqlite(path)

  db.run('CREATE TABLE IF NOT EXISTS kay_missing (path TEXT PRIMARY KEY, hits INTEGER NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, target TEXT, reason TEXT)')
  db.run('CREATE TABLE IF NOT EXISTS kay_missing_referrers (path TEXT NOT NULL, host TEXT NOT NULL, hits INTEGER NOT NULL, PRIMARY KEY (path, host))')

  const bump = db.query<{ hits: number, target: string | null }, [string, number]>('INSERT INTO kay_missing (path, hits, first_at, last_at) VALUES (?1, 1, ?2, ?2) ON CONFLICT (path) DO UPDATE SET hits = hits + 1, last_at = ?2 RETURNING hits, target')
  const count = db.query<{ total: number }, []>('SELECT COUNT(*) AS total FROM kay_missing')
  const known = db.query<{ hits: number }, [string]>('SELECT hits FROM kay_missing WHERE path = ?')
  const evict = db.query('DELETE FROM kay_missing WHERE path = (SELECT path FROM kay_missing ORDER BY hits, last_at LIMIT 1) RETURNING path')
  const orphans = db.query('DELETE FROM kay_missing_referrers WHERE path NOT IN (SELECT path FROM kay_missing)')
  const referrers = db.query<{ total: number }, [string]>('SELECT COUNT(*) AS total FROM kay_missing_referrers WHERE path = ?')
  const hasReferrer = db.query<{ hits: number }, [string, string]>('SELECT hits FROM kay_missing_referrers WHERE path = ? AND host = ?')
  const addReferrer = db.query('INSERT INTO kay_missing_referrers (path, host, hits) VALUES (?1, ?2, 1) ON CONFLICT (path, host) DO UPDATE SET hits = hits + 1')
  const suggested = db.query('UPDATE kay_missing SET target = ?2, reason = ?3 WHERE path = ?1')
  const rows = db.query<{ path: string, hits: number, first_at: number, last_at: number, target: string | null, reason: string | null }, []>('SELECT path, hits, first_at, last_at, target, reason FROM kay_missing ORDER BY hits DESC, last_at DESC')
  const hosts = db.query<{ path: string, host: string, hits: number }, []>('SELECT path, host, hits FROM kay_missing_referrers ORDER BY hits DESC, host')
  const removed = db.query('DELETE FROM kay_missing WHERE path = ?')
  const removedHosts = db.query('DELETE FROM kay_missing_referrers WHERE path = ?')

  // A reload runs the module that opened the store again, which opens its own.
  onReload(() => db.close())

  return {
    hit(path, referrer, suggest) {
      if (!known.get(path) && count.get()!.total >= MAX_PATHS) {
        evict.run()
        orphans.run()
      }

      const { hits, target } = bump.get(path, Date.now())!

      // A single hit may be a typo or a scanner's guess, so only a path asked for twice is worth the matching.
      if (hits === 2 && target === null) {
        const found = suggest(path)

        if (found)
          suggested.run(path, found.target, found.reason)
      }

      if (referrer !== undefined && (hasReferrer.get(path, referrer) || referrers.get(path)!.total < MAX_REFERRERS))
        addReferrer.run(path, referrer)
    },
    list() {
      const byPath = new Map<string, MissingPath['referrers']>()

      for (const { path, host, hits } of hosts.all())
        byPath.set(path, [...byPath.get(path) ?? [], { host, hits }])

      return rows.all().map(row => ({ path: row.path, hits: row.hits, firstAt: row.first_at, lastAt: row.last_at, target: row.target ?? undefined, reason: (row.reason ?? undefined) as Reason | undefined, referrers: byPath.get(row.path) ?? [] }))
    },
    forget(path) {
      removed.run(path)
      removedHosts.run(path)
    },
    close: () => db.close(),
  }
}

let current: MissingStore | undefined

// The paths counted so far by this process's server, for the tests of the server.
export function missingPaths(): MissingPath[] {
  return current?.list() ?? []
}

// Counts the pages a visitor asked for with a GET that answered 404, in production: the path without its query, the host of the referrer, never an address or a header.
// The file is opened by the first one, so a site nobody mistypes a URL of writes nothing.
export function countMissing<App extends Elysia>(app: App, options: { known: () => Iterable<string>, settings?: LocaleSettings | undefined, file?: string | undefined }): App {
  let suggest: ReturnType<typeof suggester> | undefined
  const file = options.file ?? (process.env.NODE_ENV === 'test' ? ':memory:' : NOT_FOUND_FILE)

  app.onAfterResponse({ as: 'global' }, ({ request, set, responseValue }) => {
    const status = responseValue instanceof Response ? responseValue.status : set.status
    const answered = responseValue instanceof Response ? responseValue.headers.get('content-type') : null

    if (status !== 404 || request.method !== 'GET' || answered?.includes('json') === true)
      return

    const path = countedPath(pathOf(request.url))

    if (path === undefined)
      return

    try {
      current ??= missingStore(file)
      current.hit(path, referrerHost(request.headers.get('referer')), (missing) => {
        suggest ??= suggester(options.known(), options.settings)

        return suggest(missing)
      })
    }
    catch {
      // Counting never costs a visitor their answer; a store that failed is opened again by the next one.
      current = undefined
    }
  })

  return app
}
