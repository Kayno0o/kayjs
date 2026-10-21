import type { CookieMap } from 'bun'
import type { Elysia } from 'elysia'
import type { PreviewConfig } from '../config'
import type { Collection } from '../content'
import type { Duration } from '../runtime/duration'
import type { DraftEntry, DraftIssue } from '../runtime/edit'
import type { EntryRef } from '../runtime/fields'
import type { EntryDraft, PreviewMode, PreviewScope, PreviewState } from '../runtime/preview'
import type { BodyLimit } from './body'
import { AsyncLocalStorage } from 'node:async_hooks'
import { KayError } from '../compiler/errors'
import { entryIssues } from '../content/edit'
import { wholeSeconds } from '../runtime/duration'
import { exportNameOf } from '../runtime/fields'
import { kayLog } from '../runtime/log'
import { setPreviewScope } from '../runtime/preview'
import { DRAFT_ROUTE } from '../runtime/swap'
import { isCrossSite, overHttps } from './actions'
import { nodeCrypto } from './builtins'
import { requestCookies } from './cookies'
import { requestUrl } from './request-url'
import { MIN_SECRET_LENGTH, sameText } from './seal'
import { appSecrets, noAppSecret, useStampSecret } from './stamp'
import { visitAs } from './visit'

// Where a preview link enters preview mode, or `?exit` leaves it.
export const PREVIEW_ROUTE = '/_kay/preview'
export const PREVIEW_COOKIE = 'kay_preview'
const EDIT = 'edit'

// The query param of a share link, `until.entry.sig`.
const SHARE_PARAM = 'kay_preview'
const DEFAULT_MAX_AGE = 3600
const DEFAULT_LINK_TTL = 3600
// A path of the site, never `//host` nor `/\host`, which a browser reads as another site.
const SITE_PATH = /^\/(?![/\\])\S*$/
const TEXT = { 'content-type': 'text/plain; charset=utf-8' }
// Names the drafts `/_kay/draft` renders a page with, by an id no request from outside can guess.
const DRAFT_HEADER = 'x-kay-draft'
// Names the probe a request belongs to, by an id no request from outside can guess, so a page rendered for it reports what it read.
const PROBE_HEADER = 'x-kay-probe'
// A probe's cookie only has to outlive its own render.
const PROBE_MAX_AGE = 60
const POSTED_HEADERS = ['content-type', 'content-length']

// `/_kay/draft` takes no more than the app's `maxSize`, as an action does.
export const DRAFT_BODY_LIMIT: BodyLimit = { refuse: () => new Response('Request body too large', { status: 413, headers: TEXT }) }

interface PreviewSettings {
  secret: string
  maxAge: number
  base: string
}

// Edit cookies kept at once, so the collections they read cannot grow without bound; the oldest goes first.
const MAX_EDIT_SESSIONS = 1000

interface EditSession {
  until: number
  entries: Set<string>
}

let settings: PreviewSettings | undefined
// The entries the pages rendered in edit mode read, by the edit cookie they were rendered for.
const editSessions = new Map<string, EditSession>()
const store = new AsyncLocalStorage<PreviewState>()
const probes = new Map<string, EntryRef[]>()
// Set while a page renders for a probe, where a CMS screen asking for pages must not start another.
const probing = new AsyncLocalStorage<true>()
const pendingDrafts = new Map<string, Map<string, EntryDraft[]>>()

setPreviewScope(() => store.getStore())

// `preview` from kay.config.ts, checked as the server boots; without it no request is ever in preview mode.
export function setupPreview(config: PreviewConfig | false | undefined, base: string): void {
  if (config === undefined || config === false) {
    settings = undefined

    return
  }

  const secret: unknown = config.secret ?? appPreviewSecret()

  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH)
    throw new KayError('config-invalid', `kay: preview.secret in kay.config.ts is ${typeof secret === 'string' ? `${secret.length} characters long` : 'missing'}: it signs preview links and cookies, so it is at least ${MIN_SECRET_LENGTH} random characters, read from the environment`)

  useStampSecret(secret, 'preview')
  settings = { secret, maxAge: wholeSeconds(config.maxAge ?? DEFAULT_MAX_AGE, 'preview.maxAge'), base }
}

