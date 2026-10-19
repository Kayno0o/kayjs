import type { AnyElysia } from 'elysia'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { pages } from '../src/server'
import { scratchDir } from './scratch'

const SECRET = 'db password=hunter2'
const NativeRequest = Request
const THROWN = ['error', 'string', 'rejection', 'coded', 'response'] as const

type Thrown = typeof THROWN[number]

let dir = ''

// The hook throws what the request's `x-throw` header names, so one app serves every case.
async function hook({ request }: { request: Request }): Promise<void> {
  const kind = request.headers.get('x-throw')

  if (kind === 'error')
    throw new Error(SECRET)

  if (kind === 'coded')
    throw Object.assign(new Error(SECRET), { code: 'ENOENT' })

  if (kind === 'string')
    throw SECRET

  if (kind === 'rejection')
    await Promise.reject(new Error(SECRET))

  if (kind === 'response')
    throw new Response('given', { status: 418 })
}

const TARGETS = [
  { name: 'a page', path: '/', headers: { accept: 'text/html' } },
  { name: 'an API route', path: '/api/hello' },
  { name: 'an action', path: '/_kay/action/ACTION', method: 'POST' },
  { name: 'a static file', path: '/logo.txt' },
  { name: 'a WebSocket upgrade', path: '/api/socket', headers: { upgrade: 'websocket', connection: 'Upgrade' } },
] as const

async function served(options: { dev: boolean, base?: string, onError?: (error: unknown) => void, beforeKay?: boolean }) {
  const kay = await pages({ routes: join(dir, 'routes'), api: join(dir, 'api'), publicDir: join(dir, 'public'), prebuilt: false, dev: options.dev, base: options.base ?? '', onError: options.onError, log: false })
  const app: AnyElysia = options.beforeKay === false ? new Elysia().use(kay).onRequest(hook) : new Elysia().onRequest(hook).use(kay)

  return app
}

beforeAll(async () => {
  dir = await scratchDir('hook-errors-')
  await Promise.all([
    Bun.write(join(dir, 'routes/index.kay'), '--- server\nimport { t } from \'elysia\'\nimport { action } from \'kay\'\n\nexport const poke = action(t.Object({}), () => \'poked\')\n---\nform(action={poke})\n  button Poke\n'),
    Bun.write(join(dir, 'routes/items/[id=boom].kay'), 'p Item\n'),
    Bun.write(join(dir, 'params/boom.ts'), `export default (value: string) => {\n  if (value === 'explode')\n    throw new Error('${SECRET}')\n\n  return value\n}\n`),
    Bun.write(join(dir, 'api/hello.ts'), 'import { api } from \'kay/server\'\n\nexport default api().get(\'/\', () => \'hello\')\n'),
    Bun.write(join(dir, 'api/socket.ts'), 'import { api } from \'kay/server\'\n\nexport default api().ws(\'/\', { message() {} })\n'),
    Bun.write(join(dir, 'public/logo.txt'), 'logo'),
  ])
})

afterAll(async () => rm(dir, { recursive: true, force: true }))

function actionPath(): string {
  return `/_kay/action/${dir.slice(process.cwd().length + 1)}/routes/index.kay/poke`
}

async function ask(app: AnyElysia, target: typeof TARGETS[number], thrown: Thrown | '', base = '') {
  const path = target.path.replace('ACTION', actionPath().slice('/_kay/action/'.length))
  const headers: Record<string, string> = { ...'headers' in target ? target.headers : {}, ...thrown === '' ? {} : { 'x-throw': thrown } }

  if ('method' in target) {
    headers['content-type'] = 'application/json'
    headers['x-kay-action'] = '1'
  }

  const response = await app.handle(new NativeRequest(`http://localhost${base}${path}`, { method: 'method' in target ? target.method : 'GET', headers, body: 'method' in target ? '{}' : null }))

  return { status: response.status, body: await response.text(), type: response.headers.get('content-type') ?? '', nosniff: response.headers.get('x-content-type-options') }
}

