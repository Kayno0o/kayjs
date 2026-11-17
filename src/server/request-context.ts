import type { RouteRecord } from './kay-routes'
import { AsyncLocalStorage } from 'node:async_hooks'
import { requestCookies } from './cookies'
import { requestUrl } from './request-url'
import { Denied } from './signals'

// What a handler writes to the answer: the status and the headers, folded into the Response once, at the end. It is apart from `headers`, which reads the request.
export interface ResponseSet {
  status: number | undefined
  headers: Headers
}

type Params = Record<string, string>
type Fields = Record<string, string | string[]>

function addField(fields: Record<string, unknown>, key: string, value: unknown): void {
  const held = fields[key]

  if (held === undefined)
    fields[key] = value
  else
    fields[key] = Array.isArray(held) ? [...held, value] : [held, value]
}

// The query as an object, a name given twice holding both values; a name such as `__proto__` is a key like any other.
function queryOf(url: URL): Fields {
  const fields: Fields = Object.create(null) as Fields

  for (const [key, value] of url.searchParams)
    addField(fields, key, value)

  return fields
}

// What the body holds as its type says: JSON parsed, a form read into fields (a file kept as a File), text as it is, any other body as bytes, and none as undefined.
async function readBody(request: Request): Promise<unknown> {
  if (request.body === null)
    return undefined

  const type = request.headers.get('content-type') ?? ''

  if (type.startsWith('application/json') || type.includes('+json')) {
    try {
      return await request.json()
    }
    catch {
      throw new Denied(400, 'The body is not valid JSON')
    }
  }

  if (type.startsWith('application/x-www-form-urlencoded') || type.startsWith('multipart/form-data')) {
    const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>

    try {
      for (const [key, value] of (await request.formData()).entries())
        addField(fields, key, value)
    }
    catch {
      throw new Denied(400, 'The body is not a valid form')
    }

    return fields
  }

  return type.startsWith('text/') ? request.text() : request.arrayBuffer()
}

// The one context of a request kay answers from its table, whatever the route kind: what it reads of the request is parsed on first read, once.
export class RequestContext {
  readonly request: Request
  // The route's params, decoded once from the path, empty while `malformed`.
  readonly params: Params
  // Whether a param held an escape that does not decode, which the `input` phase refuses with a 400.
  readonly malformed: boolean
  readonly locale: string | undefined
  readonly route: RouteRecord | undefined
  // What the phases before the handler hand on, such as a plugin's or a guard's values.
  readonly locals: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  #query: Fields | undefined
  #body: Promise<unknown> | undefined
  #set: ResponseSet | undefined

  constructor(request: Request, route: RouteRecord | undefined, params: Params | undefined, locale?: string) {
    this.request = request
    this.route = route
    this.malformed = params === undefined
    this.params = params ?? {}
    this.locale = locale ?? route?.locale
  }

  get url(): URL {
    return requestUrl(this.request)
  }

  get method(): string {
    return this.request.method
  }

  // The request's headers; the answer's are written through `set`.
  get headers(): Headers {
    return this.request.headers
  }

  get query(): Fields {
    return this.#query ??= queryOf(this.url)
  }

  get cookies(): Pick<Bun.CookieMap, 'get' | 'has'> {
    return requestCookies(this.request)
  }

  // The parsed body, a promise as reading it waits for the bytes; a malformed one refuses with a 400 when it is read.
  get body(): Promise<unknown> {
    return this.#body ??= readBody(this.request)
  }

  // Made when the handler first writes to it, so a route that sets nothing allocates nothing.
  get set(): ResponseSet {
    return this.#set ??= { status: undefined, headers: new Headers() }
  }

  // The answer's status and headers a handler set, if it set any.
  get written(): ResponseSet | undefined {
    return this.#set
  }
}

const scopes = new AsyncLocalStorage<RequestContext>()

// The context of the request kay is answering in this async context, a handler running after a macrotask included.
export function requestContext(): RequestContext | undefined {
  return scopes.getStore()
}

export function inContext<T>(context: RequestContext, run: () => T): T {
  return scopes.run(context, run)
}
