import type { Database } from 'bun:sqlite'
import type { RedirectStatus } from './redirects'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { leavesSite } from '../runtime/base'
import { fillTarget, readRedirects, redirectLocation, redirectProblems } from './redirects'
import { withoutSlash } from './routes'

// The most redirects an editor adds: a lookup runs for every missing path, so the set stays small.
export const MAX_RUNTIME_REDIRECTS = 1000
const MAX_LENGTH = 512
const MAX_HOPS = 16
const UNSAFE = /[\p{Cc}\s\\]/u
const QUERY_OR_HASH = /[?#].*$/
const TRAILING_SLASHES = /\/+$/
const DYNAMIC = /[:*]/
const KAY_PREFIX = /^kay: /
const PARAM_SEGMENT = /:[A-Z_$][\w$]*/gi
const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g

// Why a redirect was not added, worded for the editor who asked: any other error is the store's, which they are not told.
export class RedirectRefusedError extends Error {}

/** @deprecated Renamed `RedirectRefusedError` in 1.70; the old name goes in 1.73. */
export const RedirectRefused = RedirectRefusedError
/** @deprecated Renamed `RedirectRefusedError` in 1.70; the old name goes in 1.73. */
export type RedirectRefused = RedirectRefusedError

// What a runtime row answers: a redirect's status, or 410 for a path that is gone for good, which has no target.
export type RuntimeStatus = RedirectStatus | 410

// A redirect an editor added while the site runs, in the same file as the paths visitors found nothing at.
export interface RuntimeRedirect {
  // As in `redirects` of kay.config.ts: `:name` for a segment, a final `*` for the rest.
  from: string
  // Empty for a 410.
  to: string
  status: RuntimeStatus
  addedAt: number
}

// What the app's config says about the redirects an editor may add.
export interface RuntimeRules {
  // The hosts other than the site's own a target may name, none by default.
  hosts: readonly string[]
  // The config's redirects, which win over the runtime ones and so count in a chain.
  configured: Record<string, string>
  // Every path the site serves, when the server knows them, to refuse a target nothing serves.
  served?: (() => string[]) | undefined
  // Runs every check, the capacity one included, and writes nothing.
  dryRun?: boolean | undefined
}

export interface RedirectSet {
  list: () => RuntimeRedirect[]
  find: (from: string) => RuntimeRedirect | undefined
  // Those with a `:name` or a final `*`.
  patterns: () => RuntimeRedirect[]
  // Every redirect held in memory, read again only when the file changed, for the lookup a missing path makes.
  snapshot: () => { exact: ReadonlyMap<string, RuntimeRedirect>, patterns: readonly RuntimeRedirect[] }
  add: (from: string, to: string, status: RuntimeStatus | undefined, rules: RuntimeRules) => RuntimeRedirect
  // Adds the redirect of a page that moved, as one write: the redirects leading to `from` lead to `to`, and the one from `to`, which exists again, is removed.
  move: (from: string, to: string, rules: RuntimeRules) => RuntimeRedirect
  remove: (from: string) => boolean
}

interface Row { path: string, target: string, status: number, added_at: number }

function entry(row: Row): RuntimeRedirect {
  return { from: row.path, to: row.target, status: row.status as RuntimeStatus, addedAt: row.added_at }
}

// The path as it is compared: no query, hash nor trailing slash.
export function plainPath(path: string): string {
  return withoutSlash(path.replace(QUERY_OR_HASH, '').replace(TRAILING_SLASHES, '')) || '/'
}

const NON_ASCII = /\P{ASCII}/gu
const PERCENT_ESCAPE = /%[\da-f]{2}/gi

// Non-ASCII text percent-encoded as a browser sends it, since a header carries ASCII alone: `/café` is `/caf%C3%A9`, and the escapes already there get their hex in upper case (`%c3%a9` is `%C3%A9`).
export function encoded(text: string): string {
  try {
    return text.replace(NON_ASCII, character => encodeURIComponent(character)).replace(PERCENT_ESCAPE, escape => escape.toUpperCase())
  }
  catch {
    throw new RedirectRefusedError('a path and a target are text, not broken characters')
  }
}

function isPattern(from: string): boolean {
  return DYNAMIC.test(from)
}

// Whether a target stays on the site, or names a host the app allows; throws, saying why, for anything else.
// `/\evil.example` and `//evil.example` are other hosts to a browser.
function checkTarget(to: string, hosts: readonly string[]): void {
  if (to === '' || to.length > MAX_LENGTH)
    throw new RedirectRefusedError(`a target is 1 to ${MAX_LENGTH} characters`)

  if (UNSAFE.test(to))
    throw new RedirectRefusedError('a target holds no control character, space nor backslash')

  if (to.startsWith('/')) {
    if (leavesSite(to))
      throw new RedirectRefusedError(`${to} is no target: it reads as another site's URL`)

    return
  }

  let url: URL

  try {
    url = new URL(to)
  }
  catch {
    throw new RedirectRefusedError(`${to} is no target: it starts with / or is an allowed site's URL`)
  }

  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '' || !hosts.includes(url.host.toLowerCase()))
    throw new RedirectRefusedError(`${to} is no target: only this site's paths and the hosts of runtimeRedirects.hosts in kay.config.ts are allowed`)
}

