import type { FetchPublicOptions, Kv } from 'kay/library'
import type { Core } from '../core'
import { isIP } from 'node:net'
import { fetchPublic } from 'kay/library'
import { spend } from '../limits'
import { validRedirectUris } from './uris'

const DOCUMENT_MAX_BYTES = 10 * 1024
const DOCUMENT_TIMEOUT_MS = 5000
const CACHE_MS = 5 * 60 * 1000

const NAME_MAX_LENGTH = 100
// eslint-disable-next-line no-control-regex -- control characters are what it finds
const CONTROL = /[\0-\x1F\x7F]/g
// Characters that reorder the text around them, which could make a name read as another.
const BIDI = /[\u202A-\u202E\u2066-\u2069]/g
const JSON_TYPE = /\bjson\b/

// A client as the authorization endpoint knows it.
export interface OAuthClient {
  id: string
  name: string
  redirectUris: string[]
  // The host a client named by a metadata document URL lives at, which the consent page shows beside its name; null for one that registered itself.
  host: string | null
}

// Reads a client's metadata document: its parsed JSON, or why not.
export type DocumentFetcher = (url: string) => Promise<unknown>

// A client ID that is the URL of its own metadata document: https, with a path, no login, fragment or dot segments.
export function documentUrl(clientId: string): URL | undefined {
  if (!clientId.startsWith('https://') || clientId.length > 2048)
    return undefined

  try {
    const url = new URL(clientId)

    // An address as the host has no name to hold to account, and its notations are many.
    if (isIP(url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname) !== 0)
      return undefined

    return url.pathname !== '/' && url.hash === '' && !clientId.includes('#') && url.username === '' && url.password === '' && url.href === clientId ? url : undefined
  }
  catch {
    return undefined
  }
}

// Reads a document over the public internet: https only, from an address that is not on a private network, with no redirect followed, a short time and a small size.
// `testing` only lets a test replace the name lookup and which hosts may be private.
export async function fetchPublicDocument(url: string, testing: Pick<FetchPublicOptions, 'allowPrivate' | 'resolve'> = {}): Promise<unknown> {
  const response = await fetchPublic(url, { ...testing, timeout: DOCUMENT_TIMEOUT_MS, maxBytes: DOCUMENT_MAX_BYTES, redirect: 'error', headers: { accept: 'application/json' } })

  if (response.status !== 200 || !JSON_TYPE.test(response.headers.get('content-type') ?? ''))
    throw new Error('the document did not answer 200 with JSON')

  return await response.json() as unknown
}

// The reader of metadata documents: the app's own, which then also decides which hosts it may reach, else one that stays on the public internet.
export function documentFetcher(custom: ((url: string) => Promise<Response>) | undefined): DocumentFetcher {
  if (!custom)
    return fetchPublicDocument

  return async (url) => {
    const response = await custom(url)

    if (!response.ok)
      throw new Error('the document did not answer 200')

    return await response.json() as unknown
  }
}

export function plainName(value: unknown): string | undefined {
  if (typeof value !== 'string')
    return undefined

  const name = value.replaceAll(CONTROL, ' ').replaceAll(BIDI, '').trim().slice(0, NAME_MAX_LENGTH)

  return name === '' ? undefined : name
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// The client a metadata document describes, or undefined when it is not one for this URL.
function clientOf(url: URL, document: unknown): OAuthClient | undefined {
  if (!isRecord(document) || document.client_id !== url.href)
    return undefined

  const uris = document.redirect_uris

  if (!validRedirectUris(uris))
    return undefined

  // A client holding a secret signs its token requests, which this server does not read.
  const method = document.token_endpoint_auth_method

  if (method !== undefined && method !== 'none')
    return undefined

  return { id: url.href, name: plainName(document.client_name) ?? url.hostname, redirectUris: [...uris], host: url.host }
}

// The client with that ID: a metadata document at the URL a client ID is, else a client that registered itself. Undefined for one this server does not know, or whose document is not valid.
export async function resolveClient(core: Core, clientId: string, address: string): Promise<OAuthClient | undefined> {
  const url = documentUrl(clientId)

  if (!url) {
    const stored = clientId.length <= 200 ? await core.store.oauth?.clients.get(clientId) : undefined

    return stored && { id: stored.id, name: stored.name, redirectUris: stored.redirectUris, host: null }
  }

  const server = core.oauthServer
  const known = server && await cachedClient(server.documents, url.href)

  if (known !== undefined)
    return known

  // Each read of a document is a request this server makes for whoever asked, so it is counted against them.
  if (!server || await spend(core.rates, `oauth-document:${address}`, core.limits.oauthDocument))
    return undefined

  try {
    const client = clientOf(url, await server.fetchDocument(url.href))

    if (client)
      await cacheClient(server.documents, url.href, client)

    return client
  }
  catch {
    return undefined
  }
}

// A store that fails to read or keep a document only costs the app a fetch of it.
async function cachedClient(documents: Kv, href: string): Promise<OAuthClient | undefined> {
  try {
    const kept = await documents.get(href)

    return kept === undefined ? undefined : JSON.parse(kept) as OAuthClient
  }
  catch {
    return undefined
  }
}

async function cacheClient(documents: Kv, href: string, client: OAuthClient): Promise<void> {
  try {
    await documents.set(href, JSON.stringify(client), CACHE_MS)
  }
  catch {
    // Fetched again on the next ask.
  }
}
