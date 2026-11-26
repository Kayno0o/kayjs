// @kayjs/kay/test: in-process testing for pages, middleware, cookies, and actions — zero port binding.

import type { BuildManifest, BuildOptions } from '../build/index'
import type { KayApp, ServerAction, ServerRuntimeConfig } from '../server/index'
import { resolve } from 'node:path'
import { build } from '../build/index'
import { relPosix } from '../build/files'
import { resolveServerConfig } from '../server/index'
import { startBuiltApp } from '../server/loader'

export interface TestAppOptions extends Omit<BuildOptions, 'compile' | 'static'>, Partial<ServerRuntimeConfig> {
  prebuilt?: boolean | undefined
}

export interface TestApp {
  readonly app: KayApp
  readonly manifest: BuildManifest | undefined
  readonly cookies: Map<string, string>
  /** The unhandled route, action and plugin errors seen since the app started, as `route GET /path: message`; a response that is a 500 has one here. */
  readonly errors: string[]
  fetch(pathOrReq: string | Request, init?: RequestInit): Promise<Response>
  get(path: string, headers?: HeadersInit): Promise<Response>
  post(path: string, body?: unknown, headers?: HeadersInit): Promise<Response>
  /** The app's own bundled copy of a route, layout, middleware, action file or `kay.config.ts`, by path from the root. */
  import(path: string): Promise<Record<string, unknown>>
  /** Posts `fields` as a form to an action, given as one from `import()` or as its URL. */
  submit(action: ServerAction<never, unknown> | string, fields: Record<string, string>, headers?: HeadersInit): Promise<Response>
  clearCookies(): void
}

export async function testApp(options: TestAppOptions): Promise<TestApp> {
  const manifest = options.prebuilt ? undefined : await build({
    root: options.root,
    routesDir: options.routesDir,
    outDir: options.outDir,
    minify: options.minify ?? false,
    assetPrefix: options.assetPrefix,
    site: options.site,
    plugins: options.plugins,
  })

  const errors: string[] = []
  const { app, entry } = await startBuiltApp({
    root: options.root,
    outDir: options.outDir,
    dev: options.dev,
    ...resolveServerConfig(undefined, options),
    errorSink: ({ error, request, source }) => {
      errors.push(`${source} ${request.method} ${new URL(request.url).pathname}: ${error instanceof Error ? error.message : String(error)}`)
    },
  })

  const cookies = new Map<string, string>()

  function cookieHeader(): string | undefined {
    if (cookies.size === 0)
      return undefined
    return [...cookies.entries()].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ')
  }

  function storeSetCookies(res: Response): void {
    const list = res.headers.getSetCookie?.() ?? []
    for (const raw of list) {
      const first = raw.split(';')[0] ?? ''
      const eq = first.indexOf('=')
      if (eq <= 0)
        continue
      const name = first.slice(0, eq).trim()
      const val = first.slice(eq + 1).trim()
      if (/max-age=0/i.test(raw) || val === '')
        cookies.delete(name)
      else
        cookies.set(name, decodeURIComponent(val))
    }
  }

  async function doFetch(pathOrReq: string | Request, init?: RequestInit): Promise<Response> {
    const req = typeof pathOrReq === 'string'
      ? new Request(pathOrReq.startsWith('http') ? pathOrReq : `http://localhost${pathOrReq}`, init)
      : pathOrReq

    const headers = new Headers(req.headers)
    const existing = cookieHeader()
    if (existing !== undefined && !headers.has('cookie'))
      headers.set('cookie', existing)

    const withCookies = new Request(req, { headers })
    const res = await app.handle(withCookies)
    storeSetCookies(res)
    return res
  }

  return {
    app,
    manifest,
    cookies,
    errors,
    fetch: doFetch,
    get(path, headers) {
      return doFetch(path, headers !== undefined ? { method: 'GET', headers } : { method: 'GET' })
    },
    post(path, body, headers) {
      const h = new Headers(headers)
      if (!h.has('origin'))
        h.set('origin', 'http://localhost')
      if (body instanceof FormData)
        return doFetch(path, { method: 'POST', body, headers: h })
      if (!h.has('content-type'))
        h.set('content-type', 'application/json')
      if (!h.has('accept'))
        h.set('accept', 'application/json')
      return doFetch(path, {
        method: 'POST',
        body: body === undefined ? '{}' : JSON.stringify(body),
        headers: h,
      })
    },
    async import(path) {
      const source = relPosix(options.root, resolve(options.root, path))
      const mod = entry?.sources[source]
      if (mod === undefined)
        throw new Error(`kay: testApp().import('${path}') found no bundled module. Only routes, layouts, middlewares, action files and kay.config.ts are bundled entries; reach ${source} through one of them.`)
      return mod
    },
    submit(action, fields, headers) {
      const actionUrl = typeof action === 'string' ? action : action.url
      if (actionUrl === '')
        throw new Error('kay: testApp().submit() got an action with no URL. Pass one from `await app.import(path)`, not one the test file imported itself.')
      const fd = new FormData()
      for (const [k, v] of Object.entries(fields))
        fd.append(k, v)
      const h = new Headers(headers)
      if (!h.has('origin'))
        h.set('origin', 'http://localhost')
      return doFetch(actionUrl, { method: 'POST', body: fd, headers: h })
    },
    clearCookies() {
      cookies.clear()
    },
  }
}

export { testBrowser } from './browser'
export type { BrowserPage, BrowserTest, BrowserTestOptions } from './browser'
