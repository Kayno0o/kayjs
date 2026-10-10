import type { Duration } from '../runtime/duration'
import { parse, stringify } from 'devalue'
import { Elysia } from 'elysia'
import { durationSeconds } from '../runtime/duration'
import { openSqlite } from '../runtime/sqlite.server'
import { overHttps } from './actions'
import { nodeCrypto } from './builtins'
import { useStampSecret } from './stamp'

export type SessionData = Record<string, unknown>

// Where sessions live when the cookie only carries their id; each method may answer synchronously or with a promise.
export interface SessionStore {
  get: (id: string) => SessionData | undefined | Promise<SessionData | undefined>
  // `maxAge` in seconds: past it the store may forget the session.
  set: (id: string, data: SessionData, maxAge: number) => void | Promise<void>
  delete: (id: string) => void | Promise<void>
}

export interface SessionOptions {
  // At least 32 characters, from the environment. A list rotates them: the first seals new cookies, every one opens old ones.
  secret: string | string[]
  // Defaults to `session`.
  cookie?: string | undefined
  // How long a session lasts without being used, seconds or a string such as '30d', 30 days by default; one used past half of it is extended.
  maxAge?: Duration | undefined
  // How long a session whose cookie dies with the browser, through `lifetime('browser')`, lasts without being used, a day by default.
  browserMaxAge?: Duration | undefined
  // The parent domain sibling hosts share the session under, `example.com` for `app.example.com` and `auth.example.com`, the visited host or a parent of it; the cookie is the visited host's only without it.
  domain?: string | undefined
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
}

interface Sealed {
  // The data itself, or with a store its id.
  data?: SessionData
  id?: string
  // When the cookie was written, in seconds since the epoch.
  issued: number
  // A lifetime `lifetime()` set, in seconds, and whether the cookie dies with the browser.
  maxAge?: number
  browser?: true
}

const DEFAULT_MAX_AGE = 60 * 60 * 24 * 30
const DEFAULT_BROWSER_MAX_AGE = 60 * 60 * 24
const MIN_SECRET_LENGTH = 32
// A host name, the form a cookie's Domain takes once trimmed, lowercased and its leading dot dropped.
const COOKIE_DOMAIN = /^[a-z\d-]+(?:\.[a-z\d-]+)*$/
const LEADING_DOT = /^\./
// What a browser keeps of one cookie, name and attributes included, is about 4 KB.
const MAX_COOKIE_LENGTH = 3800
const IV_BYTES = 12
const TAG_BYTES = 16
// A store drops expired sessions once every so many writes.
const SWEEP_EVERY = 1000

