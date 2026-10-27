import type { GuardContext } from '../src/runtime'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { basicAuth } from '../src/server/basic-auth'
import { Denied, stoppers } from '../src/server/signals'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

const encode = (credentials: string) => `Basic ${Buffer.from(credentials).toString('base64')}`

// What the guard does with an `Authorization` header: the status it denies with and the challenge it sets, or `passed` when it lets the request through.
async function attempt(guard: ReturnType<typeof basicAuth>, authorization: string | undefined) {
  const request = new Request('http://localhost/', { headers: authorization === undefined ? {} : { authorization } })
  const headers = new Headers()

  try {
    await guard({ request, headers, ...stoppers(request) } as unknown as GuardContext)
  }
  catch (error) {
    if (!(error instanceof Denied))
      throw error

    return { status: error.status, challenge: headers.get('www-authenticate') }
  }

  return 'passed' as const
}

const guard = basicAuth({ user: 'owntracks', password: 'p@ss:word', realm: 'voyager' })

describe('basicAuth', () => {
  it('lets the right credentials through', async () => {
    expect(await attempt(guard, encode('owntracks:p@ss:word'))).toBe('passed')
  })

  it('answers 401 with a challenge naming the realm to a request with no credentials', async () => {
    expect(await attempt(guard, undefined)).toEqual({ status: 401, challenge: 'Basic realm="voyager", charset="UTF-8"' })
  })

  it('reads the scheme in any case and any run of spaces', async () => {
    expect(await attempt(guard, encode('owntracks:p@ss:word').replace('Basic', 'basic'))).toBe('passed')
    expect(await attempt(guard, encode('owntracks:p@ss:word').replace('Basic ', 'BASIC   '))).toBe('passed')
  })

  it.each([
    ['another scheme', `Bearer ${Buffer.from('owntracks:p@ss:word').toString('base64')}`],
    ['a scheme alone', 'Basic'],
    ['an empty value', 'Basic '],
    ['text that is no base64', 'Basic not base64!'],
    ['padding in the middle', 'Basic b3du=dHJhY2tz'],
    ['base64 of no UTF-8', `Basic ${Buffer.from([0xFF, 0xFE, 0x3A, 0xFF]).toString('base64')}`],
    ['no colon', encode('owntracks')],
    ['an empty user', encode(':p@ss:word')],
    ['an empty password', encode('owntracks:')],
    ['a wrong password', encode('owntracks:wrong')],
    ['a wrong user', encode('someone:p@ss:word')],
    ['a prefix of the password', encode('owntracks:p@ss')],
    ['a longer password', encode('owntracks:p@ss:word!')],
    ['the user and password swapped', encode('p@ss:owntracks')],
    ['a header with a raw non-ASCII byte', 'Basic café'],
    ['a NUL in the credentials', encode('owntracks\0:p@ss:word')],
  ])('answers 401 to %s', async (_, header) => {
    expect(await attempt(guard, header)).toMatchObject({ status: 401 })
  })

  it('compares UTF-8 credentials, a lookalike not matching', async () => {
    const accented = basicAuth({ user: 'zoë', password: 'pässwörd' })

    expect(await attempt(accented, encode('zoë:pässwörd'))).toBe('passed')
    // The same letters decomposed, and read as Latin-1.
    expect(await attempt(accented, encode('zoë:pässwörd'))).toMatchObject({ status: 401 })
    expect(await attempt(accented, `Basic ${Buffer.from('zoë:pässwörd', 'latin1').toString('base64')}`)).toMatchObject({ status: 401 })
  })

  it('refuses every request while the credentials are unset, an empty header included', async () => {
    const unset = [basicAuth({ user: undefined, password: undefined }), basicAuth({ user: 'a', password: undefined }), basicAuth({ user: undefined, password: 'b' }), basicAuth({ user: '', password: '' })]

    for (const open of unset) {
      expect(await attempt(open, undefined)).toMatchObject({ status: 401 })
      expect(await attempt(open, encode(':'))).toMatchObject({ status: 401 })
      expect(await attempt(open, encode('undefined:undefined'))).toMatchObject({ status: 401 })
      expect(await attempt(open, encode('a:b'))).toMatchObject({ status: 401 })
    }
  })

  it('quotes the realm and refuses at boot what cannot be a header value, or a user holding a colon', () => {
    expect(basicAuth({ user: 'a', password: 'b', realm: 'say "hi"' })).toBeFunction()
    expect(() => basicAuth({ user: 'a', password: 'b', realm: 'two\nlines' })).toThrow('realm')
    expect(() => basicAuth({ user: 'a', password: 'b', realm: 'café' })).toThrow('realm')
    expect(() => basicAuth({ user: 'a:b', password: 'c' })).toThrow('user')
  })

  it('escapes the realm in the challenge', async () => {
    expect(await attempt(basicAuth({ user: 'a', password: 'b', realm: 'say "hi" \\ ok' }), undefined)).toEqual({ status: 401, challenge: 'Basic realm="say \\"hi\\" \\\\ ok", charset="UTF-8"' })
  })

  it('compares digests with timingSafeEqual, never the texts', async () => {
    const source = await Bun.file(join(import.meta.dir, '../src/server/basic-auth.ts')).text()

    expect(source).toContain('timingSafeEqual')
    expect(source).toContain('nodeCrypto()')
    expect(source).not.toMatch(/from 'node:crypto'/)
  })
})

