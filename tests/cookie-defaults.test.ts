import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

const PAGE = '--- server\nctx.cookies.set(\'theme\', \'dark\')\nctx.cookies.set(\'loose\', \'1\', { httpOnly: false, secure: false, sameSite: \'strict\', path: \'/x\' })\nctx.cookies.set({ name: \'init\', value: \'v\' })\nctx.cookies.delete(\'old\')\nctx.cookies.delete({ name: \'older\', path: \'/o\' })\nctx.cookies.set(new Bun.Cookie(\'whole\', \'w\'))\nctx.headers.set(\'cache-control\', \'public, max-age=60\')\n---\nh1 Cookie\n'
const ENDPOINT = 'export function GET({ cookies }) {\n  cookies.set(\'theme\', \'dark\')\n\n  return \'ok\'\n}\n'

const GUARD = 'import { guard } from \'kay\'\n\nexport default guard(({ cookies }) => {\n  cookies.set(\'guarded\', \'1\')\n})\n'

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
    expect(answer.set[3]).toStartWith('old=; Path=/; Expires=')
    expect(answer.set[4]).toStartWith('older=; Path=/o; Expires=')
    expect(answer.set[5]).toBe('whole=w; Path=/; SameSite=Lax')
    expect(answer.cache).toBe('private, no-cache')
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
    expect(answer.set[3]).toStartWith('old=; Path=/app; Expires=')
    expect(answer.set[4]).toStartWith('older=; Path=/o; Expires=')
  })

  it('applies to an endpoint and a guard', async () => {
    expect((await cookies('safe', '/theme.txt')).set).toEqual(['theme=dark; Path=/; HttpOnly; SameSite=Lax'])
    expect((await cookies('safe', '/guarded')).set).toEqual(['guarded=1; Path=/; HttpOnly; SameSite=Lax'])
    expect((await cookies('mounted', '/guarded')).set).toEqual(['guarded=1; Path=/app; HttpOnly; SameSite=Lax'])
  })

  it('makes a SameSite=None cookie Secure and takes the path and options the app set', async () => {
    expect((await cookies('custom', '/cookie')).set[0]).toBe('theme=dark; Path=/shop; Secure; SameSite=None')
  })

  it('refuses a setting that is no cookie attribute', async () => {
    await expect(pages({ root: dir, routes: 'routes', api: 'api', prebuilt: false, security: { cookies: { sameSite: 'sometimes' as 'lax' } } })).rejects.toThrow('security.cookies.sameSite')
    await expect(pages({ root: dir, routes: 'routes', api: 'api', prebuilt: false, security: { cookies: { path: 'shop' } } })).rejects.toThrow('security.cookies.path')
  })
})