// Sessions for kay pages and plain Elysia routes alike, as `session` in the context: `ctx.locals.session` in a page, an action or a guard.
// The cookie is read on first use and written only when the session changed or is due an extension; it is HttpOnly, SameSite=Lax, and Secure over https.
export function session<Data extends object = SessionData>(options: SessionOptions) {
  const secrets = [options.secret].flat()

  if (secrets.length === 0 || secrets.some(secret => secret.length < MIN_SECRET_LENGTH))
    throw new Error(`kay: a session secret is at least ${MIN_SECRET_LENGTH} characters; generate one with \`bun -e "console.log(crypto.randomUUID() + crypto.randomUUID())"\``)

  const keys = secrets.map(secret => nodeCrypto().createHash('sha256').update(secret).digest())

  useStampSecret(secrets[0]!, 'session')
  const domain = options.domain?.trim().toLowerCase().replace(LEADING_DOT, '')

  if (domain !== undefined && !COOKIE_DOMAIN.test(domain))
    throw new Error(`kay: the session domain is ${JSON.stringify(options.domain)}, which is no host name such as example.com`)

  const config = { name: options.cookie ?? 'session', maxAge: options.maxAge === undefined ? DEFAULT_MAX_AGE : durationSeconds(options.maxAge, 'the session maxAge'), browserMaxAge: options.browserMaxAge === undefined ? DEFAULT_BROWSER_MAX_AGE : durationSeconds(options.browserMaxAge, 'the session browserMaxAge'), domain, store: options.store, keys }

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
  maxAge: number
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
  private own: Pick<Sealed, 'maxAge' | 'browser'> = {}
  private changed = false
  // An id `regenerate` or `destroy` left behind, deleted from the store on commit.
  private retired: string | undefined
  private oldKey = false

  constructor(private readonly request: Request, private readonly config: SessionConfig) {}

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
    this.data = {}
    this.own = {}
    this.changed = true
  }

  async regenerate(): Promise<void> {
    await this.load()
    this.retired = this.id
    this.id = undefined
    this.changed = true
  }

  async lifetime(maxAge: Duration | 'browser'): Promise<void> {
    await this.load()
    this.own = maxAge === 'browser' ? { maxAge: this.config.browserMaxAge, browser: true } : { maxAge: durationSeconds(maxAge, 'a session lifetime') }
    this.changed = true
  }

  // The Set-Cookie value to send, or undefined when the session needs none.
  async commit(): Promise<string | undefined> {
    if (!this.loading)
      return undefined

    await this.loading
    const { store, name } = this.config
    const maxAge = this.own.maxAge ?? this.config.maxAge
    const now = Math.floor(Date.now() / 1000)
    const empty = Object.keys(this.data).length === 0
    // Past half its life, or sealed with a secret the app is rotating out.
    const due = this.issued !== undefined && (now - this.issued > maxAge / 2 || this.oldKey)

    if (!this.changed && !due)
      return undefined

    if (this.retired !== undefined)
      await store?.delete(this.retired)

    if (empty) {
      if (this.id !== undefined)
        await store?.delete(this.id)

      return this.issued === undefined && this.retired === undefined ? undefined : this.cookie('', 0)
    }

    let sealed: Sealed = { data: this.data, issued: now, ...this.own }

    if (store) {
      this.id ??= nodeCrypto().randomBytes(32).toString('base64url')
      await store.set(this.id, this.data, maxAge)
      sealed = { id: this.id, issued: now, ...this.own }
    }

    const cookie = this.cookie(seal(stringify(sealed), this.config.keys[0]!, name), this.own.browser ? undefined : maxAge)

    if (cookie.length > MAX_COOKIE_LENGTH)
      throw new Error(`kay: the session cookie ${name} would take ${cookie.length} bytes, more than a browser keeps; hold less in it, or give session() a store`)

    return cookie
  }

  private async load(): Promise<void> {
    this.loading ??= this.read()

    return this.loading
  }

  private async read(): Promise<void> {
    const value = new Bun.CookieMap(this.request.headers.get('cookie') ?? '').get(this.config.name)
    const opening = value !== null && value !== '' ? opened(value, this.config.keys, this.config.name) : undefined
    const sealed = opening?.sealed

    if (!sealed || sealed.issued + (sealed.maxAge ?? this.config.maxAge) < Date.now() / 1000) {
      // An expired or forged cookie is cleared with the next write.
      this.issued = value !== null && value !== '' ? 0 : undefined

      return
    }

    this.issued = sealed.issued
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
    return new Bun.Cookie(this.config.name, value, { path: '/', ...this.config.domain === undefined ? {} : { domain: this.config.domain }, httpOnly: true, sameSite: 'lax', secure: overHttps(this.request), ...maxAge === undefined ? {} : { maxAge } }).serialize()
  }
}

// AES-256-GCM: the cookie can be neither read nor altered without the secret, nor passed off under another cookie's name.
function seal(text: string, key: Buffer, name: string): string {
  const { createCipheriv, randomBytes } = nodeCrypto()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)

  cipher.setAAD(Buffer.from(name))
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])

  return Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString('base64url')
}

// What the cookie holds, and whether a secret other than the first sealed it.
function opened(value: string, keys: Buffer[], name: string): { sealed: Sealed, oldKey: boolean } | undefined {
  const bytes = Buffer.from(value, 'base64url')

  if (bytes.length <= IV_BYTES + TAG_BYTES)
    return undefined

  for (const [index, key] of keys.entries()) {
    try {
      const decipher = nodeCrypto().createDecipheriv('aes-256-gcm', key, bytes.subarray(0, IV_BYTES))

      decipher.setAAD(Buffer.from(name))
      decipher.setAuthTag(bytes.subarray(-TAG_BYTES))

      return { sealed: parse(Buffer.concat([decipher.update(bytes.subarray(IV_BYTES, -TAG_BYTES)), decipher.final()]).toString('utf8')) as Sealed, oldKey: index > 0 }
    }
    // Sealed with another key, or not by kay at all.
    catch {}
  }

  return undefined
}

// Sessions in this process's memory: gone on restart, and each process keeps its own. Fine for development and one-process sites that can sign everyone out on deploy.
export function memoryStore(): SessionStore {
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

      sessions.set(id, { text: stringify(data), expires: now + maxAge * 1000 })
    },
    delete(id) {
      sessions.delete(id)
    },
  }
}

// Sessions in a SQLite file, surviving restarts and shared by the processes on one machine.
export function sqliteStore(path: string): SessionStore {
  const db = openSqlite(path)

  db.run('CREATE TABLE IF NOT EXISTS kay_sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL)')

  const select = db.query<{ data: string }, [string, number]>('SELECT data FROM kay_sessions WHERE id = ? AND expires >= ?')
  const upsert = db.query('INSERT INTO kay_sessions (id, data, expires) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data, expires = excluded.expires')
  const remove = db.query('DELETE FROM kay_sessions WHERE id = ?')
  const sweep = db.query('DELETE FROM kay_sessions WHERE expires < ?')
  let writes = 0

  sweep.run(Date.now())

  return {
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
  }
}
