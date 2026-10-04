import type { Action, Success } from '../runtime/action'
import type { PagesOptions } from '../server/app'
import type { ClientBuild } from '../server/client'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { Elysia } from 'elysia'
import { withConfig } from '../config'
import { encodeCall, readActionResponse } from '../runtime/action'
import { servePages } from '../server/app'

export interface TestOptions extends PagesOptions {
  // What the app's Elysia `derive` would add for a request, such as the signed-in user, read by pages, guards and actions as `ctx.locals`.
  locals?: (request: Request) => Record<string, unknown> | Promise<Record<string, unknown>>
}

export interface Visit {
  // Where the last redirect led, path and query.
  url: string
  status: number
  headers: Headers
  html: string
}

export interface VisitInit {
  headers?: Record<string, string>
}

// A text field, or a file input's `File`.
export type FormValue = string | Blob

export interface TestSite {
  // A GET as a browser makes it: earlier cookies sent, redirects followed.
  visit: (path: string, init?: VisitInit) => Promise<Visit>
  // A plain form post from the page at `from`, multipart as kay's forms send it, followed back to wherever the action sends the browser.
  submit: <Input>(action: Action<Input, unknown>, fields: Partial<Record<Extract<keyof Input, string>, FormValue | FormValue[]>>, init?: VisitInit & { from?: string }) => Promise<Visit>
  // The call an island makes: the result, an `ActionError` thrown, or an `ActionRedirect` when it redirects.
  call: <Input, Output>(action: Action<Input, Output>, input: Input, init?: VisitInit) => Promise<Success<Output>>
  cookies: Bun.CookieMap
  handle: (request: Request) => Promise<Response>
}

const ORIGIN = 'http://localhost'
const MAX_REDIRECTS = 10

// The project's pages and actions without a server or a browser build: pages render their islands' markup and no scripts.
export async function testSite(options: TestOptions = {}): Promise<TestSite> {
  const root = resolve(options.root ?? process.cwd())
  const config = await withConfig(root, options)
  const client: ClientBuild = { entryImports: [], islands: {}, styles: new Map(), pages: new Map(), dir: join(root, '.kay', 'client', 'dist') }
  const pages = await servePages(root, config, async () => client)
  const locals = options.locals
  const app = locals ? new Elysia().derive({ as: 'global' }, async ({ request }) => locals(request)).use(pages) : pages
  const cookies = new Bun.CookieMap()

  const send = async (path: string, init: RequestInit & VisitInit): Promise<Response> => {
    const headers = new Headers(init.headers)
    const sent = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ')

    if (sent !== '')
      headers.set('cookie', sent)

    const response = await app.handle(new Request(new URL(path, ORIGIN), { ...init, headers, redirect: 'manual' }))

    for (const header of response.headers.getSetCookie()) {
      const cookie = Bun.Cookie.parse(header)

      if (cookie.isExpired())
        cookies.delete(cookie.name)
      else
        cookies.set(cookie)
    }

    return response
  }

  const follow = async (response: Response, url: string, headers?: Record<string, string>): Promise<Visit> => {
    let current = response
    let path = url

    for (let redirects = 0; current.status >= 300 && current.status < 400 && current.headers.has('location'); redirects++) {
      if (redirects === MAX_REDIRECTS)
        throw new Error(`kay: more than ${MAX_REDIRECTS} redirects from ${url}`)

      const next = new URL(current.headers.get('location')!, new URL(path, ORIGIN))

      // Another site is not this app's to answer, so the visit ends at the redirect.
      if (next.origin !== ORIGIN)
        break

      path = next.pathname + next.search
      current = await send(path, { headers })
    }

    return { url: path, status: current.status, headers: current.headers, html: await current.text() }
  }

  return {
    cookies,
    handle: async request => app.handle(request),
    visit: async (path, init = {}) => follow(await send(path, { headers: init.headers }), path, init.headers),
    submit: async (action, fields, init = {}) => {
      const from = init.from ?? '/'
      const form = new FormData()

      for (const [name, value] of Object.entries(fields as Record<string, FormValue | FormValue[] | undefined>)) {
        for (const item of Array.isArray(value) ? value : [value]) {
          if (item !== undefined)
            form.append(name, item)
        }
      }

      const response = await send(action.url, {
        method: 'POST',
        headers: { origin: ORIGIN, referer: new URL(from, ORIGIN).href, ...init.headers },
        body: form,
      })

      return follow(response, from, init.headers)
    },
    call: async (action, input, init = {}) => {
      const { headers, body } = encodeCall(input)

      return readActionResponse(await send(action.url, { method: 'POST', headers: { ...headers, origin: ORIGIN, ...init.headers }, body }))
    },
  }
}
