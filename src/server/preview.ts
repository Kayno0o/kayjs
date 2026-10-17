import type { CookieMap } from 'bun'
import type { Elysia } from 'elysia'
import type { PreviewConfig } from '../config'
import type { Collection } from '../content'
import type { Duration } from '../runtime/duration'
import type { DraftEntry, DraftIssue } from '../runtime/edit'
import type { EntryDraft, PreviewMode, PreviewState } from '../runtime/preview'
import type { BodyLimit } from './body'
import { AsyncLocalStorage } from 'node:async_hooks'
import { KayError } from '../compiler/errors'
import { entryIssues } from '../content/edit'
import { wholeSeconds } from '../runtime/duration'
import { exportNameOf } from '../runtime/fields'
import { setPreviewScope } from '../runtime/preview'
import { DRAFT_ROUTE } from '../runtime/swap'
import { isCrossSite, overHttps } from './actions'
import { nodeCrypto } from './builtins'
import { requestCookies } from './cookies'
import { requestUrl } from './request-url'
import { MIN_SECRET_LENGTH, sameText } from './seal'
import { useStampSecret } from './stamp'
import { visitAs } from './visit'

// Where a preview link enters preview mode, or `?exit` leaves it.
export const PREVIEW_ROUTE = '/_kay/preview'
export const PREVIEW_COOKIE = 'kay_preview'
const EDIT = 'edit'
const DEFAULT_MAX_AGE = 3600
const DEFAULT_LINK_TTL = 3600
// A path of the site, never `//host` nor `/\host`, which a browser reads as another site.
const SITE_PATH = /^\/(?![/\\])\S*$/
const TEXT = { 'content-type': 'text/plain; charset=utf-8' }
// Names the drafts `/_kay/draft` renders a page with, by an id no request from outside can guess.
const DRAFT_HEADER = 'x-kay-draft'
const POSTED_HEADERS = ['content-type', 'content-length']

// `/_kay/draft` takes no more than the app's `bodyLimit`, as an action does.
export const DRAFT_BODY_LIMIT: BodyLimit = { refuse: () => new Response('Request body too large', { status: 413, headers: TEXT }) }

interface PreviewSettings {
  secret: string
  maxAge: number
  base: string
}

let settings: PreviewSettings | undefined
const store = new AsyncLocalStorage<PreviewState>()
const pendingDrafts = new Map<string, Map<string, EntryDraft[]>>()

setPreviewScope(() => store.getStore())

// `preview` from kay.config.ts, checked as the server boots; without it no request is ever in preview mode.
export function setupPreview(config: PreviewConfig | undefined, base: string): void {
  if (!config) {
    settings = undefined

    return
  }

  if (typeof config.secret !== 'string' || config.secret.length < MIN_SECRET_LENGTH)
    throw new KayError('config-invalid', `kay: preview.secret in kay.config.ts is ${typeof config.secret === 'string' ? `${config.secret.length} characters long` : 'missing'}: it signs preview links and cookies, so it is at least ${MIN_SECRET_LENGTH} random characters, read from the environment`)

  useStampSecret(config.secret, 'preview')
  settings = { secret: config.secret, maxAge: wholeSeconds(config.maxAge ?? DEFAULT_MAX_AGE, 'preview.maxAge'), base }
}

// Renders for a visitor in preview mode, in edit mode too when `edit` is set, with the entries `drafts` holds standing in for theirs.
export function inPreview<T>(run: () => T, edit = false, drafts?: Map<string, EntryDraft[]>): T {
  return store.run({ loads: new Map(), edit, ...drafts && { drafts } }, run)
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

export function exitPreview(ctx: { cookies: CookieMap }): void {
  ctx.cookies.delete({ name: PREVIEW_COOKIE, path: settingsFor('exitPreview()').base || '/' })
}

// A link that puts whoever follows it in preview mode, edit mode too with `edit`, and opens `path`, a path of the site written without the base, until `ttl` runs out, an hour by default.
export function previewUrl(path: string, options: { ttl?: Duration, edit?: boolean } = {}): string {
  const current = settingsFor('previewUrl()')

  if (!SITE_PATH.test(path))
    throw new KayError('config-invalid', `kay: previewUrl() was given ${path}, which is no path of the site such as /blog/draft`)

  const until = Math.floor(Date.now() / 1000) + wholeSeconds(options.ttl ?? DEFAULT_LINK_TTL, 'previewUrl()\'s ttl')

  const edit = options.edit === true

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
