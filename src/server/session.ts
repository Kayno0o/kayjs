import type { Duration } from '../runtime/duration'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { parse, stringify } from 'devalue'
import { Elysia } from 'elysia'
import { KayError } from '../compiler/errors'
import { wholeSeconds } from '../runtime/duration'
import { kayLog } from '../runtime/log'
import { openSqlite } from '../runtime/sqlite.server'
import { overHttps } from './actions'
import { nodeCrypto } from './builtins'
import { requestCookies } from './cookies'
import { onReload } from './reload'
import { readPersonally } from './scope'
import { GENERATE_SECRET, MIN_SECRET_LENGTH, openWith, sealWith, weakSecrets } from './seal'
import { useStampSecret } from './stamp'

export type SessionData = Record<string, unknown>

// Where sessions live when the cookie only carries their id; each method may answer synchronously or with a promise.
export interface SessionStore {
  get: (id: string) => SessionData | undefined | Promise<SessionData | undefined>
  // `maxAge` in seconds: past it the store may forget the session.
  set: (id: string, data: SessionData, maxAge: number) => void | Promise<void>
  delete: (id: string) => void | Promise<void>
  // Deletes every session whose data `match` returns true for, such as a person's once they asked to be erased or their password changed, resolving with how many went.
  deleteWhere?: ((match: (data: SessionData) => boolean) => number | Promise<number>) | undefined
}

export type SameSite = 'lax' | 'strict' | 'none'

const SAME_SITE = new Set<unknown>(['lax', 'strict', 'none'])

export interface SessionOptions {
  // At least 32 characters, from the environment. A list rotates them: the first seals new cookies, every one opens old ones.
  secret: string | string[]
  // Defaults to `session`; over https and without `domain`, the cookie goes out as `__Host-session`.
  cookie?: string | undefined
  // How long a session lasts without being used, seconds or a string such as '30d', 30 days by default; one used past half of it is extended.
  maxAge?: Duration | undefined
  // How long a session lasts from its start or its last `regenerate()`, however much it is used, 90 days by default; no lifetime outlasts it.
  absoluteMaxAge?: Duration | undefined
  // How long a session whose cookie dies with the browser, through `lifetime('browser')`, lasts without being used, a day by default.
  browserMaxAge?: Duration | undefined
  // The parent domain sibling hosts share the session under, `example.com` for `app.example.com` and `auth.example.com`, the visited host or a parent of it; the cookie is the visited host's only without it.
  domain?: string | undefined
  // Whether the browser sends the cookie along a request another site starts, a link followed or a form posted from there: `'lax'` by default sends it on a link's navigation and not on a post; `'strict'` on neither, so a visitor following a link from elsewhere arrives signed out; `'none'` on all, for a site embedded in another's page, and always `Secure`, which browsers ask of it.
  sameSite?: SameSite | undefined
  // Keeps the data server-side, the cookie carrying only an id; without one the data travels sealed in the cookie, about 3.5 KB at most.
  store?: SessionStore | undefined
}

export interface Session<Data extends object> {
  get: <Key extends keyof Data>(key: Key) => Promise<Data[Key] | undefined>
  set: <Key extends keyof Data>(key: Key, value: Data[Key]) => Promise<void>
  unset: (key: keyof Data) => Promise<void>
  // Forgets the session and clears its cookie, for signing out.
  destroy: () => Promise<void>
  // Moves the data to a new id, for right after signing in, so an id planted before it is worth nothing.
  regenerate: () => Promise<void>
  // This session's own lifetime in place of `maxAge`, kept until it is destroyed, for "remember me": seconds or a string such as '90d', or 'browser' for a cookie the browser drops on closing, lasting `browserMaxAge` without being used.
  lifetime: (maxAge: Duration | 'browser') => Promise<void>
  // The lifetimes the plugin resolved, in seconds, defaults included: for a library that must agree with the app's session instead of asking for them again.
  readonly settings: SessionSettings
}

export interface SessionSettings {
  readonly maxAge: number
  readonly absoluteMaxAge: number
  readonly browserMaxAge: number
}

interface Sealed {
  // The data itself, or with a store its id.
  data?: SessionData
  id?: string
  // When the cookie was written, in seconds since the epoch.
  issued: number
  // When the session started or was last regenerated, in seconds since the epoch; a cookie from before kay wrote it counts from `issued`.
  started?: number
  // A lifetime `lifetime()` set, in seconds, and whether the cookie dies with the browser.
  maxAge?: number
  browser?: true
}