// Whether a location a redirect built stays where it may: the same checks as a target, on what a `*` or a param filled in.
export function safeLocation(location: string, hosts: readonly string[]): boolean {
  try {
    checkTarget(location, hosts)

    return true
  }
  catch {
    return false
  }
}

// Throws, saying why, unless `from` and `to` make a redirect that cannot loop and cannot leave the site but where the app allows.
function check(set: RedirectSet, from: string, to: string, status: number, rules: RuntimeRules): void {
  if (status !== 301 && status !== 302 && status !== 307 && status !== 308 && status !== 410)
    throw new RedirectRefusedError(`status ${String(status)} is none of 301, 302, 307, 308 and 410`)

  if (!from.startsWith('/') || from.startsWith('//') || from.length > MAX_LENGTH || UNSAFE.test(from))
    throw new RedirectRefusedError(`${from} is no path to redirect: it starts with one / and holds no control character, space nor backslash`)

  if (from.startsWith('/_kay/'))
    throw new RedirectRefusedError('the paths under /_kay/ are kay\'s')

  // Names the param or `*` a target uses without the path having it; a path that is gone has no target.
  try {
    if (status !== 410)
      checkTarget(to, rules.hosts)

    readRedirects({ [from]: status === 410 ? '/' : to })
  }
  catch (error) {
    throw new RedirectRefusedError(error instanceof Error ? error.message.replace(KAY_PREFIX, '') : String(error))
  }

  if (rules.configured[plainPath(from)] !== undefined)
    throw new RedirectRefusedError(`${from} is a redirect of kay.config.ts already`)

  if (status === 410)
    return

  const origin = plainPath(from)
  let at = to
  const seen = new Set<string>()

  // The target followed through the redirects that would answer it: back at the path is a loop, and a chain is as long as it goes.
  for (let hop = 0; at.startsWith('/') && hop <= MAX_HOPS; hop++) {
    const path = plainPath(at)

    if (path === origin)
      throw new RedirectRefusedError(`${from} to ${to} is a redirect loop`)

    if (seen.has(path))
      break

    seen.add(path)

    const row = set.find(path)

    if (row?.status === 410 && rules.configured[path] === undefined)
      throw new RedirectRefusedError(`${to} is gone (410): redirect to a page that exists`)

    const next = rules.configured[path] ?? row?.to

    if (next === undefined || isPattern(path))
      break

    at = next
  }

  if (rules.served) {
    const known = [...rules.served(), ...Object.keys(rules.configured), ...set.list().map(row => row.from)]
    const [problem] = redirectProblems({ [from]: to }, known)

    if (problem !== undefined)
      throw new RedirectRefusedError(`${problem}; redirect to a page that exists`)
  }
}

export function redirectSet(db: Database): RedirectSet {
  db.run('CREATE TABLE IF NOT EXISTS kay_redirects (path TEXT PRIMARY KEY, target TEXT NOT NULL, status INTEGER NOT NULL, pattern INTEGER NOT NULL, added_at INTEGER NOT NULL)')

  const all = db.query<Row, []>('SELECT path, target, status, added_at FROM kay_redirects ORDER BY added_at DESC, path')
  const one = db.query<Row, [string]>('SELECT path, target, status, added_at FROM kay_redirects WHERE path = ?')
  // The most specific first: the longest path, so `/docs/old/*` answers before `/docs/*`.
  const some = db.query<Row, []>('SELECT path, target, status, added_at FROM kay_redirects WHERE pattern = 1 ORDER BY length(path) DESC, path')
  const count = db.query<{ total: number }, []>('SELECT COUNT(*) AS total FROM kay_redirects')
  const insert = db.query('INSERT INTO kay_redirects (path, target, status, pattern, added_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (path) DO UPDATE SET target = ?2, status = ?3, pattern = ?4, added_at = ?5')
  const removed = db.query<{ path: string }, [string]>('DELETE FROM kay_redirects WHERE path = ? RETURNING path')
  // Changes when another connection commits, which is how an editor's `kay not-found` adding a redirect reaches a running server; this connection's own writes reset the copy.
  const version = db.query<{ data_version: number }, []>('PRAGMA data_version')
  let held: { at: number, exact: Map<string, RuntimeRedirect>, patterns: RuntimeRedirect[] } | undefined

  const set: RedirectSet = {
    list: () => all.all().map(entry),
    find(from) {
      const row = one.get(from)

      return row ? entry(row) : undefined
    },
    patterns: () => some.all().map(entry),
    snapshot() {
      const at = version.get()!.data_version

      if (held?.at !== at) {
        const rows = all.all().map(entry)

        held = { at, exact: new Map(rows.map(row => [row.from, row])), patterns: rows.filter(row => isPattern(row.from)).sort((a, b) => b.from.length - a.from.length || (a.from < b.from ? -1 : 1)) }
      }

      return held
    },
    add(rawFrom, rawTo, status = 307, rules) {
      // Checked and written in one write transaction, so two editors adding at once cannot make a loop between them.
      const write = db.transaction(() => {
        const to = status === 410 ? '' : encoded(rawTo)
        const from = encoded(rawFrom)

        check(set, from, to, status, rules)

        // The path as a visit is looked up: `/old/` and `/old?x=1` are `/old`.
        const key = plainPath(from)

        if (!one.get(key) && count.get()!.total >= MAX_RUNTIME_REDIRECTS)
          throw new RedirectRefusedError(`the set holds ${MAX_RUNTIME_REDIRECTS} redirects, the most there is room for: remove some, or move them to kay.config.ts`)

        const addedAt = Date.now()

        if (rules.dryRun !== true)
          insert.run(key, to, status, isPattern(key) ? 1 : 0, addedAt)

        return { from: key, to, status, addedAt }
      })

      held = undefined

      return write.immediate()
    },
    move(rawFrom, rawTo, rules) {
      const write = db.transaction(() => {
        const from = plainPath(encoded(rawFrom))
        const to = plainPath(encoded(rawTo))

        // Nothing answers the page that exists again, and a redirect from it would make the way back a loop.
        removed.get(to)

        for (const row of all.all().map(entry)) {
          if (row.status !== 410 && row.to.startsWith('/') && plainPath(row.to) === from)
            set.add(row.from, rawTo, row.status, rules)
        }

        return set.add(rawFrom, rawTo, undefined, rules)
      })

      held = undefined

      return write.immediate()
    },
    remove(from) {
      held = undefined

      return removed.get(from) !== null
    },
  }

  return set
}