describe('basicAuth as a guard of a directory', () => {
  const GUARD = 'import { basicAuth } from \'kay/server\'\n\nexport default basicAuth({ user: \'owntracks\', password: \'secret\', realm: \'voyager\' })\n'
  const PAGE = (body: string) => `${body}\n`
  let dir = ''
  let plain: Awaited<ReturnType<typeof pages>>
  let mounted: Awaited<ReturnType<typeof pages>>
  let localized: Awaited<ReturnType<typeof pages>>

  beforeAll(async () => {
    dir = await scratchDir('basic-auth-')
    await Promise.all([
      Bun.write(join(dir, 'routes/index.kay'), PAGE('h1 Home')),
      Bun.write(join(dir, 'routes/private/_guard.ts'), GUARD),
      Bun.write(join(dir, 'routes/private/index.kay'), PAGE('h1 Private')),
      Bun.write(join(dir, 'api/track/_guard.ts'), GUARD),
      Bun.write(join(dir, 'api/track/index.ts'), 'import { api } from \'kay/server\'\n\nexport default api().post(\'/\', () => \'stored\')\n'),
      Bun.write(join(dir, 'api/open.ts'), 'import { api } from \'kay/server\'\n\nexport default api().get(\'/\', () => \'open\')\n'),
    ])
    plain = await pages({ root: dir, routes: 'routes', api: 'api', prebuilt: false })
    mounted = await pages({ root: dir, routes: 'routes', api: 'api', prebuilt: false, base: '/blog', trailingSlash: 'always' })
    localized = await pages({ root: dir, routes: 'routes', api: 'api', prebuilt: false, i18n: { locales: ['en', 'fr'], defaultLocale: 'en', messages: resolve('tests/fixtures/i18n/src/messages') } })
  })

  afterAll(async () => rm(dir, { recursive: true, force: true }))

  const fetchAt = async (app: typeof plain, path: string, authorization?: string, method = 'GET') => app.handle(new Request(`http://localhost${path}`, { method, headers: authorization === undefined ? {} : { authorization } }))

  it('answers an API route 401 with the challenge, and the right credentials reach it', async () => {
    const refused = await fetchAt(plain, '/api/track', undefined, 'POST')

    expect(refused.status).toBe(401)
    expect(refused.headers.get('www-authenticate')).toBe('Basic realm="voyager", charset="UTF-8"')
    expect((await fetchAt(plain, '/api/track', encode('owntracks:wrong'), 'POST')).status).toBe(401)

    const taken = await fetchAt(plain, '/api/track', encode('owntracks:secret'), 'POST')

    expect(taken.status).toBe(200)
    expect(await taken.text()).toBe('stored')
    expect((await fetchAt(plain, '/api/open')).status).toBe(200)
  })

  it('guards a page the same way', async () => {
    const refused = await fetchAt(plain, '/private')

    expect(refused.status).toBe(401)
    expect(refused.headers.get('www-authenticate')).toBe('Basic realm="voyager", charset="UTF-8"')
    expect((await fetchAt(plain, '/private', encode('owntracks:secret'))).status).toBe(200)
    expect((await fetchAt(plain, '/')).status).toBe(200)
  })

  it('holds under a base with trailing slashes, which the proxy strips before the request', async () => {
    const refused = await fetchAt(mounted, '/private/')

    expect(refused.status).toBe(401)
    expect(refused.headers.get('www-authenticate')).toContain('Basic realm=')
    expect((await fetchAt(mounted, '/private/', encode('owntracks:secret'))).status).toBe(200)
    expect((await fetchAt(mounted, '/api/track/', encode('owntracks:secret'), 'POST')).status).toBe(200)
    expect((await fetchAt(mounted, '/api/track/', undefined, 'POST')).status).toBe(401)
  })

  it('holds under a locale prefix', async () => {
    expect((await fetchAt(localized, '/fr/private')).status).toBe(401)
    expect((await fetchAt(localized, '/fr/private', encode('owntracks:secret'))).status).toBe(200)
    expect((await fetchAt(localized, '/private')).status).toBe(401)
    expect((await fetchAt(localized, '/api/track', undefined, 'POST')).status).toBe(401)
  })
})