const DEFAULT_MAX_AGE = 60 * 60 * 24 * 30
const DEFAULT_ABSOLUTE_MAX_AGE = 60 * 60 * 24 * 90
const DEFAULT_BROWSER_MAX_AGE = 60 * 60 * 24
// Secrets published in kay's own templates, which anyone can read: an app copying one would let anyone forge its sessions.
const PUBLISHED_SECRETS = new Set(['at-least-32-characters-kept-out-of-the-repository'])
// A host name, the form a cookie's Domain takes once trimmed, lowercased and its leading dot dropped.
const COOKIE_DOMAIN = /^[a-z\d-]+(?:\.[a-z\d-]+)*$/
const LEADING_DOT = /^\./
// What a browser keeps of one cookie, name and attributes included, is about 4 KB.
const MAX_COOKIE_LENGTH = 3800
// A store drops expired sessions once every so many writes.
const SWEEP_EVERY = 1000
// The most sessions the memory store holds: past it the oldest go, so a flood of visitors cannot fill the process.
const MOST_SESSIONS = 100_000
// How often a SQLite store drops expired sessions on its own, so a quiet site does not keep them.
const SWEEP_MS = 60 * 60 * 1000
// How often a SQLite store looks whether its file was deleted or replaced, at most.
const FILE_CHECK_MS = 5000

type SqliteSessionStore = SessionStore & { deleteWhere: NonNullable<SessionStore['deleteWhere']> }
const sqliteStores = new Map<string, { store: SqliteSessionStore, reopen: () => void }>()

// Sessions for kay pages and plain Elysia routes alike, as `session` in the context: `ctx.locals.session` in a page, an action or a guard.
// The cookie is read on first use and written only when the session changed or is due an extension; it is HttpOnly, SameSite=Lax unless `sameSite` says another, and over https Secure and named `__Host-` unless shared under a domain.
export function session<Data extends object = SessionData>(options: SessionOptions) {
  const secrets = [options.secret].flat()

  if (weakSecrets(secrets))
    throw new KayError('config-invalid', `kay: a session secret is at least ${MIN_SECRET_LENGTH} characters; generate one with ${GENERATE_SECRET}`)

  if (secrets.some(secret => PUBLISHED_SECRETS.has(secret)))
    throw new KayError('config-invalid', `kay: the session secret is the placeholder an older \`kay new\` wrote to .env.example, which anyone can read; generate one with ${GENERATE_SECRET}`)

  if (!options.store && process.env.NODE_ENV === 'production')
    kayLog('warn', `a session kept in its ${options.cookie ?? 'session'} cookie alone, with no store, cannot be revoked by the session itself: signing out only clears the browser's cookie, and a copy taken before stays valid until it expires unless the app ends it elsewhere; give session() a store, such as sqliteStore('data/sessions.sqlite'), to end sessions on the server`)

  const keys = secrets.map(secret => nodeCrypto().createHash('sha256').update(secret).digest())

  useStampSecret(secrets[0]!, 'session')
  const domain = options.domain?.trim().toLowerCase().replace(LEADING_DOT, '')

  if (domain !== undefined && !COOKIE_DOMAIN.test(domain))
    throw new KayError('config-invalid', `kay: the session domain is ${JSON.stringify(options.domain)}, which is no host name such as example.com`)

  if (options.sameSite !== undefined && !SAME_SITE.has(options.sameSite))
    throw new KayError('config-invalid', `kay: the session sameSite is ${JSON.stringify(options.sameSite)}, which is none of 'lax', 'strict' and 'none'`)

  const config = { name: options.cookie ?? 'session', sameSite: options.sameSite ?? 'lax', maxAge: options.maxAge === undefined ? DEFAULT_MAX_AGE : wholeSeconds(options.maxAge, 'the session maxAge'), absoluteMaxAge: options.absoluteMaxAge === undefined ? DEFAULT_ABSOLUTE_MAX_AGE : wholeSeconds(options.absoluteMaxAge, 'the session absoluteMaxAge'), browserMaxAge: options.browserMaxAge === undefined ? DEFAULT_BROWSER_MAX_AGE : wholeSeconds(options.browserMaxAge, 'the session browserMaxAge'), domain, store: options.store, keys }

  return new Elysia({ name: 'kay/session', seed: config.name })
    .derive({ as: 'scoped' }, ({ request }) => ({ session: new RequestSession<Data>(request, config) }))
    .onAfterHandle({ as: 'scoped' }, async (context) => {
      const cookie = await context.session.commit()

      if (cookie === undefined)
        return

      // A Response the route built keeps its own headers, so the cookie goes on it; any other value takes Elysia's.
      const response = (context as { responseValue?: unknown }).responseValue

      if (response instanceof Response) {
        response.headers.append('set-cookie', cookie)

        return
      }

      const before = context.set.headers['set-cookie']

      context.set.headers['set-cookie'] = [before ?? []].flat().concat(cookie)
    })
}

