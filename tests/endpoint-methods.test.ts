import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { exportedEndpoints } from '../src/server/endpoints'
import { scanEndpoints } from '../src/server/routes'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

type App = Awaited<ReturnType<typeof pages>>

const ORIGIN = 'https://app.example.com'
const HEADER = 'import type { EndpointContext } from \'kay\'\nimport { s } from \'kay\'\n\n'
const FILES: Record<string, string> = {
  'routes/index.kay': 'h1 Home\n',
  'routes/_404.kay': 'h1 Custom missing\n',
  'routes/hook.txt.ts': `${HEADER}export const GET = () => 'got'\nexport const POST = async ({ request }: EndpointContext) => \`posted \${await request.text()}\`\nexport const PUT = () => 'put'\nexport const PATCH = () => 'patched'\nexport const DELETE = () => new Response(null, { status: 204 })\n`,
  'routes/only-post.txt.ts': `${HEADER}export const POST = () => 'only'\n`,
  'routes/head.txt.ts': `${HEADER}export const GET = () => 'body'\nexport const HEAD = () => new Response(null, { headers: { 'x-head': 'own' } })\n`,
  'routes/opts.txt.ts': `${HEADER}export const GET = () => 'body'\nexport const OPTIONS = () => new Response(null, { status: 200, headers: { 'x-options': 'own' } })\n`,
  'routes/items/[slug].json.ts': `${HEADER}export const GET = ({ params }: EndpointContext<{ slug: string }>) => Response.json({ slug: params.slug })\nexport const POST = ({ params }: EndpointContext<{ slug: string }>) => Response.json({ created: params.slug })\n`,
  'routes/items/[name].xml.ts': `${HEADER}export const GET = ({ params }: EndpointContext<{ name: string }>) => \`<name>\${params.name}</name>\`\n`,
  'routes/search.txt.ts': `${HEADER}export const page = { query: s.Object({ n: s.Integer({ minimum: 1 }) }) }\n\nexport const GET = ({ query }: { query: { n: number } }) => \`n=\${query.n}\`\n`,
  'routes/limited.txt.ts': `${HEADER}export const page = { rateLimit: { max: 1, window: '1m' } }\n\nexport const GET = () => 'ok'\nexport const POST = () => 'ok'\n`,
  'routes/big.txt.ts': `${HEADER}export const page = { maxSize: 10 }\n\nexport const POST = async ({ request }: EndpointContext) => \`read \${(await request.text()).length}\`\n`,
  'routes/shared.txt.ts': `${HEADER}export const page = { cors: { origins: ['${ORIGIN}'] } }\n\nexport const GET = () => 'shared'\nexport const POST = () => 'shared post'\n`,
  'routes/missing.txt.ts': `${HEADER}export const GET = ({ notFound }: EndpointContext) => notFound()\n`,
  'routes/guarded/_guard.ts': 'import { guard } from \'kay\'\n\nexport default guard(({ request, deny, cookies }) => {\n  cookies.set(\'seen\', \'1\')\n\n  if (!request.headers.has(\'authorization\'))\n    deny(401, \'Sign in first\')\n})\n',
  'routes/guarded/data.txt.ts': `${HEADER}export const POST = () => 'data'\n`,
}

let dir = ''
let plain: App
let mounted: App
let localized: App
let dev: App

beforeAll(async () => {
  dir = await scratchDir('endpoint-methods-')
  await Promise.all(Object.entries(FILES).map(async ([name, text]) => Bun.write(join(dir, name), text)))

  const base = { root: dir, dirs: { routes: 'routes' }, prebuilt: false, security: false } as const

  plain = await pages(base)
  mounted = await pages({ ...base, base: '/blog', trailingSlash: 'always' })
  localized = await pages({ ...base, i18n: { locales: ['en', 'fr'], defaultLocale: 'en', messages: resolve('tests/fixtures/i18n/src/messages') } })
  dev = await pages({ ...base, dev: true })
})

