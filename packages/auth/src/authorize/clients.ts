import type { Core } from '../core'
import { Buffer } from 'node:buffer'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { spend } from '../limits'
import { validRedirectUri } from './uris'

const DOCUMENT_MAX_BYTES = 10 * 1024
const DOCUMENT_TIMEOUT_MS = 5000
const CACHE_MS = 5 * 60 * 1000
const CACHE_MAX = 500
const NAME_MAX_LENGTH = 100
const REDIRECT_URIS_MAX = 10
// eslint-disable-next-line no-control-regex -- control characters are what it finds
const CONTROL = /[\0-\x1F\x7F]/g
const MAPPED_V4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/
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

// Whether an address is one a client's document must not be read from: this machine, a private network, or anything else not on the public internet.
export function privateAddress(address: string): boolean {
  const family = isIP(address)

  if (family === 4)
    return privateV4(address.split('.').map(Number))

  if (family !== 6)
    return true

  const lower = address.toLowerCase()
  const mapped = MAPPED_V4.exec(lower)

  if (mapped)
    return privateV4(mapped[1]!.split('.').map(Number))

  const group = lower.slice(0, lower.indexOf(':'))
  const first = group === '' ? 0 : Number.parseInt(group, 16)

  // ::, ::1, unique local fc00::/7, link-local fe80::/10, multicast ff00::/8, and the translation prefixes that reach IPv4 hosts.
  return lower === '::' || lower === '::1' || (first & 0xFE00) === 0xFC00 || (first & 0xFFC0) === 0xFE80 || (first & 0xFF00) === 0xFF00 || lower.startsWith('64:ff9b:') || lower.startsWith('2002:')
}

function privateV4([a = 0, b = 0, c = 0]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19))
}

// A client ID that is the URL of its own metadata document: https, with a path, no login, fragment or dot segments.
export function documentUrl(clientId: string): URL | undefined {
  if (!clientId.startsWith('https://') || clientId.length > 2048)
    return undefined

  try {
    const url = new URL(clientId)

    return url.pathname !== '/' && url.hash === '' && !clientId.includes('#') && url.username === '' && url.password === '' && url.href === clientId ? url : undefined
  }
  catch {
    return undefined
  }
}

// Reads a document over the public internet: https only, from an address that is not on a private network, with no redirect followed, a short time and a small size.
async function fetchPublicDocument(url: string): Promise<unknown> {
  const { hostname } = new URL(url)
  const host = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname
  const addresses = isIP(host) === 0 ? await lookup(host, { all: true }) : [{ address: host }]

  if (addresses.length === 0 || addresses.some(({ address }) => privateAddress(address)))
    throw new Error('the document is not on the public internet')

  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(DOCUMENT_TIMEOUT_MS), headers: { accept: 'application/json' } })

  if (response.status !== 200 || !JSON_TYPE.test(response.headers.get('content-type') ?? ''))
    throw new Error('the document did not answer 200 with JSON')

  const chunks: Uint8Array[] = []
  let size = 0

  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength

    if (size > DOCUMENT_MAX_BYTES)
      throw new Error('the document is too large')

    chunks.push(chunk)
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
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

function plainName(value: unknown): string | undefined {
  if (typeof value !== 'string')
    return undefined

  const name = value.replaceAll(CONTROL, ' ').trim().slice(0, NAME_MAX_LENGTH)

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

  if (!Array.isArray(uris) || uris.length === 0 || uris.length > REDIRECT_URIS_MAX || !uris.every(validRedirectUri))
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
  const now = Date.now()
  const known = server?.documents.get(url.href)

  if (known && known.expires > now)
    return known.client

  // Each read of a document is a request this server makes for whoever asked, so it is counted against them.
  if (!server || await spend(core.store, `oauth-document:${address}`, core.limits.oauthDocument))
    return undefined

  try {
    const client = clientOf(url, await server.fetchDocument(url.href))

    if (client) {
      if (server.documents.size >= CACHE_MAX)
        server.documents.delete(server.documents.keys().next().value!)

      server.documents.set(url.href, { client, expires: now + CACHE_MS })
    }

    return client
  }
  catch {
    return undefined
  }
}
