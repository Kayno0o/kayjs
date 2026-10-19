import type { LookupFunction } from 'node:net'
import type { Core } from '../core'
import { Buffer } from 'node:buffer'
import { lookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { spend } from '../limits'
import { validRedirectUris } from './uris'

const DOCUMENT_MAX_BYTES = 10 * 1024
const DOCUMENT_TIMEOUT_MS = 5000
const CACHE_MS = 5 * 60 * 1000
const CACHE_MAX = 500
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

// The 16 bytes of an IPv6 address, an embedded dotted IPv4 tail included.
export function v6Bytes(address: string): number[] | undefined {
  let text = address.toLowerCase()
  const zone = text.indexOf('%')

  if (zone !== -1)
    text = text.slice(0, zone)

  const dotted = !text.includes('.') ? undefined : text.slice(text.lastIndexOf(':') + 1).split('.').map(Number)

  if (dotted)
    text = `${text.slice(0, text.lastIndexOf(':') + 1)}${((dotted[0]! << 8) | dotted[1]!).toString(16)}:${((dotted[2]! << 8) | dotted[3]!).toString(16)}`

  const halves = text.split('::')

  if (halves.length > 2)
    return undefined

  const groups = (part: string) => part === '' ? [] : part.split(':').map(group => Number.parseInt(group, 16))
  const head = groups(halves[0]!)
  const tail = halves.length === 2 ? groups(halves[1]!) : []
  const all = halves.length === 2 ? [...head, ...Array.from<number>({ length: Math.max(0, 8 - head.length - tail.length) }).fill(0), ...tail] : head

  return all.length === 8 && all.every(group => Number.isInteger(group) && group >= 0 && group <= 0xFFFF) ? all.flatMap(group => [group >> 8, group & 0xFF]) : undefined
}

// Whether an address is one a client's document must not be read from: this machine, a private network, or anything else not on the public internet.
export function privateAddress(address: string): boolean {
  const family = isIP(address)

  if (family === 4)
    return privateV4(address.split('.').map(Number))

  const bytes = family === 6 ? v6Bytes(address) : undefined

  if (!bytes)
    return true

  const zeros = (from: number, to: number) => bytes.slice(from, to).every(byte => byte === 0)

  // IPv4 inside IPv6: ::/96 (compatible), ::ffff:0:0/96 (mapped) and ::ffff:0:0:0/96 (translated) are the IPv4 host's own.
  const mapped = zeros(0, 10) && bytes[10] === 0xFF && bytes[11] === 0xFF
  const translated = zeros(0, 8) && bytes[8] === 0xFF && bytes[9] === 0xFF && bytes[10] === 0 && bytes[11] === 0

  if (mapped || zeros(0, 12) || translated)
    return privateV4(bytes.slice(12))

  const first = (bytes[0]! << 8) | bytes[1]!
  const second = (bytes[2]! << 8) | bytes[3]!

  // Only global unicast 2000::/3 is public, minus Teredo 2001::/32, documentation 2001:db8::/32 and 6to4 2002::/16.
  return (first & 0xE000) !== 0x2000 || (first === 0x2001 && (second === 0 || second === 0x0DB8)) || first === 0x2002
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
// The name is resolved once, by the connection itself, so the address checked is the one connected to and a DNS answer changing in between cannot lead elsewhere.
// `refuses` tells the addresses not to connect to and `resolve` looks a name up; only a test replaces them.
export async function fetchPublicDocument(url: string, refuses: (address: string) => boolean = privateAddress, resolve: (host: string) => Promise<{ address: string, family?: number }[]> = async host => lookup(host, { all: true })): Promise<unknown> {
  const { hostname } = new URL(url)
  const host = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname
  const notPublic = () => new Error('the document is not on the public internet')

  if (isIP(host) !== 0 && refuses(host))
    throw notPublic()

  async function checked(name: string): Promise<{ address: string, family: number }[]> {
    const addresses = await resolve(name)

    if (addresses.length === 0 || addresses.some(({ address }) => refuses(address)))
      throw notPublic()

    return addresses.map(({ address }) => ({ address, family: isIP(address) }))
  }

  const connectTo = ((name, options, done) => {
    void (async () => {
      try {
        const addresses = await checked(name)

        if (options.all)
          (done as unknown as (error: null, addresses: { address: string, family: number }[]) => void)(null, addresses)
        else
          done(null, addresses[0]!.address, addresses[0]!.family)
      }
      catch (error) {
        done(error as Error, '', 0)
      }
    })()
  }) as LookupFunction

  const send = url.startsWith('https:') ? https.request : http.request

  return new Promise((resolveDocument, reject) => {
    const request = send(url, { lookup: connectTo, headers: { 'accept': 'application/json', 'accept-encoding': 'identity' }, signal: AbortSignal.timeout(DOCUMENT_TIMEOUT_MS) }, (response) => {
      if (response.statusCode !== 200 || !JSON_TYPE.test(response.headers['content-type'] ?? '')) {
        response.destroy()
        reject(new Error('the document did not answer 200 with JSON'))

        return
      }

      const chunks: Buffer[] = []
      let size = 0

      response.on('data', (chunk: Buffer) => {
        size += chunk.byteLength

        if (size > DOCUMENT_MAX_BYTES) {
          response.destroy()
          reject(new Error('the document is too large'))

          return
        }

        chunks.push(chunk)
      })
      response.on('end', () => {
        try {
          resolveDocument(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
        }
        catch (error) {
          reject(error)
        }
      })
      response.on('error', reject)
    })

    request.on('error', reject)
    request.end()
  })
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