interface Matcher {
  // Undefined for a path that cannot compile, which matches nothing.
  pattern: RegExp | undefined
  names: string[]
}

// The matcher of each pattern path, compiled once: a flood of missing paths would otherwise compile them for every one.
const matchers = new Map<string, Matcher>()

function matcherOf(from: string): Matcher {
  const known = matchers.get(from)

  if (known)
    return known

  const names: string[] = []
  const star = from.endsWith('/*')
  const body = (star ? from.slice(0, -2) : from).replace(REGEX_SPECIALS, '\\$&').replace(PARAM_SEGMENT, (part) => {
    names.push(part.slice(1))

    return '([^/]+)'
  })
  let pattern: RegExp | undefined

  // A path that cannot compile answers nothing, rather than throwing out of the lookup that serves a 404.
  try {
    pattern = new RegExp(`^${body}${star ? '(?:/(.*))?' : ''}$`)
  }
  catch {
    // The row answers nothing.
  }

  const matcher = { pattern, names }

  if (matchers.size >= MAX_RUNTIME_REDIRECTS)
    matchers.clear()

  matchers.set(from, matcher)

  return matcher
}

// Where an asked path goes, as `location`, when a redirect of the set answers it: an exact row first, then the first `:param` or `*` row it matches. Undefined when none does or the answer would leave where the rules allow, or send the visitor back to the path they asked.
// A path that is gone answers with an empty location and 410.
export function answerFor(set: RedirectSet, asked: string, search: string, hosts: readonly string[]): { location: string, status: RuntimeStatus } | undefined {
  const path = plainPath(asked)
  const { exact: byPath, patterns } = set.snapshot()
  const exact = byPath.get(path)
  let location: string | undefined
  let found = exact

  if (exact?.status === 410)
    return { location: '', status: 410 }

  if (exact) {
    location = redirectLocation(exact.to, search)
  }
  else {
    for (const row of patterns) {
      const matcher = matcherOf(row.from)
      const match = matcher.pattern?.exec(path)

      if (!match)
        continue

      if (row.status === 410)
        return { location: '', status: 410 }

      try {
        const params = new Map(matcher.names.map((name, index) => [name, decodeURIComponent(match[index + 1]!)]))
        const rest = match[matcher.names.length + 1] ?? ''

        location = redirectLocation(fillTarget(row.to, name => encodeURIComponent(params.get(name) ?? ''), rest), search)
        found = row

        break
      }
      catch {
        // A param that does not decode answers nothing.
        return undefined
      }
    }
  }

  if (!found || location === undefined || !safeLocation(found.to, hosts) || !safeLocation(location.replace(QUERY_OR_HASH, ''), hosts))
    return undefined

  // Two editors adding opposite redirects at once: the pair sends a visitor round, so neither answers.
  if (location.startsWith('/')) {
    const back = byPath.get(plainPath(location))

    if (back && !isPattern(back.from) && plainPath(back.to) === path)
      return undefined
  }

  return { location, status: found.status }
}

// The redirects a file holds, read without opening it for writing or creating anything: none for a file that is missing, has no such table or cannot be read.
export function readRuntimeRedirects(file: string): RuntimeRedirect[] {
  if (!existsSync(file))
    return []

  const sqlite = process.getBuiltinModule('bun:sqlite') as typeof import('bun:sqlite')
  let db: Database | undefined

  try {
    db = new sqlite.Database(file, { readonly: true })

    return db.query<Row, []>('SELECT path, target, status, added_at FROM kay_redirects ORDER BY path').all().map(entry)
  }
  catch {
    return []
  }
  finally {
    db?.close()
  }
}
