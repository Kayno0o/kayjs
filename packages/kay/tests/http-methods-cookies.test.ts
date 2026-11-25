// Regression tests for #3541: HEAD falls back to GET everywhere, unsupported methods return 405 + Allow
// before any middleware runs, invalid cookies throw, and ActionContext has no dead params field.

import type { ActionContext } from '../src/server/index'
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from '../src/build/index'
import { CookieStore } from '../src/server/cookies'
import { createServer, definePlugin } from '../src/server/index'

describe('#3541 HTTP methods, pre-middleware 405, cookies & ActionContext', () => {
  test('HEAD falls back to GET on API routes, pages, and plugin routes without returning a body', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-3541-head-'))
    try {
      mkdirSync(join(dir, 'src/routes/api'), { recursive: true })
      writeFileSync(join(dir, 'src/routes/index.tsx'), 'export default function Home() { return <h1>hello</h1> }\n')
      writeFileSync(join(dir, 'src/routes/api/items.ts'), `
export function GET() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-custom': 'yes' },
  })
}
`)

      const plugin = definePlugin({
        name: 'head-test',
        server(api) {
          api.route('GET', '/plugin/ping', () => new Response('pong', { headers: { 'x-plugin': '1' } }))
        },
      })

      await build({ root: dir, plugins: [plugin], prerender: false })
      const app = await createServer({ root: dir, plugins: [plugin] })

      const apiHead = await app.handle(new Request('http://localhost/api/items', { method: 'HEAD' }))
      expect(apiHead.status).toBe(200)
      expect(apiHead.headers.get('x-custom')).toBe('yes')
      expect(await apiHead.text()).toBe('')

      const pageHead = await app.handle(new Request('http://localhost/', { method: 'HEAD' }))
      expect(pageHead.status).toBe(200)
      expect(await pageHead.text()).toBe('')

      const pluginHead = await app.handle(new Request('http://localhost/plugin/ping', { method: 'HEAD' }))
      expect(pluginHead.status).toBe(200)
      expect(pluginHead.headers.get('x-plugin')).toBe('1')
      expect(await pluginHead.text()).toBe('')
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('unsupported methods answer 405 with Allow header BEFORE any route or plugin middleware runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-3541-405-'))
    let pluginMwCalls = 0
    try {
      mkdirSync(join(dir, 'src/routes/api'), { recursive: true })
      mkdirSync(join(dir, 'src/actions'), { recursive: true })
      writeFileSync(join(dir, 'src/routes/_middleware.ts'), `
export default async function mw(_ctx: unknown, next: () => Promise<Response>) {
  ;(globalThis as Record<string, number>).__kay3541DirMw = ((globalThis as Record<string, number>).__kay3541DirMw ?? 0) + 1
  return next()
}
`)
      writeFileSync(join(dir, 'src/routes/index.tsx'), `
import { ping } from '../actions/ping'
export default function Home() {
  return <form action={ping} method="post"><button>go</button></form>
}
`)
      writeFileSync(join(dir, 'src/routes/api/only-get.ts'), `
export function GET() { return Response.json({ ok: true }) }
`)
      writeFileSync(join(dir, 'src/actions/ping.ts'), `
import { action } from 'kay/server'
export const ping = action(async () => ({ pong: true }))
`)

      const plugin = definePlugin({
        name: 'mw-spy',
        server(api) {
          api.use(async (_ctx, next) => {
            pluginMwCalls++
            return next()
          })
          api.route('GET', '/plugin/only-get', () => new Response('ok'))
        },
      })

      const g = globalThis as unknown as Record<string, number>
      g.__kay3541DirMw = 0
      const manifest = await build({ root: dir, plugins: [plugin], prerender: false })
      const app = await createServer({ root: dir, plugins: [plugin] })

      // Cross-site POST to page without POST -> 405 + Allow, zero middleware runs
      const pagePost = await app.handle(new Request('http://localhost/', {
        method: 'POST',
        headers: { origin: 'https://evil.example' },
      }))
      expect(pagePost.status).toBe(405)
      expect(pagePost.headers.get('allow')).toContain('GET')
      expect(pagePost.headers.get('allow')).toContain('HEAD')
      expect(pluginMwCalls).toBe(0)
      expect(g.__kay3541DirMw).toBe(0)

      // DELETE to GET-only API route -> 405 + Allow, zero middleware runs
      const apiDel = await app.handle(new Request('http://localhost/api/only-get', { method: 'DELETE' }))
      expect(apiDel.status).toBe(405)
      expect(apiDel.headers.get('allow')).toBe('GET, HEAD')
      expect(pluginMwCalls).toBe(0)
      expect(g.__kay3541DirMw).toBe(0)

      // POST to GET-only plugin route -> 405 + Allow, zero middleware runs
      const pluginPost = await app.handle(new Request('http://localhost/plugin/only-get', { method: 'POST' }))
      expect(pluginPost.status).toBe(405)
      expect(pluginPost.headers.get('allow')).toBe('GET, HEAD')
      expect(pluginMwCalls).toBe(0)

      // GET to server action URL -> 405 + Allow: POST, zero middleware runs
      const actionUrl = manifest.actions[0]!.url
      const actionGet = await app.handle(new Request(`http://localhost${actionUrl}`, { method: 'GET' }))
      expect(actionGet.status).toBe(405)
      expect(actionGet.headers.get('allow')).toBe('POST')
      expect(pluginMwCalls).toBe(0)
    }
    finally {
      delete (globalThis as unknown as Record<string, number>).__kay3541DirMw
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('invalid cookie name, path, or domain throws', () => {
    const store = new CookieStore(null, false)
    expect(() => store.set('bad;name', 'v')).toThrow(TypeError)
    expect(() => store.set('bad\r\nname', 'v')).toThrow(TypeError)
    expect(() => store.set('ok', 'v', { path: '/a;HttpOnly' })).toThrow(TypeError)
    expect(() => store.set('ok', 'v', { domain: 'example.com\nX: 1' })).toThrow(TypeError)
  })

  test('ActionContext omits the dead params property', () => {
    // Compile-time assertion: 'params' is not a key of ActionContext
    type HasParams = 'params' extends keyof ActionContext ? true : false
    const hasParams: HasParams = false
    expect(hasParams).toBe(false)
  })
})