describe('an onRequest hook that throws', () => {
  for (const base of ['', '/app']) {
    it(`answers a 500 that holds no message in production, logs it and hands it to onError, under base ${JSON.stringify(base)}`, async () => {
      const logged = spyOn(console, 'error').mockImplementation(() => undefined)
      const reported: unknown[] = []

      try {
        const app = await served({ dev: false, base, onError: error => void reported.push(error) })

        for (const target of TARGETS) {
          for (const thrown of THROWN.filter(kind => kind !== 'response')) {
            logged.mockClear()
            reported.length = 0

            const answer = await ask(app, target, thrown, base)

            expect(answer.status, `${target.name}, ${thrown}`).toBe(500)
            expect(answer.body, `${target.name}, ${thrown}`).not.toContain('hunter2')
            expect(answer.body, `${target.name}, ${thrown}`).toBe('Internal Server Error')
            expect(logged.mock.calls.map(call => String(call[0])).join('\n'), `${target.name}, ${thrown}`).toContain('hunter2')
            expect(reported, `${target.name}, ${thrown}`).toHaveLength(1)
          }
        }
      }
      finally {
        logged.mockRestore()
      }
    })

    it(`shows the message in development, under base ${JSON.stringify(base)}`, async () => {
      const logged = spyOn(console, 'error').mockImplementation(() => undefined)

      try {
        const app = await served({ dev: true, base })

        for (const target of TARGETS) {
          for (const thrown of ['error', 'string', 'rejection', 'coded'] as const) {
            const answer = await ask(app, target, thrown, base)

            expect(answer.status, `${target.name}, ${thrown}`).toBe(500)
            expect(answer.body, `${target.name}, ${thrown}`).toContain('hunter2')
          }
        }

        const page = await ask(app, TARGETS[0], 'error', base)

        expect(page.type).toContain('text/html')
        expect(page.body).toContain('500 error')
      }
      finally {
        logged.mockRestore()
      }
    })
  }

  it('answers a Response it threw as given, in development and production', async () => {
    for (const dev of [false, true]) {
      const app = await served({ dev })

      for (const target of TARGETS) {
        const answer = await ask(app, target, 'response')

        expect(answer, `${target.name}, dev ${dev}`).toMatchObject({ status: 418, body: 'given' })
      }
    }
  })

  it('draws the app\'s own error page for a page request, and plain text for the others', async () => {
    const own = await scratchDir('hook-errors-page-')
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      await Promise.all([
        Bun.write(join(own, 'routes/index.kay'), 'p Home\n'),
        Bun.write(join(own, 'routes/_error.kay'), '--- server\nconst { status, message } = ctx.error\n---\nh1 Oops {status}\np.message {message}\n'),
        Bun.write(join(own, 'api/hello.ts'), 'import { api } from \'kay/server\'\n\nexport default api().get(\'/\', () => \'hello\')\n'),
      ])

      for (const dev of [false, true]) {
        const kay = await pages({ routes: join(own, 'routes'), api: join(own, 'api'), prebuilt: false, dev, log: false })
        const app = new Elysia().onRequest(hook).use(kay)
        const page = await ask(app, TARGETS[0], 'error')
        const api = await ask(app, TARGETS[1], 'error')

        expect(page.status).toBe(500)
        expect(page.type).toContain('text/html')
        expect(page.body).toContain('<h1>Oops 500</h1>')
        expect(page.body.includes('hunter2')).toBe(dev)
        expect(api).toMatchObject({ status: 500, type: expect.stringContaining('text/plain') })
      }
    }
    finally {
      logged.mockRestore()
      await rm(own, { recursive: true, force: true })
    }
  })

  it('draws the app\'s error page with the locals a derive added before the hook threw', async () => {
    const own = await scratchDir('hook-errors-locals-')
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      await Promise.all([
        Bun.write(join(own, 'routes/index.kay'), 'p Home\n'),
        Bun.write(join(own, 'routes/_error.kay'), '--- server\nconst who = (ctx.locals as { who?: string }).who ?? \'nobody\'\n---\nh1 Oops {who}\n'),
      ])
      const kay = await pages({ routes: join(own, 'routes'), prebuilt: false, dev: false, log: false })
      const app = new Elysia().derive({ as: 'global' }, () => ({ who: 'ann' })).onBeforeHandle({ as: 'global' }, hook).use(kay)
      const page = await ask(app, TARGETS[0], 'error')

      expect(page.status).toBe(500)
      expect(page.body).toContain('<h1>Oops ann</h1>')
    }
    finally {
      logged.mockRestore()
      await rm(own, { recursive: true, force: true })
    }
  })

  it('falls back to plain text when the error page throws itself', async () => {
    const own = await scratchDir('hook-errors-broken-')
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      await Promise.all([
        Bun.write(join(own, 'routes/index.kay'), 'p Home\n'),
        Bun.write(join(own, 'routes/_error.kay'), '--- server\nthrow new Error(\'error page broke\')\n---\nh1 Oops\n'),
      ])
      const app = new Elysia().onRequest(hook).use(await pages({ routes: join(own, 'routes'), prebuilt: false, dev: false, log: false }))
      const page = await ask(app, TARGETS[0], 'error')

      expect(page).toMatchObject({ status: 500, body: 'Internal Server Error', type: expect.stringContaining('text/plain') })
    }
    finally {
      logged.mockRestore()
      await rm(own, { recursive: true, force: true })
    }
  })

  it('draws the error page of an app with locales, in the locale the path names', async () => {
    const own = await scratchDir('hook-errors-i18n-')
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      await Promise.all([
        Bun.write(join(own, 'routes/index.kay'), 'p Home\n'),
        Bun.write(join(own, 'routes/_error.kay'), '--- server\nimport { t } from \'kay/i18n\'\n\nconst home = t(\'nav.home\')\nconst { status } = ctx.error\n---\nh1 Oops {status} {home}\n'),
      ])
      const i18n = { locales: ['fr', 'en'], defaultLocale: 'fr', messages: join(process.cwd(), 'tests/fixtures/i18n/src/messages') }
      const app = new Elysia().onRequest(hook).use(await pages({ routes: join(own, 'routes'), prebuilt: false, dev: false, log: false, i18n }))

      for (const [path, heading] of [['/', 'Oops 500 Accueil'], ['/en', 'Oops 500 Home']] as const) {
        const page = await app.handle(new NativeRequest(`http://localhost${path}`, { headers: { 'accept': 'text/html', 'x-throw': 'error' } }))
        const body = await page.text()

        expect(page.status, path).toBe(500)
        expect(body, path).toContain(`<h1>${heading}</h1>`)
        expect(body, path).not.toContain('hunter2')
      }
    }
    finally {
      logged.mockRestore()
      await rm(own, { recursive: true, force: true })
    }
  })

  it('keeps the security headers on the answer', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const app = await served({ dev: false, beforeKay: false })

      expect((await ask(app, TARGETS[0], 'error')).nosniff).toBe('nosniff')
    }
    finally {
      logged.mockRestore()
    }
  })

  it('answers a hook registered after kay the same way', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const app = await served({ dev: false, beforeKay: false })

      for (const target of TARGETS)
        expect(await ask(app, target, 'error'), target.name).toMatchObject({ status: 500, body: 'Internal Server Error' })
    }
    finally {
      logged.mockRestore()
    }
  })

  it('leaves a request that throws nothing alone', async () => {
    const app = await served({ dev: false })

    expect(await ask(app, TARGETS[1], '')).toMatchObject({ status: 200, body: 'hello' })
    expect(await ask(app, TARGETS[3], '')).toMatchObject({ status: 200, body: 'logo' })
  })

  it('leaves an error class the app registered after kay to the app\'s own handler', async () => {
    class Custom extends Error {}

    const app = new Elysia()
      .error({ Custom })
      .use(await pages({ routes: join(dir, 'routes'), prebuilt: false, dev: false, log: false }))
      .get('/custom', () => {
        throw new Custom('mine')
      })
      .onError(({ code }) => code === 'Custom' ? new Response('conflict', { status: 409 }) : undefined)
    const response = await app.handle(new NativeRequest('http://localhost/custom'))

    expect(response.status).toBe(409)
  })

  it('does not hide an error the app answers in its own onError', async () => {
    const app = new Elysia().onError(() => new Response('mine', { status: 503 })).onRequest(hook).use(await pages({ routes: join(dir, 'routes'), prebuilt: false, dev: false, log: false }))
    const response = await app.handle(new NativeRequest('http://localhost/', { headers: { 'x-throw': 'error' } }))

    expect(response.status).toBe(503)
    expect(await response.text()).toBe('mine')
  })
})