// A key of preview's own, derived from the app's secret so what signs a preview link never passes for the session's or the stamps'.
function appPreviewSecret(): string {
  const secrets = appSecrets()

  if (secrets === undefined)
    throw noAppSecret('preview in kay.config.ts')

  return Buffer.from(nodeCrypto().hkdfSync('sha256', secrets[0]!, '', 'kay preview', 32)).toString('base64url')
}

// Renders for a visitor in preview mode, in edit mode too when `edit` is set, with the entries `drafts` holds standing in for theirs.
export function inPreview<T>(run: () => T, edit = false, drafts?: Map<string, EntryDraft[]>): T {
  return store.run({ loads: new Map(), edit, ...drafts && { drafts } }, run)
}

// Renders for a visitor a share link let see one entry's draft, and nothing else of preview mode.
export function inSharedDraft<T>(run: () => T, scope: PreviewScope): T {
  return store.run({ loads: new Map(), edit: false, scope }, run)
}

// The drafts `/_kay/draft` renders the page of `request` with.
export function requestDrafts(request: Request): Map<string, EntryDraft[]> | undefined {
  const id = request.headers.get(DRAFT_HEADER)

  return id === null ? undefined : pendingDrafts.get(id)
}

// `/_kay/draft` answers a visitor in edit mode with the page at `path` rendered with the entries they have not saved, or a 422 with where those fail their schema.
export function serveDrafts(app: Elysia, collections: Collection<unknown>[]): void {
  app.post(DRAFT_ROUTE, async ({ request, server }) => {
    if (previewRequested(request) !== 'edit' || isCrossSite(request))
      return new Response('Drafts are shown in edit mode only', { status: 403, headers: TEXT })

    const posted = await postedDrafts(request)

    if (!posted)
      return new Response('Not a draft: { path, entries: [{ collection, slug, locale?, data, body? }] }', { status: 400, headers: TEXT })

    const drafts = new Map<string, EntryDraft[]>()
    const issues: DraftIssue[] = []

    for (const { collection, slug, locale, data, body } of posted.entries) {
      const found = collections.find(each => exportNameOf(each.name) === collection)

      if (!found) {
        issues.push({ collection, slug, ...locale !== undefined && { locale }, path: '', message: 'names no collection the content config exports' })

        continue
      }

      const checked = await entryIssues(collection, found, { slug, locale, data, body })
      const compiled = checked.compiled

      issues.push(...checked.issues)
      drafts.set(found.name, [...drafts.get(found.name) ?? [], { slug, locale, data, body, compiled }])
    }

    if (issues.length > 0)
      return Response.json({ issues }, { status: 422, headers: { 'cache-control': 'no-store' } })

    const id = crypto.randomUUID()
    const headers = new Headers(request.headers)

    for (const name of POSTED_HEADERS)
      headers.delete(name)

    headers.set('accept', 'text/html')
    headers.set(DRAFT_HEADER, id)
    pendingDrafts.set(id, drafts)

    try {
      return await visitAs(request, new Request(new URL(posted.path, request.url), { headers }), server, async visit => app.handle(visit))
    }
    finally {
      pendingDrafts.delete(id)
    }
  })
}

async function postedDrafts(request: Request): Promise<{ path: string, entries: DraftEntry[] } | undefined> {
  let posted: unknown

  try {
    posted = await request.json()
  }
  catch {
    return undefined
  }

  const { path, entries } = (posted ?? {}) as { path?: unknown, entries?: unknown }

  return typeof path === 'string' && SITE_PATH.test(path) && Array.isArray(entries) && entries.every(isDraft) ? { path, entries: entries as DraftEntry[] } : undefined
}

