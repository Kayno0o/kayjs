import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { stringify } from 'devalue'
import { Elysia } from 'elysia'
import { refuse } from '../src/runtime/refuse'
import { shutdown } from '../src/server/lifecycle'
import { nameUser } from '../src/server/request-user'
import { scratchBuild } from './prerendered'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

const GUARD = 'import { guard } from \'kay\'\n\nexport default guard(({ request, deny }) => {\n  if (request.headers.has(\'x-blocked\'))\n    deny(403, \'Blocked\')\n})\n'

describe('the app-wide request hooks', () => {
  let dir = ''
  const before: { path: string, user: string | undefined, hasContext: boolean }[] = []
  const after: { path: string, status: number, duration: number }[] = []
  const errors: { source: string | undefined }[] = []
  let app: Awaited<ReturnType<typeof pages>>

  const get = async (path: string, headers: Record<string, string> = {}) => app.handle(new Request(`http://localhost${path}`, { headers }))

  beforeAll(async () => {
    dir = await scratchDir('request-hooks-')
    await Promise.all([
      Bun.write(join(dir, 'routes/_guard.ts'), GUARD),
      Bun.write(join(dir, 'routes/index.kay'), 'h1 Home\n'),
      Bun.write(join(dir, 'routes/feed.json.ts'), 'export function GET() {\n  return \'items\'\n}\n'),
      Bun.write(join(dir, 'api/notes.ts'), 'import { api } from \'kay/server\'\n\nexport default api({ guards: false }).get(\'/\', () => \'notes\')\n'),
    ])
    app = await pages({
      root: dir,
      dirs: { routes: 'routes', api: 'api' },
      prebuilt: false,
      observe: { log: false, onError: ({ source }) => void errors.push({ source }) },
      beforeRequest: ({ request, url, context }) => {
        before.push({ path: url.pathname, user: request.headers.get('x-user') ?? undefined, hasContext: context.request === request })

        if (request.headers.has('x-refuse'))
          return false

        if (request.headers.has('x-throttle'))
          refuse('Slow down', { status: 429 })

        if (request.headers.has('x-maintenance'))
          return new Response('Back soon', { status: 503 })

        if (request.headers.has('x-crash'))
          throw new Error('boom')

        return undefined
      },
      onResponse: ({ url, status, duration }) => {
        after.push({ path: url.pathname, status, duration })

        if (url.pathname === '/api/notes')
          throw new Error('late')
      },
    })
  })

  afterAll(async () => rm(dir, { recursive: true, force: true }))

  it('runs for a page, an endpoint and an API route, before the guards', async () => {
    before.length = 0
    expect((await get('/', { 'x-user': 'ada' })).status).toBe(200)
    expect((await get('/feed.json')).status).toBe(200)
    expect((await get('/api/notes')).status).toBe(200)
    expect(before.map(entry => entry.path)).toEqual(['/', '/feed.json', '/api/notes'])
    expect(before[0]).toEqual({ path: '/', user: 'ada', hasContext: true })
  })

  it('runs before a guard that would deny, so a refusal needs no session', async () => {
    before.length = 0

    const response = await get('/', { 'x-blocked': '1', 'x-refuse': '1' })

    expect(response.status).toBe(403)
    expect(await response.text()).toBe('Refused')
    expect(before).toHaveLength(1)
  })

  it('refuses with the status of refuse(), answers a Response it returns, and fails closed on any other throw', async () => {
    const throttled = await get('/', { 'x-throttle': '1' })

    expect(throttled.status).toBe(429)
    expect(await throttled.text()).toBe('Slow down')

    const maintenance = await get('/api/notes', { 'x-maintenance': '1' })

    expect(maintenance.status).toBe(503)
    expect(await maintenance.text()).toBe('Back soon')

    errors.length = 0

    const crashed = await get('/feed.json', { 'x-crash': '1' })

    expect(crashed.status).toBe(500)
    expect(await crashed.text()).toBe('Internal server error')
    expect(errors).toEqual([{ source: 'beforeRequest' }])
  })

  it('tells onResponse the status and duration of every answer, and a throw in it changes nothing', async () => {
    after.length = 0
    errors.length = 0

    const response = await get('/api/notes')

    expect(await response.text()).toBe('notes')
    await Bun.sleep(20)
    expect(after.filter(entry => entry.path === '/api/notes').at(-1)).toEqual({ path: '/api/notes', status: 200, duration: expect.any(Number) as number })
    expect(errors.map(entry => entry.source)).toContain('onResponse')
  })

  it('does not run for a path no route serves', async () => {
    before.length = 0
    await get('/nowhere')
    expect(before).toEqual([])
  })
})

