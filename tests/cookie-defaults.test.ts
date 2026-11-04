import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { unknownConfigKeys } from '../src/config-shape'
import { setSite } from '../src/runtime/site'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

const PAGE = '--- server\nctx.cookies.set(\'theme\', \'dark\')\nctx.cookies.set(\'loose\', \'1\', { httpOnly: false, secure: false, sameSite: \'strict\', path: \'/x\' })\nctx.cookies.set({ name: \'init\', value: \'v\' })\nctx.cookies.delete(\'old\')\nctx.cookies.delete({ name: \'older\', path: \'/o\' })\nctx.cookies.set(new Bun.Cookie(\'whole\', \'w\'))\nctx.cookies.delete({ name: \'loosed\', path: \'/x\', secure: false, sameSite: \'strict\' })\nctx.headers.set(\'cache-control\', \'public, max-age=60\')\n---\nh1 Cookie\n'
const ENDPOINT = 'export function GET({ cookies }) {\n  cookies.set(\'theme\', \'dark\')\n\n  return \'ok\'\n}\n'

const ACTION = '--- server\nimport { t } from \'elysia\'\nimport { action } from \'kay\'\n\nexport const act = action(t.Object({}), ({}, { cookies, redirect, request }) => {\n  cookies.set(\'seen\', \'1\')\n  cookies.delete(\'old\')\n\n  if (request.headers.has(\'x-do\'))\n    redirect(\'/elsewhere\')\n\n  return \'ok\'\n})\n---\nform(action={act})\n  button Go\n'
const REDIRECT = '--- server\nctx.cookies.set(\'went\', \'1\')\nctx.redirect(\'/elsewhere\')\n---\nh1 Gone\n'

const GUARD = 'import { guard } from \'kay\'\n\nexport default guard(({ cookies }) => {\n  cookies.set(\'guarded\', \'1\')\n})\n'

// An expired cookie with the attributes a set would carry, so a `Secure` or `__Host-` one is cleared.
const EXPIRED = (name: string, path: string, secure: string) => new RegExp(`^${name}=; Path=${path}; Expires=Thu, 01 Jan 1970 00:00:00 GMT;${secure} HttpOnly; SameSite=Lax$`)

