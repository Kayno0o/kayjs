import type { Seed } from '../runtime/live-resource.server'
import { readAnswer, RESOURCES_SCRIPT } from '../runtime/live'
import { collectResources } from '../runtime/live-resource.server'
import { knownAddress, requestServer } from './protection'
import { recordOf, requestRecord } from './request-record'
import { readPersonally } from './scope'
import { visitAs } from './visit'

// Thrown by a page render that left routes unanswered, for `withResources` to ask them and render again.
export class ResourcesPending extends Error {
  constructor(readonly wanted: ReadonlyMap<string, string>) {
    super('kay: a resource() asked for a route the render waits for')
  }
}

// A page asking for routes that depend on one another settles in this many passes; what is left renders `loading`.
const MAX_PASSES = 3

// How long the server waits for a route before the browser asks it itself.
export const limits = { routeTimeout: 5000 }
// The most JSON characters one answer may add to the page; a larger one renders `loading` and the browser asks the route itself.
export const SEED_LIMIT = 65_536
// An answer that says it is private to the request, for a visitor the page does not already treat as personal, or sets a cookie, is not the page's to freeze.
const PERSONAL_ANSWER = /(?:^|[\s,])(?:private|no-store)(?:$|[\s,])/i
// What the visitor's request carries that its page does not mean for an API route: a body, a condition on a copy the browser holds, a range, the navigation's own marks.
const NOT_FORWARDED = ['content-length', 'content-type', 'transfer-encoding', 'if-none-match', 'if-modified-since', 'if-match', 'if-unmodified-since', 'if-range', 'range', 'upgrade', 'upgrade-insecure-requests', 'connection', 'expect', 'te', 'purpose', 'sec-purpose', 'sec-fetch-user']

// Renders a page and, when its islands read routes with `resource()`, asks those routes in process as the visitor, then renders it again with their answers: a guard refusing or a route failing leaves that island `loading` for the browser.
// `render` throws `ResourcesPending` as soon as a pass left a route unanswered, before it starts anything a second render would repeat.
export async function withResources<T>(request: Request, render: () => T): Promise<T> {
  const seeds = new Map<string, Seed | null>()

  for (let pass = 1; ; pass++) {
    try {
      return collectResources(seeds, render, pass === MAX_PASSES)
    }
    catch (thrown) {
      if (!(thrown instanceof ResourcesPending))
        throw thrown

      await Promise.all([...thrown.wanted].map(async ([key, url]) => seeds.set(key, await answer(request, url))))
    }
  }
}

function visitorHeaders(request: Request): Headers {
  const headers = new Headers(request.headers)

  for (const name of NOT_FORWARDED)
    headers.delete(name)

  headers.set('accept', 'application/json')
  // The answer is read here as it is, never decoded.
  headers.set('accept-encoding', 'identity')
  // The page the browser would fetch from, which an API route reads its locale off.
  headers.set('referer', request.url)
  headers.set('sec-fetch-site', 'same-origin')
  headers.set('sec-fetch-mode', 'cors')
  headers.set('sec-fetch-dest', 'empty')

  return headers
}

// What the route answers the visitor, asked at the path the server routes (a `base` is taken off before the app sees it), as the browser's fetch would read it; null for a refusal, a failure, a late answer or a file.
async function answer(request: Request, url: string): Promise<Seed | null> {
  const late = new AbortController()
  const timer = setTimeout(() => late.abort(), limits.routeTimeout)

  try {
    // A route ignoring the signal must not hold the page past the timeout.
    return await Promise.race([
      asked(request, url, late.signal),
      new Promise<null>(resolve => late.signal.addEventListener('abort', () => resolve(null), { once: true })),
    ])
  }
  finally {
    clearTimeout(timer)
  }
}

async function asked(request: Request, url: string, late: AbortSignal): Promise<Seed | null> {
  const visit = new Request(new URL(url, request.url), { headers: visitorHeaders(request), signal: AbortSignal.any([request.signal, late]) })
  const server = requestServer(request)
  const address = knownAddress(request, server)

  if (address !== undefined)
    requestRecord(visit).address = address

  // The answer may differ by visitor, so the page it lands in must not be shared.
  const personal = request.headers.has('cookie') || request.headers.has('authorization')

  if (personal)
    readPersonally(request)

  try {
    const response = await visitAs(request, visit, server, async (next) => {
      const app = recordOf(request)?.app?.deref()

      if (app === undefined)
        throw new Error('kay: no app to ask the route')

      return app.handle(next)
    })

    if (!response.ok) {
      await response.body?.cancel()

      return null
    }

    if (response.headers.has('set-cookie') || (!personal && PERSONAL_ANSWER.test(response.headers.get('cache-control') ?? ''))) {
      await response.body?.cancel()

      return null
    }

    const value = await readAnswer(response)

    return value instanceof Blob || JSON.stringify(value).length > SEED_LIMIT ? null : { value, proof: response.headers.get('x-kay-live') }
  }
  catch {
    return null
  }
}

// What the page hands the browser so its islands hydrate with the answers the server rendered them with.
export function resourcesScript(used: ReadonlyMap<string, Seed> | undefined): string {
  if (used === undefined || used.size === 0)
    return ''

  return `<script type="application/json" ${RESOURCES_SCRIPT}>${JSON.stringify(Object.fromEntries(used)).replaceAll('<', '\\u003c')}</script>`
}