describe('the app-wide start and stop hooks', () => {
  it('run once when the server listens and once when it stops, a throw reported and the rest still run', async () => {
    const dir = await scratchDir('lifecycle-hooks-')
    const told: string[] = []
    const errors: (string | undefined)[] = []

    await Bun.write(join(dir, 'routes/index.kay'), 'h1 Home\n')

    const app = await pages({
      root: dir,
      dirs: { routes: 'routes' },
      prebuilt: false,
      observe: { log: false, onError: ({ source }) => void errors.push(source) },
      onStart: ({ url }) => void told.push(`start ${url === undefined ? 'nowhere' : 'listening'}`),
      onStop: () => {
        told.push('stop')

        throw new Error('stop failed')
      },
    })

    app.listen({ port: 0, hostname: '127.0.0.1' })
    await Bun.sleep(20)
    await shutdown(app, true)

    await rm(dir, { recursive: true, force: true })

    expect(told.slice(0, 2)).toEqual(['start listening', 'stop'])
    expect(errors).toContain('onStop')
  })
})

describe('the actions defaults and hooks', () => {
  let dir = ''
  const events: string[] = []
  let app: Awaited<ReturnType<typeof pages>>

  const post = async (name: string, body: unknown = {}, headers: Record<string, string> = {}) => app.handle(new Request(`http://localhost/_kay/action/routes/index.kay/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-kay-action': '1', 'referer': 'http://localhost/', ...headers },
    body: stringify(body),
  }))

  beforeAll(async () => {
    dir = await scratchDir('action-hooks-')
    await Bun.write(join(dir, 'routes/_guard.ts'), 'import { guard } from \'kay\'\n\nexport default guard(() => undefined)\n')
    await Bun.write(join(dir, 'routes/index.kay'), `--- server
import { t } from 'elysia'
import { action } from 'kay'

export const ok = action(t.Object({ n: t.Number() }), ({ n }) => n * 2)
export const failing = action(t.Object({}), (_input, ctx) => ctx.fail(409, 'Taken', { '': 'Taken' }))
export const crashing = action(t.Object({}), () => { throw new Error('boom') })
export const sendOn = action(t.Object({}), (_input, ctx) => ctx.redirect('/thanks'))
export const mine = action(t.Object({}), () => 'mine', { onSuccess: ({ action }) => { (globalThis as any).ownTold = action } })
export const strict = action(t.Object({}), () => 'strict', { protect: { rateLimit: { max: 1, window: '1m' } }, maxSize: '1kb' })
export const open = action(t.Object({}), () => 'open', { protect: false })
export const limited = action(t.Object({}), () => 'limited')
---
h1 Home
`)
    app = await pages({
      root: dir,
      dirs: { routes: 'routes' },
      prebuilt: false,
      observe: { log: false },
      actions: {
        protect: { rateLimit: { max: 2, window: '1m' } },
        beforeRun: ({ action, input, context }) => {
          events.push(`before ${action} ${JSON.stringify(input)} ${context.request === undefined ? 'no request' : 'request'}`)

          if ((input as { n?: number }).n === 13)
            refuse('Unlucky')
        },
        onSuccess: ({ action, result, file }) => void events.push(`success ${action} ${JSON.stringify(result)} ${file.endsWith('index.kay')}`),
        onError: ({ action, status, message, error }) => void events.push(`error ${action} ${status} ${message} ${error === undefined ? 'fail' : 'thrown'}`),
      },
    })
  })

  afterAll(async () => rm(dir, { recursive: true, force: true }))

  it('tells beforeRun then onSuccess for a run, with the action, file, input and result', async () => {
    events.length = 0

    const response = await post('ok', { n: 2 }, { 'x-forwarded-for': '1.1.1.1' })

    expect(response.status).toBe(200)
    expect(events).toEqual(['before ok {"n":2} request', 'success ok 4 true'])
  })

  it('refuses a run beforeRun stops, with the refusal as the failure and no handler run', async () => {
    events.length = 0

    const response = await post('ok', { n: 13 }, { 'x-forwarded-for': '2.2.2.2' })

    expect(response.status).toBe(403)
    expect(events).toEqual(['before ok {"n":13} request'])
  })

  it('tells onError for ctx.fail, a thrown error and nothing for a redirect, which is a success', async () => {
    events.length = 0
    expect((await post('failing', {}, { 'x-forwarded-for': '3.3.3.3' })).status).toBe(409)
    expect((await post('crashing', {}, { 'x-forwarded-for': '3.3.3.4' })).status).toBe(500)
    expect([200, 303]).toContain((await post('sendOn', {}, { 'x-forwarded-for': '3.3.3.5' })).status)
    expect(events.filter(event => !event.startsWith('before'))).toEqual(['error failing 409 Taken fail', 'error crashing 500 Internal server error thrown', 'success sendOn undefined true'])
  })

  it('runs the action\'s own hook after the app\'s', async () => {
    events.length = 0
    await post('mine', {}, { 'x-forwarded-for': '4.4.4.4' })
    expect(events.filter(event => event.startsWith('success'))).toEqual(['success mine "mine" true'])
    expect((globalThis as { ownTold?: string }).ownTold).toBe('mine')
  })

  it('applies the app\'s rate limit to every action, an action\'s own replacing it and protect: false keeping it out', async () => {
    const status = async (name: string, ip: string) => (await post(name, {}, { 'x-forwarded-for': ip })).status

    expect([await status('limited', '5.5.5.5'), await status('limited', '5.5.5.5'), await status('limited', '5.5.5.5')]).toEqual([200, 200, 429])
    expect([await status('strict', '6.6.6.6'), await status('strict', '6.6.6.6')]).toEqual([200, 429])
    expect([await status('open', '7.7.7.7'), await status('open', '7.7.7.7'), await status('open', '7.7.7.7')]).toEqual([200, 200, 200])
  })
})

describe('the request hooks in every corner', () => {
  const answers: { path: string, status: number }[] = []
  const calls: string[] = []
  const order: string[] = []
  let dir = ''
  let app: Awaited<ReturnType<typeof pages>>

  const get = async (path: string, headers: Record<string, string> = {}) => app.handle(new Request(`http://localhost${path}`, { headers }))
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => app.handle(new Request(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }))

  beforeAll(async () => {
    dir = await scratchDir('request-hooks-corners-')
    await Promise.all([
      Bun.write(join(dir, 'public/hello.txt'), 'hello\n'),
      Bun.write(join(dir, 'routes/index.kay'), '--- server\nimport { t } from \'elysia\'\nimport { action } from \'kay\'\n\nexport const add = action(t.Object({ n: t.Number() }), ({ n }) => n)\n---\nh1 Home\n'),
      Bun.write(join(dir, 'routes/boom.json.ts'), 'export function GET() {\n  throw new Error(\'boom\')\n}\n'),
      Bun.write(join(dir, 'routes/slow.json.ts'), 'export async function GET() {\n  await Bun.sleep(120)\n\n  return \'slow\'\n}\n'),
      Bun.write(join(dir, 'api/items.ts'), 'import { t } from \'elysia\'\nimport { api } from \'kay/server\'\n\nexport default api({ guards: false }).post(\'/\', ({ body }) => body.n, { body: t.Object({ n: t.Number() }) })\n'),
    ])
    app = await pages({
      root: dir,
      dirs: { routes: 'routes', api: 'api' },
      prebuilt: false,
      base: '/shop',
      trailingSlash: 'always',
      redirects: { '/old': '/' },
      observe: { log: false },
      extensions: [{ name: 'order', server: new Elysia({ name: 'order' }).onStop(() => void order.push('extension')).get('/ext', () => 'ext') }],
      beforeRequest: ({ request, url }) => {
        calls.push(url.pathname)

        if (request.headers.has('x-refuse'))
          return false

        return undefined
      },
      onResponse: ({ url, status }) => void answers.push({ path: url.pathname, status }),
      onStop: () => void order.push('config'),
    })
  })

  afterAll(async () => rm(dir, { recursive: true, force: true }))

  it('refuses a request whose input is invalid before the input is validated, for an action and an API route', async () => {
    const action = app.routes.find(route => route.method === 'POST' && route.path.startsWith('/_kay/action/'))?.path ?? ''
    const invalid = { n: 'not a number' }

    expect((await post(action, invalid, { 'x-refuse': '1' })).status).toBe(403)
    expect((await post('/api/items', invalid, { 'x-refuse': '1' })).status).toBe(403)
    expect((await post('/api/items', invalid)).status).toBe(422)
  })

  it('tells onResponse a public file, a redirect, a thrown error and an extension route, and runs beforeRequest for them', async () => {
    answers.length = 0
    calls.length = 0
    expect((await get('/hello.txt')).status).toBe(200)
    expect([301, 302, 307, 308]).toContain((await get('/old')).status)
    expect((await get('/boom.json')).status).toBe(500)
    expect((await get('/ext')).status).toBe(200)
    await Bun.sleep(20)
    expect(answers.map(({ status }) => status)).toEqual(expect.arrayContaining([200, 500]))
    expect(answers.some(({ path }) => path === '/ext')).toBe(true)
    expect(calls).toContain('/ext')
  })

  it('runs the stop hooks of the extensions before the config\'s, and after the open requests finished', async () => {
    order.length = 0
    app.listen({ port: 0, hostname: '127.0.0.1' })

    const base = `http://127.0.0.1:${app.server?.port}`
    const slow = (async () => (await fetch(`${base}/slow.json`)).text())()

    await Bun.sleep(30)
    await shutdown(app)
    order.push('stopped')
    expect(await slow).toBe('slow')
    expect(order).toEqual(['extension', 'config', 'stopped'])
  })
})

describe('the request hooks on refusals, timeouts, re-renders and sign-ins', () => {
  const answers: { path: string, status: number, userId: string | undefined }[] = []
  const calls: string[] = []
  const state = globalThis as { onceRuns?: number, signedIn?: string }
  let dir = ''
  let app: Awaited<ReturnType<typeof pages>>

  const get = async (path: string, headers: Record<string, string> = {}) => app.handle(new Request(`http://localhost${path}`, { headers }))
  const post = async (path: string, headers: Record<string, string> = {}, body = stringify({})) => app.handle(new Request(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kay-action': '1', 'referer': 'http://localhost/', ...headers }, body }))

  beforeAll(async () => {
    dir = await scratchDir('request-hooks-more-')
    await Promise.all([
      Bun.write(join(dir, 'routes/index.kay'), `--- server
import { t } from 'elysia'
import { action } from 'kay'

const runs = globalThis as { onceRuns?: number, signedIn?: string }
const bump = () => (runs.onceRuns = (runs.onceRuns ?? 0) + 1)
const n = await ctx.once('n', bump)

export const fail = action(t.Object({}), async (_input, ctx) => {
  await ctx.once('n', bump)

  return ctx.fail(422, 'No')
})
export const signIn = action(t.Object({}), () => {
  runs.signedIn = 'ada'

  return 'in'
})
---
p.n {n}
`),
      Bun.write(join(dir, 'routes/slow.kay'), '--- server\nawait Bun.sleep(400)\n---\np late\n'),
      Bun.write(join(dir, 'routes/streamed.kay'), '--- server\nconst later = Bun.sleep(400).then(() => \'late comments\')\n---\np first\nawait later then text\n  p.comments {text}\n'),
      Bun.write(join(dir, 'api/items.ts'), 'import { t } from \'elysia\'\nimport { api } from \'kay/server\'\n\nexport default api({ guards: false }).post(\'/\', ({ body }) => body.n, { body: t.Object({ n: t.Number() }) })\n'),
    ])
    app = await pages({
      root: dir,
      routes: 'routes',
      api: 'api',
      prebuilt: false,
      security: false,
      serve: { timeout: '100ms' },
      observe: { log: false },
      extensions: [{ name: 'who', server: new Elysia({ name: 'who' }).derive({ as: 'global' }, ({ request }) => {
        nameUser(request, () => state.signedIn)

        return {}
      }) }],
      beforeRequest: ({ request, url }) => {
        calls.push(url.pathname)

        if (request.headers.has('x-limit'))
          return new Response('Slow down', { status: 429, headers: { 'retry-after': '7', 'x-reason': 'limit' } })

        return request.headers.has('x-refuse') ? false : undefined
      },
      onResponse: ({ url, status, context }) => void answers.push({ path: url.pathname, status, userId: context.userId }),
    })
  })

  afterAll(async () => rm(dir, { recursive: true, force: true }))

  it('answers a refused action and API route with the refusal\'s status, body, headers and a matching length', async () => {
    const action = app.routes.find(route => route.method === 'POST' && route.path.includes('/fail'))?.path ?? ''

    for (const response of [await post(action, { 'x-limit': '1' }), await post('/api/items', { 'x-limit': '1' }, '{"n":"x"}')]) {
      const body = await response.arrayBuffer()

      expect(response.status).toBe(429)
      expect(new TextDecoder().decode(body)).toBe('Slow down')
      expect(response.headers.get('retry-after')).toBe('7')
      expect(response.headers.get('x-reason')).toBe('limit')
      expect(Number(response.headers.get('content-length') ?? body.byteLength)).toBe(body.byteLength)
    }

    const refused = await post('/api/items', { 'x-refuse': '1' }, '{"n":"x"}')

    expect([refused.status, await refused.text()]).toEqual([403, 'Refused'])
  })

  it('loads the ctx.once values of a page again when it renders after a failed action', async () => {
    state.onceRuns = 0

    expect(await (await get('/')).text()).toContain('<p class="n">1</p>')

    const action = app.routes.find(route => route.method === 'POST' && route.path.includes('/fail'))?.path ?? ''
    const failed = await app.handle(new Request(`http://localhost${action}?kay_back=%2F`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'origin': 'http://localhost', 'referer': 'http://localhost/' }, body: '' }))
    const rendered = failed.status >= 300 && failed.status < 400 ? await get('/', { cookie: failed.headers.getSetCookie().map(cookie => cookie.slice(0, cookie.indexOf(';'))).join('; ') }) : failed

    expect(await rendered.text()).toContain('<p class="n">3</p>')
    expect(state.onceRuns).toBe(3)
  })

  it('tells onResponse a request cut by serve.timeout as 504, and a streamed page as the 200 its headers went out with', async () => {
    answers.length = 0

    const slow = await get('/slow')

    expect(slow.status).toBe(504)
    await slow.text()

    const streamed = await get('/streamed')

    expect(streamed.status).toBe(200)
    await expect(streamed.text()).rejects.toBeInstanceOf(Error)
    await Bun.sleep(20)
    expect(answers.find(entry => entry.path === '/slow')?.status).toBe(504)
    expect(answers.find(entry => entry.path === '/streamed')?.status).toBe(200)
  })

  it('tells onResponse the user as the request began, not the one a sign-in action made', async () => {
    answers.length = 0
    delete state.signedIn

    const action = app.routes.find(route => route.method === 'POST' && route.path.includes('/signIn'))?.path ?? ''

    expect((await post(action)).status).toBe(200)
    expect(state.signedIn as string | undefined).toBe('ada')
    await Bun.sleep(20)
    expect(answers.find(entry => entry.path === action)).toEqual({ path: action, status: 200, userId: undefined })
    delete state.signedIn
  })
})

describe('the request hooks under a locale prefix and on a prerendered page', () => {
  it('see the prefixed path, and refuse before the page is served', async () => {
    const dir = await scratchDir('request-hooks-locale-')
    const seen: string[] = []
    const answered: { path: string, status: number }[] = []

    try {
      await Promise.all([
        Bun.write(join(dir, 'routes/index.kay'), 'h1 Home\n'),
        ...['en', 'fr'].map(async locale => Bun.write(join(dir, `src/messages/${locale}.ts`), 'import { defineMessages } from \'kay/i18n\'\n\nexport default defineMessages({ home: \'Home\' })\n')),
      ])

      const app = await pages({
        root: dir,
        routes: 'routes',
        prebuilt: false,
        security: false,
        observe: { log: false },
        i18n: { locales: ['en', 'fr'], defaultLocale: 'en' },
        beforeRequest: ({ request, url }) => {
          seen.push(url.pathname)

          return request.headers.has('x-refuse') ? false : undefined
        },
        onResponse: ({ url, status }) => void answered.push({ path: url.pathname, status }),
      })
      const get = async (path: string, headers: Record<string, string> = {}) => app.handle(new Request(`http://localhost${path}`, { headers }))

      expect((await get('/fr')).status).toBe(200)
      expect((await get('/fr', { 'x-refuse': '1' })).status).toBe(403)
      await Bun.sleep(20)
      expect(seen).toEqual(['/fr', '/fr'])
      expect(answered.map(entry => entry.status)).toEqual([200, 403])
      expect(answered.every(entry => entry.path === '/fr')).toBe(true)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('run for a prerendered hit, and a refusal stops it', async () => {
    const build = await scratchBuild({}, false, resolve('tests/fixtures/production'))
    const seen: string[] = []
    const answered: number[] = []

    try {
      await build.prerender({})

      const app = await build.serve({ root: 'tests/fixtures/production', security: false, beforeRequest: ({ request, url }) => {
        seen.push(url.pathname)

        return request.headers.has('x-refuse') ? false : undefined
      }, onResponse: ({ status }) => void answered.push(status) })

      expect((await app.handle(new Request('http://localhost/news'))).status).toBe(200)
      expect((await app.handle(new Request('http://localhost/news', { headers: { 'x-refuse': '1' } }))).status).toBe(403)
      await Bun.sleep(20)
      expect(seen).toEqual(['/news', '/news'])
      expect(answered).toEqual([200, 403])
    }
    finally {
      await build.remove()
    }
  })
})