interface SessionConfig {
  name: string
  sameSite: SameSite
  maxAge: number
  absoluteMaxAge: number
  browserMaxAge: number
  domain?: string | undefined
  store?: SessionStore | undefined
  keys: Buffer[]
}

class RequestSession<Data extends object> implements Session<Data> {
  private loading: Promise<void> | undefined
  private data: SessionData = {}
  private id: string | undefined
  private issued: number | undefined
  private started: number | undefined
  private own: Pick<Sealed, 'maxAge' | 'browser'> = {}
  private changed = false
  // An id `regenerate` or `destroy` left behind, deleted from the store on commit.
  private retired: string | undefined
  private oldKey = false
  private readonly secure: boolean
  // `__Host-` keeps the cookie to this host over https, so no other host of the site can set it; a Domain rules the prefix out.
  private readonly name: string

  constructor(private readonly request: Request, private readonly config: SessionConfig) {
    this.secure = overHttps(request)
    this.name = this.secure && config.domain === undefined && !config.name.startsWith('__') ? `__Host-${config.name}` : config.name
  }

  async get<Key extends keyof Data>(key: Key): Promise<Data[Key] | undefined> {
    await this.load()

    return this.data[key as string] as Data[Key] | undefined
  }

  async set<Key extends keyof Data>(key: Key, value: Data[Key]): Promise<void> {
    await this.load()
    this.data[key as string] = value
    this.changed = true
  }

  async unset(key: keyof Data): Promise<void> {
    await this.load()
    delete this.data[key as string]
    this.changed = true
  }

  async destroy(): Promise<void> {
    await this.load()
    this.retired = this.id
    this.id = undefined
    this.started = undefined
    this.data = {}
    this.own = {}
    this.changed = true
  }

  async regenerate(): Promise<void> {
    await this.load()
    this.retired = this.id
    this.id = undefined
    this.started = undefined
    this.changed = true
  }

  get settings(): SessionSettings {
    const { maxAge, absoluteMaxAge, browserMaxAge } = this.config

    return { maxAge, absoluteMaxAge, browserMaxAge }
  }

  async lifetime(maxAge: Duration | 'browser'): Promise<void> {
    await this.load()
    this.own = maxAge === 'browser' ? { maxAge: this.config.browserMaxAge, browser: true } : { maxAge: wholeSeconds(maxAge, 'a session lifetime') }
    this.changed = true
  }

  // The Set-Cookie value to send, or undefined when the session needs none.
  async commit(): Promise<string | undefined> {
    if (!this.loading)
      return undefined

    await this.loading
    const { store } = this.config
    const { name } = this
    const now = Math.floor(Date.now() / 1000)
    const started = this.started ?? now
    const lifetime = this.own.maxAge ?? this.config.maxAge
    // Never past the session's absolute end.
    const maxAge = Math.min(lifetime, started + this.config.absoluteMaxAge - now)
    const empty = Object.keys(this.data).length === 0
    // Past half its life, or sealed with a secret the app is rotating out.
    const due = this.issued !== undefined && (now - this.issued > lifetime / 2 || this.oldKey)

    if (!this.changed && !due)
      return undefined

    if (this.retired !== undefined)
      await store?.delete(this.retired)

    if (empty || maxAge <= 0) {
      if (this.id !== undefined)
        await store?.delete(this.id)

      return this.issued === undefined && this.retired === undefined ? undefined : this.cookie('', 0)
    }

    let sealed: Sealed = { data: this.data, issued: now, started, ...this.own }

    if (store) {
      this.id ??= nodeCrypto().randomBytes(32).toString('base64url')
      await store.set(this.id, this.data, maxAge)
      sealed = { id: this.id, issued: now, started, ...this.own }
    }

    const cookie = this.cookie(sealWith(this.config.keys[0]!, stringify(sealed), name), this.own.browser ? undefined : maxAge)

    if (cookie.length > MAX_COOKIE_LENGTH)
      throw new Error(`kay: the session cookie ${name} would take ${cookie.length} bytes, more than a browser keeps; hold less in it, or give session() a store`)

    return cookie
  }