afterAll(async () => rm(dir, { recursive: true, force: true }))

async function call(app: App, path: string, init: RequestInit = {}) {
  const response = await app.handle(new Request(`http://localhost${path}`, init))

  return { status: response.status, body: await response.text(), headers: response.headers }
}

describe('an endpoint file exporting more than GET', () => {
  it('serves each verb it exports, in every way the app is mounted', async () => {
    for (const app of [plain, mounted, localized, dev]) {
      expect((await call(app, '/hook.txt')).body).toBe('got')
      expect((await call(app, '/hook.txt', { method: 'POST', body: 'x' })).body).toBe('posted x')
      expect((await call(app, '/hook.txt', { method: 'PUT' })).body).toBe('put')
      expect((await call(app, '/hook.txt', { method: 'PATCH' })).body).toBe('patched')
      expect((await call(app, '/hook.txt', { method: 'DELETE' })).status).toBe(204)
    }
  })

  it('boots a file with no GET, which answers a GET 405 rather than the 404 page', async () => {
    expect(await call(plain, '/only-post.txt', { method: 'POST' })).toMatchObject({ status: 200, body: 'only' })
    expect(await call(plain, '/only-post.txt')).toMatchObject({ status: 405, headers: expect.objectContaining({}) })
    expect((await call(plain, '/only-post.txt')).headers.get('allow')).toBe('POST, OPTIONS')
  })

  it('answers a method it does not export 405 with Allow, under a suffixed param and a base too', async () => {
    for (const app of [plain, mounted, dev]) {
      const hook = await call(app, '/hook.txt', { method: 'TRACE' })

      expect(hook.status).toBe(405)
      expect(hook.headers.get('allow')).toBe('GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS')
    }

    const put = await call(plain, '/items/a.json', { method: 'PUT' })

    expect([put.status, put.headers.get('allow')]).toEqual([405, 'GET, HEAD, POST, OPTIONS'])

    const xml = await call(plain, '/items/a.xml', { method: 'POST' })

    expect([xml.status, xml.headers.get('allow')]).toEqual([405, 'GET, HEAD, OPTIONS'])
    expect((await call(plain, '/items/a.json', { method: 'POST' })).body).toBe('{"created":"a"}')
    expect((await call(plain, '/items/a.xml')).body).toBe('<name>a</name>')
  })

  it('answers HEAD with the GET and no body, or with its own HEAD', async () => {
    const head = await call(plain, '/hook.txt', { method: 'HEAD' })

    expect([head.status, head.body]).toEqual([200, ''])
    expect((await call(plain, '/head.txt', { method: 'HEAD' })).headers.get('x-head')).toBe('own')
    expect((await call(plain, '/head.txt')).body).toBe('body')
  })

  it('answers OPTIONS with Allow, or with its own OPTIONS', async () => {
    const options = await call(plain, '/hook.txt', { method: 'OPTIONS' })

    expect([options.status, options.headers.get('allow')]).toEqual([204, 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS'])
    expect((await call(plain, '/opts.txt', { method: 'OPTIONS' })).headers.get('x-options')).toBe('own')
  })

  it('runs the guards of its directory for every verb', async () => {
    const refused = await call(plain, '/guarded/data.txt', { method: 'POST' })

    expect([refused.status, refused.body, refused.headers.get('set-cookie')?.startsWith('seen=1')]).toEqual([401, 'Sign in first', true])
    expect((await call(plain, '/guarded/data.txt', { method: 'POST', headers: { authorization: 'x' } })).body).toBe('data')
  })

  it('boots a file exporting no verb with an error naming them', async () => {
    const root = await scratchDir('endpoint-methods-none-')

    try {
      await Bun.write(join(root, 'routes/none.txt.ts'), 'export const post = () => \'x\'\n')
      await expect(pages({ root, dirs: { routes: 'routes' }, prebuilt: false, security: false })).rejects.toThrow('must export a handler for a method: GET, HEAD, POST, PUT, PATCH, DELETE or OPTIONS')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('the settings of an endpoint file', () => {
  it('reads ctx.query against `query`, a refusal answering 400', async () => {
    expect((await call(plain, '/search.txt?n=3')).body).toBe('n=3')

    const refused = await call(plain, '/search.txt?n=0')

    expect(refused.status).toBe(400)
    expect(refused.body).toContain('Invalid query')
  })

  it('answers 429 with Retry-After past `rateLimit`, counted across its verbs', async () => {
    expect((await call(plain, '/limited.txt', { headers: { 'x-forwarded-for': '1.1.1.1' } })).status).toBe(200)

    const second = await call(plain, '/limited.txt', { method: 'POST' })

    expect(second.status).toBe(429)
    expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('answers 413 before reading a body over `maxSize`', async () => {
    expect((await call(plain, '/big.txt', { method: 'POST', body: 'tiny' })).body).toBe('read 4')
    expect((await call(plain, '/big.txt', { method: 'POST', body: 'x'.repeat(50) })).status).toBe(413)
    expect((await call(mounted, '/big.txt', { method: 'POST', body: 'x'.repeat(50) })).status).toBe(413)
  })

  it('answers a preflight and grants the origin its `cors` lists, refusing a cross-site post it does not', async () => {
    const preflight = await call(plain, '/shared.txt', { method: 'OPTIONS', headers: { 'origin': ORIGIN, 'access-control-request-method': 'POST' } })

    expect([preflight.status, preflight.headers.get('access-control-allow-origin'), preflight.headers.get('access-control-allow-methods')]).toEqual([204, ORIGIN, 'GET, HEAD, POST, OPTIONS'])

    const granted = await call(plain, '/shared.txt', { method: 'POST', headers: { 'origin': ORIGIN, 'sec-fetch-site': 'cross-site' } })

    expect([granted.status, granted.body, granted.headers.get('access-control-allow-origin')]).toEqual([200, 'shared post', ORIGIN])
    expect((await call(plain, '/shared.txt', { method: 'POST', headers: { 'origin': 'https://evil.example', 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
  })

  it('refuses a cross-site browser post to a file with no `cors`, and accepts a webhook with no Origin', async () => {
    expect((await call(plain, '/hook.txt', { method: 'POST', body: 'a', headers: { 'origin': 'https://evil.example', 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    expect((await call(plain, '/hook.txt', { method: 'POST', body: 'a' })).status).toBe(200)
    expect((await call(plain, '/hook.txt', { headers: { 'origin': 'https://evil.example', 'sec-fetch-site': 'cross-site' } })).status).toBe(200)
  })
})

describe('a 404 from an endpoint file', () => {
  const html = { accept: 'text/html' }

  it('renders `_404.kay` for a request asking HTML and stays plain text otherwise', async () => {
    for (const app of [plain, mounted, localized, dev]) {
      const page = await call(app, '/items/a.csv', { headers: html })

      expect([page.status, page.headers.get('content-type')?.startsWith('text/html'), page.body.includes('Custom missing')]).toEqual([404, true, true])

      const text = await call(app, '/items/a.csv')

      expect([text.status, text.body]).toEqual([404, 'Not Found'])
    }
  })

  it('covers a notFound() thrown by the handler too', async () => {
    const page = await call(plain, '/missing.txt', { headers: html })

    expect([page.status, page.body.includes('Custom missing')]).toEqual([404, true])
    expect((await call(plain, '/missing.txt')).body).toBe('Not Found')
  })
})

describe('a static export of endpoint files', () => {
  it('lists the GET of a file and leaves out one with no GET', async () => {
    const { paths } = await exportedEndpoints(dir, await scanEndpoints(join(dir, 'routes')))

    expect(paths).toContain('/hook.txt')
    expect(paths).not.toContain('/only-post.txt')
  })
})
