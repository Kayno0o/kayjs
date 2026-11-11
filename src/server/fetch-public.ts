import type { Resolver } from './address'
import { ipVersion, isPublicAddress, pinnedLookup, PrivateAddressError, resolveHost } from './address'
import { FETCH_TIMEOUT_MS } from './config-limits'

const BRACKETS = /^\[|\]$/g
const DEFAULT_MAX_BYTES = 1024 * 1024
// The only headers a redirect to another origin keeps: a credential, a cookie or an API key the caller set is for the first origin alone.
const KEPT_ACROSS_ORIGINS = new Set(['accept', 'accept-language', 'user-agent'])

export interface FetchPublicOptions {
  // How long the whole exchange, body included, may take, in milliseconds. Default 10 seconds.
  timeout?: number | undefined
  // The most body bytes read, counted as they arrive and never taken from `Content-Length`. Default 1 MiB.
  maxBytes?: number | undefined
  // How many redirects are followed, each hop checked as the first was, or 'error' (the default) to refuse the first one.
  redirect?: number | 'error' | undefined
  // Sent on the first request, and on each redirect hop to the same origin; a hop to another origin gets `accept`, `accept-language` and `user-agent` only.
  headers?: Record<string, string> | undefined
  // Only a test replaces these two: the name lookup, and which hosts may be at a private address.
  resolve?: Resolver | undefined
  allowPrivate?: ((host: string) => boolean) | undefined
}

// One GET that resolves the host itself and connects to the address it checked, never one `fetch` would resolve again after the check. A literal address is checked as it stands. A redirect is answered as it is.
export async function pinnedGet(url: URL, headers: Record<string, string>, signal: AbortSignal, resolve: Resolver, allowPrivate: boolean): Promise<Response> {
  const hostname = url.hostname.replace(BRACKETS, '')

  if (!allowPrivate && ipVersion(hostname) !== 0 && !isPublicAddress(hostname))
    throw new PrivateAddressError(`${hostname} is not a public address`)

  // Loaded here, so an executable that downloads nothing remote never loads them.
  const [{ request: httpRequest }, { request: httpsRequest }, { Readable }] = await Promise.all([import('node:http'), import('node:https'), import('node:stream')])
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest

  return new Promise((done, fail) => {
    const request = send(url, { method: 'GET', headers: { 'user-agent': 'kay', ...headers, 'accept-encoding': 'identity' }, signal, lookup: pinnedLookup(resolve, allowPrivate) as never }, (incoming) => {
      try {
        const answer = new Headers()

        for (const [name, value] of Object.entries(incoming.headers)) {
          for (const each of Array.isArray(value) ? value : [value]) {
            if (each !== undefined)
              answer.append(name, each)
          }
        }

        const status = incoming.statusCode ?? 502
        const empty = status === 204 || status === 205 || status === 304

        if (empty)
          incoming.resume()

        done(new Response(empty ? null : Readable.toWeb(incoming) as unknown as ReadableStream, { status, headers: answer }))
      }
      catch (error) {
        // A status `Response` refuses, such as 999, would otherwise throw inside the event and leave the promise pending.
        incoming.destroy()
        fail(error)
      }
    })

    request.on('error', fail)
    request.end()
  })
}

// The body, or an error once it passes `maxBytes`, the stream cut there.
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = []
  let size = 0

  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength

    if (size > maxBytes)
      throw new Error(`the body is over ${maxBytes} bytes`)

    chunks.push(chunk)
  }

  return Buffer.concat(chunks)
}

// Fetches a URL on the public internet: the host is resolved once and refused unless every answer is a public address, the connection goes to that checked address, and every redirect hop is checked again. The answer is whole, with its body read within `maxBytes` and `timeout`.
export async function fetchPublic(url: string | URL, options: FetchPublicOptions = {}): Promise<Response> {
  const { timeout = FETCH_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES, redirect = 'error', resolve = resolveHost, allowPrivate } = options
  let headers = options.headers ?? {}
  const signal = AbortSignal.timeout(timeout)
  let target = new URL(url)

  for (let hops = 0; ; hops++) {
    if (target.protocol !== 'http:' && target.protocol !== 'https:')
      throw new Error(`${target.href} is not an http or https URL`)

    const response = await pinnedGet(target, headers, signal, resolve, allowPrivate?.(target.hostname.replace(BRACKETS, '')) ?? false)
    const location = response.headers.get('location')

    if (response.status >= 300 && response.status < 400 && location !== null) {
      await response.body?.cancel()

      if (redirect === 'error' || hops >= redirect)
        throw new Error(`${target.href} redirects, which is not followed`)

      const next = new URL(location, target)

      if (next.origin !== target.origin)
        headers = Object.fromEntries(Object.entries(headers).filter(([name]) => KEPT_ACROSS_ORIGINS.has(name.toLowerCase())))

      target = next

      continue
    }

    const body = response.body === null ? null : await readCapped(response, maxBytes)

    return new Response(body, { status: response.status, headers: response.headers })
  }
}