describe('a hook kay runs itself that throws', () => {
  it('answers a param matcher that throws as a 500 with no message', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const reported: unknown[] = []

    try {
      const app = await pages({ routes: join(dir, 'routes'), prebuilt: false, dev: false, log: false, onError: error => void reported.push(error) })
      const response = await app.handle(new NativeRequest('http://localhost/items/explode'))

      expect(response.status).toBe(500)
      expect(await response.text()).not.toContain('hunter2')
      expect(reported).toHaveLength(1)
      expect((await app.handle(new NativeRequest('http://localhost/items/fine'))).status).toBe(200)
    }
    finally {
      logged.mockRestore()
    }
  })

  it('answers a rewrite that throws as a 500 with no message', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const reported: unknown[] = []

    try {
      const app = await pages({ routes: join(dir, 'routes'), prebuilt: false, dev: false, log: false, onError: error => void reported.push(error), rewrite: () => {
        throw new Error(SECRET)
      } })
      const response = await app.handle(new NativeRequest('http://localhost/'))

      expect(response.status).toBe(500)
      expect(await response.text()).not.toContain('hunter2')
      expect(reported).toHaveLength(1)
    }
    finally {
      logged.mockRestore()
    }
  })

  it('answers an extension\'s onRequest hook that throws as a 500 with no message', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const server = new Elysia({ name: 'throwing' }).onRequest(() => {
        throw new Error(SECRET)
      })
      const app = await pages({ routes: join(dir, 'routes'), prebuilt: false, dev: false, log: false, extensions: [{ name: 'throwing', server }] })
      const response = await app.handle(new NativeRequest('http://localhost/'))

      expect(response.status).toBe(500)
      expect(await response.text()).not.toContain('hunter2')
    }
    finally {
      logged.mockRestore()
    }
  })

  it('reports a route\'s own throw once', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const reported: unknown[] = []

    try {
      await Bun.write(join(dir, 'api/broken.ts'), `import { api } from 'kay/server'\n\nexport default api().get('/', () => {\n  throw new Error('${SECRET}')\n})\n`)
      const app = await pages({ routes: join(dir, 'routes'), api: join(dir, 'api'), prebuilt: false, dev: true, log: false, onError: error => void reported.push(error) })
      const response = await app.handle(new NativeRequest('http://localhost/api/broken'))

      expect(response.status).toBe(500)
      expect(reported).toHaveLength(1)
    }
    finally {
      logged.mockRestore()
      await rm(join(dir, 'api/broken.ts'))
    }
  })
})
