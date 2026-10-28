import type { CookieMap, Server } from 'bun'
import type { Elysia } from 'elysia'
import type { ProxyConfig } from '../config'
import type { RouteParams } from '../runtime'
import type { LocaleState } from '../runtime/locale-state'
import type { GuardedRequest } from './actions'
import type { ContextProvider, LoadedContexts } from './context-values'
import type { CacheReads } from './live'
import type { ToolCall } from './mcp'
import type { RefundableStore } from './protection'
import type { RequestContext } from './render'
import type { Namer } from './request-user'
import type { Span } from './trace'
import type { Handle } from './visit'

// What kay notes of a request while answering it, one record per request rather than one table per fact, each fact set only by the feature that reads it.
// Every field starts undefined, so every record has one shape and the hooks reading it stay fast.
export class RequestRecord {
  // The server it came through, for `clientAddress` called where only the request is at hand, as in a guard.
  server: Server<unknown> | undefined = undefined
  // The `proxy` setting of the app it reached, undefined for one setting none.
  proxy: ProxyConfig | undefined = undefined
  // The app that received it, which serves an action a library calls as a tool when no server does; held weakly, so an app nothing reaches any more goes.
  app: WeakRef<Elysia> | undefined = undefined
  // Its id, drawn on first read or passed on by a trusted proxy or a rewrite.
  id: string | undefined = undefined
  // Its URL and cookies, parsed once however many of kay's routes, hooks and scopes read them; shared, so never changed.
  url: URL | undefined = undefined
  cookies: CookieMap | undefined = undefined
  // The path the browser asked for and the socket address, for a request kay rewrote or `kay/test` sent.
  askedPath: string | undefined = undefined
  address: string | undefined = undefined
  // The tool call the MCP endpoint or a library dispatched it as.
  toolCall: ToolCall | undefined = undefined
  // What serves it whole, the app's plugins included, where kay's part of the app cannot reach them: `kay/test`'s app.
  servedThrough: Handle | undefined = undefined
  // The errors already reported for it, so the catch-all reports none twice.
  reported: Set<unknown> | undefined = undefined
  // Its context as kay's guards and handlers read it, copied once so they share it.
  sharedContext: RequestContext | undefined = undefined
  // Who answered it with a redirect, for the dev tool's Request tab.
  redirectedBy: string | undefined = undefined
  // How the libraries name its user, read only when another library asks.
  userNamers: Namer[] | undefined = undefined
  // The extensions' context modules it renders with, what they loaded, the load running and the provider it has everything loaded for.
  contextProvider: ContextProvider | undefined = undefined
  loadedContexts: LoadedContexts | undefined = undefined
  loadingContexts: Promise<boolean> | undefined = undefined
  satisfiedProvider: ContextProvider | undefined = undefined
  // The live keys a GET route's handler read, for the proof its answer carries.
  routeReads: CacheReads | undefined = undefined
  // An API request's trace span, the module it matched and its locale state.
  apiSpan: Span | undefined = undefined
  apiOwner: object | undefined = undefined
  apiLocale: LocaleState | undefined = undefined
  // A post's guards' answer, its page's params and URL, whether it is cross-site and where it was posted from (null for nowhere on this site).
  guarded: GuardedRequest | undefined = undefined
  pageParams: RouteParams | undefined = undefined
  pageUrl: URL | undefined = undefined
  crossSite: { site: string | undefined, crossSite: boolean } | undefined = undefined
  postedFrom: string | null | undefined = undefined
  // The rate limit hits an action counted, which a call that started no work takes back, and the key each limit counted it under.
  refundableHits: { store: RefundableStore, key: string, resetAt: number }[] | undefined = undefined
  countedKeys: Map<object, string> | undefined = undefined
}

const records = new WeakMap<Request, RequestRecord>()

// The record of a request, made on first use.
export function requestRecord(request: Request): RequestRecord {
  let record = records.get(request)

  if (record === undefined)
    records.set(request, record = new RequestRecord())

  return record
}

// The record of a request, if a hook made one.
export function recordOf(request: Request): RequestRecord | undefined {
  return records.get(request)
}