  private async load(): Promise<void> {
    this.loading ??= this.read()

    return this.loading
  }

  private async read(): Promise<void> {
    readPersonally(this.request)
    const value = requestCookies(this.request).get(this.name)
    const opening = value !== null && value !== '' ? opened(value, this.config.keys, this.name) : undefined
    const sealed = opening?.sealed
    const now = Date.now() / 1000

    if (!sealed || sealed.issued + (sealed.maxAge ?? this.config.maxAge) < now || (sealed.started ?? sealed.issued) + this.config.absoluteMaxAge < now) {
      // An expired or forged cookie is cleared with the next write.
      this.issued = value !== null && value !== '' ? 0 : undefined

      return
    }

    this.issued = sealed.issued
    this.started = sealed.started ?? sealed.issued
    this.oldKey = opening.oldKey
    this.own = { ...sealed.maxAge === undefined ? {} : { maxAge: sealed.maxAge }, ...sealed.browser ? { browser: true } : {} }

    if (!this.config.store) {
      this.data = sealed.data ?? {}

      return
    }

    const stored = sealed.id === undefined ? undefined : await this.config.store.get(sealed.id)

    if (stored) {
      this.id = sealed.id
      this.data = { ...stored }
    }
  }

  // Without `maxAge`, a cookie the browser drops on closing.
  private cookie(value: string, maxAge: number | undefined): string {
    return new Bun.Cookie(this.name, value, { path: '/', ...this.config.domain === undefined ? {} : { domain: this.config.domain }, httpOnly: true, sameSite: this.config.sameSite, secure: this.secure || this.config.sameSite === 'none', ...maxAge === undefined ? {} : { maxAge } }).serialize()
  }
}

// What the cookie holds, and whether a secret other than the first sealed it; sealed under its name, so no other cookie passes for it.
function opened(value: string, keys: Buffer[], name: string): { sealed: Sealed, oldKey: boolean } | undefined {
  const found = openWith(keys, value, name)

  if (found === undefined)
    return undefined

  try {
    return { sealed: parse(found.text) as Sealed, oldKey: found.key > 0 }
  }
  catch {
    return undefined
  }
}

// Sessions in this process's memory: gone on restart, and each process keeps its own. Fine for development and one-process sites that can sign everyone out on deploy.
export function memoryStore(): SessionStore & { deleteWhere: NonNullable<SessionStore['deleteWhere']> } {
  const sessions = new Map<string, { text: string, expires: number }>()
  let writes = 0

  return {
    get(id) {
      const entry = sessions.get(id)

      if (!entry || entry.expires < Date.now()) {
        sessions.delete(id)

        return undefined
      }

      return parse(entry.text) as SessionData
    },
    set(id, data, maxAge) {
      const now = Date.now()

      // Swept every so many writes, so memory follows the sessions in use.
      if (++writes % SWEEP_EVERY === 0) {
        for (const [key, entry] of sessions) {
          if (entry.expires < now)
            sessions.delete(key)
        }
      }

      // Deleted first, so a session written again counts as the newest.
      sessions.delete(id)
      sessions.set(id, { text: stringify(data), expires: now + maxAge * 1000 })

      if (sessions.size > MOST_SESSIONS)
        sessions.delete(sessions.keys().next().value!)
    },
    delete(id) {
      sessions.delete(id)
    },
    deleteWhere(match) {
      const now = Date.now()
      let deleted = 0

      for (const [id, entry] of sessions) {
        if (entry.expires >= now && matchesSession(entry.text, match)) {
          sessions.delete(id)
          deleted++
        }
      }

      return deleted
    },
  }
}