describe('cookie defaults', () => {
  let dir = ''
  const servers: Record<string, Awaited<ReturnType<typeof pages>>> = {}

  const cookies = async (name: string, path: string, init: RequestInit = {}, origin = 'http://localhost') => {
    const response = await servers[name]!.handle(new Request(`${origin}${path}`, { redirect: 'manual', ...init }))

    return { set: response.headers.getSetCookie(), cache: response.headers.get('cache-control') }
  }

  beforeAll(async () => {
    dir = await scratchDir('cookie-defaults-')
    await Promise.all([
      Bun.write(join(dir, 'routes/index.kay'), 'h1 Home\n'),
      Bun.write(join(dir, 'routes/cookie.kay'), PAGE),
      Bun.write(join(dir, 'routes/theme.txt.ts'), ENDPOINT),
      Bun.write(join(dir, 'routes/guarded/_guard.ts'), GUARD),
      Bun.write(join(dir, 'routes/guarded/index.kay'), 'h1 Guarded\n'),
      Bun.write(join(dir, 'routes/act/index.kay'), ACTION),
      Bun.write(join(dir, 'routes/go.kay'), REDIRECT),
    ])

    const base = { root: dir, routes: 'routes', api: 'api', prebuilt: false }

    servers.plain = await pages({ ...base, security: false })
    servers.safe = await pages({ ...base, security: { cookies: {} } })
    servers.mounted = await pages({ ...base, base: '/app', security: { cookies: {} } })
    servers.custom = await pages({ ...base, security: { cookies: { sameSite: 'none', path: '/shop', httpOnly: false } } })
    servers.never = await pages({ ...base, security: { cookies: { secure: false } } })
    servers.always = await pages({ ...base, security: { cookies: { secure: true } } })
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('leaves an app that sets none on Bun\'s defaults', async () => {
    expect((await cookies('plain', '/cookie')).set[0]).toBe('theme=dark; Path=/; SameSite=Lax')
  })

  it('hardens a page\'s cookies, a call\'s own option winning, and keeps the response out of a shared cache', async () => {
    const answer = await cookies('safe', '/cookie')

    expect(answer.set[0]).toBe('theme=dark; Path=/; HttpOnly; SameSite=Lax')
    expect(answer.set[1]).toBe('loose=1; Path=/x; SameSite=Strict')
    expect(answer.set[2]).toBe('init=v; Path=/; HttpOnly; SameSite=Lax')
    expect(answer.set[3]).toMatch(EXPIRED('old', '/', ''))
    expect(answer.set[4]).toMatch(EXPIRED('older', '/o', ''))
    expect(answer.set[5]).toBe('whole=w; Path=/; SameSite=Lax')
    expect(answer.cache).toBe('private, no-cache')
  })

  it('deletes a cookie with the attributes it was set with, an explicit secure false clearing it without Secure', async () => {
    expect((await cookies('always', '/cookie')).set[6]).toBe('loosed=; Path=/x; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict')
    expect((await cookies('safe', '/cookie', {}, 'https://localhost')).set[6]).toBe('loosed=; Path=/x; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict')
  })

  it('follows the scheme the request came over for secure auto', async () => {
    expect((await cookies('safe', '/cookie', {}, 'https://localhost')).set[0]).toBe('theme=dark; Path=/; Secure; HttpOnly; SameSite=Lax')
    expect((await cookies('safe', '/cookie', { headers: { 'x-forwarded-proto': 'https' } })).set[0]).toBe('theme=dark; Path=/; Secure; HttpOnly; SameSite=Lax')
    expect((await cookies('safe', '/cookie', { headers: { 'x-forwarded-proto': 'http' } })).set[0]).toBe('theme=dark; Path=/; HttpOnly; SameSite=Lax')
    expect((await cookies('never', '/cookie', {}, 'https://localhost')).set[0]).toBe('theme=dark; Path=/; HttpOnly; SameSite=Lax')
    expect((await cookies('always', '/cookie')).set[0]).toBe('theme=dark; Path=/; Secure; HttpOnly; SameSite=Lax')
  })

  it('takes the base as the default path, for a set and a delete', async () => {
    const answer = await cookies('mounted', '/cookie')

    expect(answer.set[0]).toBe('theme=dark; Path=/app; HttpOnly; SameSite=Lax')
    expect(answer.set[3]).toMatch(EXPIRED('old', '/app', ''))
    expect(answer.set[4]).toMatch(EXPIRED('older', '/o', ''))
  })

  it('applies to an endpoint and a guard', async () => {
    expect((await cookies('safe', '/theme.txt')).set).toEqual(['theme=dark; Path=/; HttpOnly; SameSite=Lax'])
    expect((await cookies('safe', '/guarded')).set).toEqual(['guarded=1; Path=/; HttpOnly; SameSite=Lax'])
    expect((await cookies('mounted', '/guarded')).set).toEqual(['guarded=1; Path=/app; HttpOnly; SameSite=Lax'])
  })

  it('makes a SameSite=None cookie Secure and takes the path and options the app set', async () => {
    expect((await cookies('custom', '/cookie')).set[0]).toBe('theme=dark; Path=/shop; Secure; SameSite=None')
  })

  it('clears a cookie with the Secure it was set with', async () => {
    expect((await cookies('safe', '/cookie', {}, 'https://localhost')).set[3]).toMatch(EXPIRED('old', '/', ' Secure;'))
  })

  it('applies to an action, with its redirect', async () => {
    const post = async (name: string, headers: Record<string, string> = {}, origin = 'http://localhost') => {
      const response = await servers[name]!.handle(new Request(`${origin}/_kay/action/routes/act/index.kay/act`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', 'referer': `${origin}/act`, 'origin': origin, ...headers }, body: '' }))

      return { status: response.status, set: response.headers.getSetCookie() }
    }

    expect((await post('safe')).set[0]).toBe('seen=1; Path=/; HttpOnly; SameSite=Lax')
    expect((await post('safe', {}, 'https://localhost')).set[0]).toBe('seen=1; Path=/; Secure; HttpOnly; SameSite=Lax')

    const redirected = await post('safe', { 'x-do': '1' })

    expect(redirected.status).toBe(303)
    expect(redirected.set[0]).toBe('seen=1; Path=/; HttpOnly; SameSite=Lax')
  })

  it('applies to a page that redirects', async () => {
    expect((await cookies('safe', '/go')).set[0]).toBe('went=1; Path=/; HttpOnly; SameSite=Lax')
  })

  it('takes the scheme of an https site in production when no X-Forwarded-Proto says, and not in development', async () => {
    const before = process.env.NODE_ENV

    try {
      process.env.NODE_ENV = 'production'
      setSite('https://shop.example')
      expect((await cookies('safe', '/cookie')).set[0]).toBe('theme=dark; Path=/; Secure; HttpOnly; SameSite=Lax')
      expect((await cookies('safe', '/cookie', { headers: { 'x-forwarded-proto': 'http' } })).set[0]).toBe('theme=dark; Path=/; HttpOnly; SameSite=Lax')
      process.env.NODE_ENV = 'development'
      expect((await cookies('safe', '/cookie')).set[0]).toBe('theme=dark; Path=/; HttpOnly; SameSite=Lax')
    }
    finally {
      process.env.NODE_ENV = before ?? 'test'
      setSite(undefined)
    }
  })

  it('keeps plain-http localhost working under kay dev', async () => {
    const dev = await pages({ root: dir, routes: 'routes', api: 'api', prebuilt: false, dev: true, security: { cookies: {} } })

    expect((await dev.handle(new Request('http://localhost/cookie'))).headers.getSetCookie()[0]).toBe('theme=dark; Path=/; HttpOnly; SameSite=Lax')
  })

  it('refuses a setting that is no cookie attribute', async () => {
    await expect(pages({ root: dir, routes: 'routes', api: 'api', prebuilt: false, security: { cookies: { sameSite: 'sometimes' as 'lax' } } })).rejects.toThrow('security.cookies.sameSite')
    await expect(pages({ root: dir, routes: 'routes', api: 'api', prebuilt: false, security: { cookies: { path: 'shop' } } })).rejects.toThrow('security.cookies.path')
    expect(unknownConfigKeys({ security: { cookies: { samesite: 'lax' } } })).toEqual(['`security.cookies.samesite`, did you mean `security.cookies.sameSite`?'])
  })
})
