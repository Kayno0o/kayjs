// kay/test: in-process testing for pages, middleware, cookies, and actions — zero port binding.

import type { BuildManifest, BuildOptions } from '../build/index'
import type { KayApp, ServerOptions } from '../server/index'
import type { TrustProxy } from '../server/security'
import { build } from '../build/index'
import { createServer } from '../server/index'

export interface TestAppOptions extends Omit<BuildOptions, 'compile' | 'static'> {
  prebuilt?: boolean | undefined
  lang?: string | undefined
  security?: ServerOptions['security']
  trustedOrigins?: string[] | undefined
  trustProxy?: TrustProxy | undefined
  maxRequestBodySize?: number | undefined
}

export interface TestApp {
  readonly app: KayApp
  readonly manifest: BuildManifest | undefined
  readonly cookies: Map<string, string>
  fetch(pathOrReq: string | Request, init?: RequestInit): Promise<Response>
  get(path: string, headers?: HeadersInit): Promise<Response>
  post(path: string, body?: unknown, headers?: HeadersInit): Promise<Response>
  submit(actionUrl: string, fields: Record<string, string>, headers?: HeadersInit): Promise<Response>
  clearCookies(): void
}

export async function testApp(options: TestAppOptions): Promise<TestApp> {
  const manifest = options.prebuilt ? undefined : await build({
    root: options.root,
    routesDir: options.routesDir,
    outDir: options.outDir,
    minify: options.minify ?? false,
    assetPrefix: options.assetPrefix,
    plugins: options.plugins,
  })

  const app = await createServer({
    root: options.root,
    outDir: options.outDir,
    assetPrefix: options.assetPrefix,
    lang: options.lang,
    security: options.security,
    trustedOrigins: options.trustedOrigins,
    trustProxy: options.trustProxy,
    maxRequestBodySize: options.maxRequestBodySize,
    plugins: options.plugins,
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
    submit(actionUrl, fields, headers) {
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
