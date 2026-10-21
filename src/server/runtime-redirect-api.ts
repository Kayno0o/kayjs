import type { Elysia } from 'elysia'
import type { TrailingSlash } from '../config'
import type { RedirectStatus } from './redirects'
import type { RuntimeRedirect, RuntimeRules, RuntimeStatus } from './runtime-redirects'
import { existsSync } from 'node:fs'
import { joinBase } from '../runtime/base'
import { kayLog } from '../runtime/log'
import { pathOf } from './log'
import { countedPath, dropStore, isPageRequest, missingStore, NOT_FOUND_FILE, sharedStore, storeFile } from './not-found'
import { requestUrl } from './request-url'
import { answerFor } from './runtime-redirects'

const NOT_FOUND = 404
const DOT_SEGMENT = /\.[^/]+$/
const QUERY_OR_HASH = /[?#]/
const TRAILING_SLASHES = /\/+$/

let rules: RuntimeRules = { hosts: [], configured: {} }
let hosts: readonly string[] = []
let pagesOf: (() => string[]) | undefined
let statuses: Record<string, RedirectStatus> = {}

// What the running app lets an editor add, from its config: the redirects of kay.config.ts, which win and count in a chain; the hosts a target may name besides the site's own; the paths the site serves.
export function knowRuntimeRules(options: { redirects: Record<string, string>, statuses?: Record<string, RedirectStatus> | undefined, hosts?: readonly string[] | undefined, served?: (() => string[]) | undefined, pages?: (() => string[]) | undefined }): void {
  hosts = (options.hosts ?? []).map(host => host.toLowerCase())
  rules = { hosts, configured: options.redirects, served: options.served }
  statuses = options.statuses ?? {}
  pagesOf = options.pages
}

// The redirects of kay.config.ts, which an editor reads and cannot change.
export function configuredRedirects(): { from: string, to: string, status: RedirectStatus }[] {
  return Object.entries(rules.configured).map(([from, to]) => ({ from, to, status: statuses[from] ?? 308 }))
}

// The pages the running site serves, for a screen to offer as a redirect's target: none before the server knows them.
export function sitePaths(): string[] {
  return pagesOf ? [...new Set(pagesOf())].sort() : []
}

// Runs `use` on the store of the running server, else on the file opened for the call.
// A file that does not exist is created by a write and skipped by a read.
function inStore<T>(file: string | undefined, write: boolean, use: (store: ReturnType<typeof missingStore>) => T): T | undefined {
  if (file === undefined && sharedStore(storeFile(), false))
    return use(sharedStore(storeFile(), false)!)

  const path = file ?? NOT_FOUND_FILE

  if (!write && !existsSync(path))
    return undefined

  const store = missingStore(path, false)

  try {
    return use(store)
  }
  finally {
    store.close()
  }
}

// The redirects editors added, newest first, which the server answers a missing path with when `kay.config.ts` has none for it.
export function runtimeRedirects(file?: string): RuntimeRedirect[] {
  return inStore(file, false, store => store.redirects.list()) ?? []
}

// Adds a redirect from a path nothing serves, to a path of this site (or a host `runtimeRedirects.hosts` allows), and forgets the path in the list of missing ones.
// Throws, saying why, for a path or target it refuses: a loop, a target nothing serves, another site.
export function addRuntimeRedirect(from: string, to: string, options: { status?: RuntimeStatus | undefined, file?: string | undefined } = {}): RuntimeRedirect {
  return inStore(options.file, true, (store) => {
    const added = store.redirects.add(from, to, options.status, rules)

    store.forget(added.from)

    return added
  })!
}

// Removes a redirect, and says whether there was one.
export function removeRuntimeRedirect(from: string, file?: string): boolean {
  return inStore(file, false, store => store.redirects.remove(from)) ?? false
}

// The target as `trailingSlash` writes a page's path: with a slash under `always`, without under `never`, as written under `ignore`; a file's path, a target with a query and another site's keep theirs.
function slashed(location: string, trailingSlash: TrailingSlash | undefined): string {
  if (!location.startsWith('/') || QUERY_OR_HASH.test(location) || DOT_SEGMENT.test(location) || location === '/')
    return location

  if (trailingSlash === 'always')
    return location.endsWith('/') ? location : `${location}/`

  return trailingSlash === 'ignore' ? location : location.replace(TRAILING_SLASHES, '')
}

export interface MissingRedirector {
  // A page answering 404, such as a dynamic one finding no entry or `_404.kay`.
  pages: <App extends Elysia>(app: App) => App
  // A path no route takes, which Elysia answers with its own 404.
  unrouted: <App extends Elysia>(app: App) => App
}

// Answers a page request that found nothing with the redirect an editor added for its path, if there is one, in two hooks registered apart: the `mapResponse` ahead of compression, which would answer a 404 page first, and the `onError`, which reaches only the routes added after it.
// Every other response costs one comparison of its status.
export function missingRedirector(options: { file?: string | undefined, trailingSlash?: TrailingSlash | undefined, base?: string | undefined }): MissingRedirector {
  const file = storeFile(options.file)
  let told = false

  const answer = (request: Request): Response | undefined => {
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return undefined

    const path = countedPath(pathOf(request.url))

    if (path === undefined)
      return undefined

    let found: ReturnType<typeof answerFor>

    try {
      const store = sharedStore(file, false)

      found = store && answerFor(store.redirects, path, requestUrl(request).search, hosts)
    }
    catch (error) {
      dropStore()

      if (!told) {
        told = true
        kayLog('warn', `the redirects added while the site runs cannot be read from ${file}: ${error instanceof Error ? error.message : String(error)}`)
      }

      return undefined
    }

    if (!found)
      return undefined

    if (found.status === 410)
      return new Response('Gone', { status: 410, headers: { 'content-type': 'text/plain; charset=utf-8' } })

    // A location Bun refuses as a header answers the 404 it would have, and leaves the store open.
    try {
      return new Response(null, { status: found.status, headers: { location: joinBase(options.base ?? '', slashed(found.location, options.trailingSlash)) } })
    }
    catch {
      return undefined
    }
  }

  return {
    pages(app) {
      app.mapResponse({ as: 'global' }, ({ request, set, responseValue, route }) => {
        const answered = responseValue instanceof Response ? responseValue : undefined
        const status = answered ? answered.status : set.status

        if (status !== NOT_FOUND || (route && !isPageRequest(request)) || answered?.headers.get('content-type')?.includes('json') === true)
          return undefined

        return answer(request)
      })

      return app
    },
    unrouted(app) {
      app.onError({ as: 'global' }, ({ code, request }) => code === 'NOT_FOUND' ? answer(request) : undefined)

      return app
    },
  }
}