function isDraft(value: unknown): boolean {
  const { collection, slug, locale, body } = (value ?? {}) as Partial<Record<keyof DraftEntry, unknown>>

  return typeof collection === 'string' && typeof slug === 'string' && (locale === undefined || typeof locale === 'string') && (body === undefined || typeof body === 'string')
}

// The mode the request's preview cookie, signed by this site and not expired yet, puts it in: `until.sig`, or `until.edit.sig` for edit mode.
export function previewRequested(request: Request): PreviewMode | undefined {
  if (!settings)
    return undefined

  const [until, ...rest] = requestCookies(request).get(PREVIEW_COOKIE)?.split('.') ?? []
  const edit = rest.length === 2 && rest[0] === EDIT
  const sig = rest.at(-1)

  if (until === undefined || sig === undefined || (rest.length !== 1 && !edit) || !(Number(until) > Date.now() / 1000))
    return undefined

  if (!sameText(sig, sign(settings, cookieText(until, edit))))
    return undefined

  return edit ? 'edit' : 'preview'
}

// The valid edit cookie of the request, which names its edit session.
function editCookie(request: Request): string | undefined {
  return previewRequested(request) !== 'edit' ? undefined : requestCookies(request).get(PREVIEW_COOKIE) ?? undefined
}

// Remembers the entries the page just rendered in edit mode read, for the edit cookie of its request: the editor opens those, and `editedEntry` lets an API serve no others.
export function noteEditedEntries(request: Request, entries: Iterable<EntryRef>): void {
  const cookie = editCookie(request)

  // A probe's cookie is the server's own, opening nothing for an editor.
  if (cookie === undefined || request.headers.has(PROBE_HEADER))
    return

  let session = editSessions.get(cookie)

  if (session) {
    // Used last, so a full registry drops the cookie nobody uses.
    editSessions.delete(cookie)
  }
  else {
    const now = Date.now() / 1000

    for (const [key, each] of editSessions) {
      if (each.until <= now)
        editSessions.delete(key)
    }

    while (editSessions.size >= MAX_EDIT_SESSIONS)
      editSessions.delete(editSessions.keys().next().value!)

    session = { until: Number(cookie.slice(0, cookie.indexOf('.'))), entries: new Set() }
  }

  editSessions.set(cookie, session)

  for (const { collection, slug } of entries)
    session.entries.add(entryKey(collection, slug))
}

function entryKey(collection: string, slug: string): string {
  return `${collection}\0${slug}`
}

// Whether a page rendered in edit mode for this request's cookie read the entry, its collection by the name the content config exports it under, whatever its locale: false outside edit mode. A CMS's API serves an edit cookie no other entry, since the cookie is tied to no user.
export function editedEntry(request: Request, collection: string, slug: string): boolean {
  const cookie = editCookie(request)
  const session = cookie === undefined ? undefined : editSessions.get(cookie)

  return session !== undefined && session.until > Date.now() / 1000 && session.entries.has(entryKey(collection, slug))
}

// Whether the request is in edit mode, for a CMS's API module or guard to let in the editor alone outside a page's render, where `editing()` tells.
export function editRequested(request: Request): boolean {
  return previewRequested(request) === 'edit'
}

// Puts the visitor in preview mode for `preview.maxAge`, from a guard, a page or an action whose `ctx` carries cookies, such as one letting a signed-in editor in; `edit` puts them in edit mode as well.
export function enterPreview(ctx: { cookies: CookieMap, request: Request }, options: { edit?: boolean } = {}): void {
  const current = settingsFor('enterPreview()')
  const until = String(Math.floor(Date.now() / 1000) + current.maxAge)
  const edit = options.edit === true

  ctx.cookies.set(PREVIEW_COOKIE, [until, ...edit ? [EDIT] : [], sign(current, cookieText(until, edit))].join('.'), { httpOnly: true, sameSite: 'lax', secure: overHttps(ctx.request), path: current.base || '/', maxAge: current.maxAge })
}