// Sessions in a SQLite file, surviving restarts and shared by the processes on one machine.
// One store per file, so a config read again, as in development, opens no second database and sweep timer; a file deleted or replaced at the same path is opened afresh, by a running server too.
export function sqliteStore(path: string): SqliteSessionStore {
  if (path === ':memory:' || path === '') {
    const { store, close } = openSqliteStore(path)

    // Nothing else holds a store of its own, so a reload closes it with the module that opened it.
    onReload(close)

    return store
  }

  const file = resolve(path)
  const opened = sqliteStores.get(file)

  if (opened) {
    opened.reopen()

    return opened.store
  }

  const created = fileStore(file)

  sqliteStores.set(file, created)

  return created.store
}

// A store that keeps its object while the database under it changes, so a request holding it never meets a closed one; each call is synchronous, so none runs across a reopen.
function fileStore(file: string): { store: SqliteSessionStore, reopen: () => void } {
  let opened = openSqliteStore(file)
  let stamp = fileId(file)
  let checked = Date.now()
  const reopen = () => {
    checked = Date.now()

    if (fileId(file) === stamp)
      return

    opened.close()
    opened = openSqliteStore(file)
    stamp = fileId(file)
  }
  const current = () => {
    if (Date.now() - checked >= FILE_CHECK_MS)
      reopen()

    return opened.store
  }

  return {
    reopen,
    store: {
      get: async id => current().get(id),
      set: async (id, data, maxAge) => current().set(id, data, maxAge),
      delete: async id => current().delete(id),
      deleteWhere: async match => current().deleteWhere(match),
    },
  }
}

// The file's device, inode and creation time, which a file recreated at the same path does not keep whole; undefined once it is gone.
// The creation time needs a filesystem reporting a real one: some network or overlay mounts report 0, or the change time, which every write moves, so a creation time equal to it is left out.
function fileId(file: string): string | undefined {
  try {
    const stat = statSync(file, { throwIfNoEntry: false })

    return stat && `${stat.dev}:${stat.ino}:${stat.birthtimeMs === stat.ctimeMs ? '' : stat.birthtimeMs}`
  }
  catch {
    return undefined
  }
}

function openSqliteStore(path: string): { store: SqliteSessionStore, close: () => void } {
  const db = openSqlite(path)

  db.run('CREATE TABLE IF NOT EXISTS kay_sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL)')
  // The sweep deletes by expiry, which would otherwise read every session.
  db.run('CREATE INDEX IF NOT EXISTS kay_sessions_expires ON kay_sessions (expires)')

  const select = db.query<{ data: string }, [string, number]>('SELECT data FROM kay_sessions WHERE id = ? AND expires >= ?')
  const upsert = db.query('INSERT INTO kay_sessions (id, data, expires) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data, expires = excluded.expires')
  const remove = db.query('DELETE FROM kay_sessions WHERE id = ?')
  const sweep = db.query('DELETE FROM kay_sessions WHERE expires < ?')
  const live = db.query<{ id: string, data: string }, [number]>('SELECT id, data FROM kay_sessions WHERE expires >= ?')
  let writes = 0

  sweep.run(Date.now())

  const timer = setInterval(() => {
    try {
      sweep.run(Date.now())
    }
    catch (error) {
      kayLog('error', 'dropping the expired sessions failed; trying again in an hour', error)
    }
  }, SWEEP_MS)

  timer.unref()

  const store: SqliteSessionStore = {
    get(id) {
      const row = select.get(id, Date.now())

      return row ? parse(row.data) as SessionData : undefined
    },
    set(id, data, maxAge) {
      if (++writes % SWEEP_EVERY === 0)
        sweep.run(Date.now())

      upsert.run(id, stringify(data), Date.now() + maxAge * 1000)
    },
    delete(id) {
      remove.run(id)
    },
    deleteWhere(match) {
      const ids = live.all(Date.now()).filter(row => matchesSession(row.data, match)).map(row => row.id)

      db.transaction(() => {
        for (const id of ids)
          remove.run(id)
      })()

      return ids.length
    },
  }

  return { store, close: () => {
    clearInterval(timer)
    db.close()
  } }
}

// Whether stored session data matches, a row that does not parse logged and skipped so the rest are still erased.
function matchesSession(text: string, match: (data: SessionData) => boolean): boolean {
  let data: SessionData

  try {
    data = parse(text) as SessionData
  }
  catch (error) {
    kayLog('warn', 'a stored session does not parse; deleteWhere skipped it', error)

    return false
  }

  return match(data)
}