// Renders the page at `url` through `handle` in edit mode, as an editor's request would, and gives the entries it read; undefined when the app has no preview, or the page answered nothing.
// The request carries an edit cookie only this process signs for, and the answer is dropped: it is how the CMS learns which page shows an entry no collection page does.
export async function entriesReadAt(handle: (request: Request) => Promise<Response>, url: string, timeout = 5000): Promise<EntryRef[] | undefined> {
  if (!settings)
    return undefined

  const until = String(Math.floor(Date.now() / 1000) + PROBE_MAX_AGE)
  const id = crypto.randomUUID()
  const reads: EntryRef[] = []

  probes.set(id, reads)

  try {
    const headers = new Headers({ [PROBE_HEADER]: id, cookie: `${PREVIEW_COOKIE}=${[until, EDIT, sign(settings, cookieText(until, true))].join('.')}` })

    const response = await withinTimeout(timeout, async signal => probing.run(true, async () => handle(new Request(url, { headers, signal }))))

    await response.body?.cancel()

    return reads
  }
  catch (error) {
    kayLog('warn', `the page at ${url} could not be rendered to find the entries it shows: ${error instanceof Error ? error.message : String(error)}`)

    return undefined
  }
  finally {
    probes.delete(id)
  }
}

// Runs `run` with a signal aborted once `timeout` has passed, and rejects then even when `run` never looks at the signal: a page that ignores it must not hold the probe.
async function withinTimeout<T>(timeout: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()

  // A run abandoned at the timeout may settle later, which the promise ignores.
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`it took more than ${timeout} ms`))
    }, timeout)

    void (async () => {
      try {
        resolve(await run(controller.signal))
      }
      catch (error) {
        reject(error)
      }
      finally {
        clearTimeout(timer)
      }
    })()
  })
}

// Whether the code running renders a page for `entriesReadAt`.
export function inProbe(): boolean {
  return probing.getStore() === true
}

// Called with the entries a page rendered in edit mode read, for the probe that asked for it.
export function noteProbedEntries(request: Request, entries: Iterable<EntryRef>): void {
  const id = request.headers.get(PROBE_HEADER)
  const reads = id === null ? undefined : probes.get(id)

  if (reads)
    reads.push(...entries)
}

export function exitPreview(ctx: { cookies: CookieMap }): void {
  ctx.cookies.delete({ name: PREVIEW_COOKIE, path: settingsFor('exitPreview()').base || '/' })
}

// A share link's token taken out of a URL once kay has read it, so a page never sees it in `ctx.url` or `ctx.query`, nor copies it into its own links.
export function withoutShareToken(url: URL): void {
  if (url.searchParams.has(SHARE_PARAM))
    url.searchParams.delete(SHARE_PARAM)
}

// The entry a request's share link names, when the link is signed by this site for the page asked and has not expired; undefined for any other request, and for a link in a request that already has the preview cookie.
export function sharedEntry(request: Request): PreviewScope | undefined {
  if (!settings)
    return undefined

  const url = requestUrl(request)
  const [until, entry, sig, ...extra] = url.searchParams.get(SHARE_PARAM)?.split('.') ?? []

  if (until === undefined || entry === undefined || sig === undefined || extra.length > 0 || !(Number(until) > Date.now() / 1000) || !sameText(sig, sign(settings, shareText(until, entry, sharedPath(url.pathname)))))
    return undefined

  try {
    const [collection, slug, locale] = JSON.parse(Buffer.from(entry, 'base64url').toString()) as unknown[]

    return typeof collection === 'string' && typeof slug === 'string' && typeof locale === 'string' ? { collection, slug, ...locale !== '' && { locale } } : undefined
  }
  catch {
    return undefined
  }
}

// A link that puts whoever follows it in preview mode, edit mode too with `edit`, and opens `path`, a path of the site written without the base, until `ttl` runs out, an hour by default.
// With `entry` the link shows that entry's draft alone, on the page `path` (the entry's own), and puts the visitor in no mode: every other page and entry stays as published.
export function previewUrl(path: string, options: { ttl?: Duration, edit?: boolean, entry?: PreviewScope } = {}): string {
  const current = settingsFor('previewUrl()')

  if (!SITE_PATH.test(path))
    throw new KayError('config-invalid', `kay: previewUrl() was given ${path}, which is no path of the site such as /blog/draft`)

  const until = Math.floor(Date.now() / 1000) + wholeSeconds(options.ttl ?? DEFAULT_LINK_TTL, 'previewUrl()\'s ttl')

  const edit = options.edit === true

  if (options.entry) {
    if (edit)
      throw new KayError('config-invalid', 'kay: previewUrl() was given `entry` and `edit`: a link to one entry\'s draft does not open edit mode')

    const { collection, slug, locale = '' } = options.entry
    const entry = Buffer.from(JSON.stringify([collection, slug, locale])).toString('base64url')
    const link = new URL(path, 'http://site')

    link.searchParams.set(SHARE_PARAM, [until, entry, sign(current, shareText(String(until), entry, sharedPath(link.pathname)))].join('.'))

    return `${current.base}${link.pathname}${link.search}${link.hash}`
  }

  return `${current.base}${PREVIEW_ROUTE}?${new URLSearchParams({ path, until: String(until), ...edit && { edit: '' }, sig: sign(current, linkText(path, String(until), edit)) })}`
}

// A link `previewUrl` signed sets the preview cookie and goes to the path, `&edit` in edit mode; `?exit&path=...` clears it. The secret itself is never taken, as a URL stays in histories and proxy logs.
export function servePreview(app: Elysia): void {
  app.get(PREVIEW_ROUTE, ({ request }) => {
    const current = settings!
    const query = requestUrl(request).searchParams
    const path = query.get('path') ?? '/'
    const edit = query.has('edit')

    if (!SITE_PATH.test(path))
      return new Response('The path is no path of the site', { status: 400, headers: TEXT })

    const cookies = new Bun.CookieMap()

    if (query.has('exit'))
      exitPreview({ cookies })
    else if (query.has('secret'))
      return new Response('A preview link carries a signature, not the secret: make one with previewUrl() from kay/server', { status: 403, headers: TEXT })
    else if (validLink(current, path, edit, query.get('until'), query.get('sig')))
      enterPreview({ cookies, request }, { edit })
    else
      return new Response('Not a valid preview link', { status: 403, headers: TEXT })

    const headers = new Headers({ 'location': `${current.base}${path}`, 'cache-control': 'no-store' })

    for (const cookie of cookies.toSetCookieHeaders())
      headers.append('set-cookie', cookie)

    return new Response(null, { status: 307, headers })
  })
}

function validLink(current: PreviewSettings, path: string, edit: boolean, until: string | null, sig: string | null): boolean {
  return until !== null && sig !== null && Number(until) > Date.now() / 1000 && sameText(sig, sign(current, linkText(path, until, edit)))
}

// What a cookie and a link sign: edit mode is signed apart, so a preview link cannot be turned into an edit one.
function cookieText(until: string, edit: boolean): string {
  return `cookie\n${until}${edit ? `\n${EDIT}` : ''}`
}

function shareText(until: string, entry: string, path: string): string {
  return `share\n${until}\n${entry}\n${path}`
}

// The page a share link opens, as the router reads it: no trailing slash.
function sharedPath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
}

function linkText(path: string, until: string, edit: boolean): string {
  return `link\n${path}\n${until}${edit ? `\n${EDIT}` : ''}`
}

function settingsFor(caller: string): PreviewSettings {
  if (!settings)
    throw new KayError('config-invalid', `kay: ${caller} needs preview in kay.config.ts, whose secret signs what it gives`)

  return settings
}

function sign(current: PreviewSettings, text: string): string {
  return nodeCrypto().createHmac('sha256', current.secret).update(text).digest('base64url')
}
