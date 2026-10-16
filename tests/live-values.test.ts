import type { LivePage, LiveRequest, LiveUpdate } from '../src/runtime/live-value'
import type { TestSite } from '../src/test'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { chromium } from 'playwright-core'
import { outputDir } from '../src/build/assets'
import { liveIds } from '../src/build/live-ids'
import { compileKay } from '../src/compiler'
import { decodeServerValue } from '../src/runtime/wire'
import { browserPath, testSite } from '../src/test'
import { fixtureCopy } from './scratch'

const ROOT = 'tests/fixtures/live-values'
const VISITORS = 'src/live.ts#visitors'
const ROOM = 'src/live.ts#room'
const SECRET = 'src/live.ts#secret'
const SCRIPT = /<script type="application\/json" data-kay-live>([^<]*)<\/script>/g
const JSON_POST = { method: 'POST', headers: { 'content-type': 'application/json' } }

// The live values of the fixture, imported once a site is up: its plugin gives them their ids.
type Values = typeof import('./fixtures/live-values/src/live')

async function values(): Promise<Values> {
  return import(resolve(ROOT, 'src/live.ts')) as Promise<Values>
}

// The scripts of live values a page carries, read as its islands read them.
function pagesOf(html: string): LivePage[] {
  return [...html.matchAll(SCRIPT)].map(([, text]) => decodeServerValue(text!.replaceAll('\\u003c', '<')) as LivePage)
}

function proofsOf(pages: LivePage[]): LiveRequest['proofs'] {
  return pages.map(({ values, sig }) => ({ keys: values.map(([id, key]) => [id, key] as [string, string]), sig }))
}

// The values a page read, once each.
function idsOf(page: LivePage): string[] {
  return [...new Set(page.values.map(([id]) => id))].toSorted()
}

// What a connection delivers, one event at a time.
class Feed {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private readonly decoder = new TextDecoder()
  private buffer = ''

  constructor(readonly response: Response) {
    this.reader = response.body!.getReader()
  }

  async next(): Promise<LiveUpdate[]> {
    for (;;) {
      const end = this.buffer.indexOf('\n\n')

      if (end !== -1) {
        const block = this.buffer.slice(0, end)

        this.buffer = this.buffer.slice(end + 2)

        const data = block.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')

        if (data !== '')
          return decodeServerValue(data) as LiveUpdate[]

        continue
      }

      const { done, value } = await this.reader.read()

      if (done)
        throw new Error('the connection ended')

      this.buffer += this.decoder.decode(value, { stream: true })
    }
  }

  async close(): Promise<void> {
    await this.reader.cancel()
  }
}

async function tick(): Promise<void> {
  await Bun.sleep(10)
}

describe('live values on the server', () => {
  let site: TestSite
  let live: Values

  async function open(page: string, watch: LiveRequest['watch']): Promise<Response> {
    const html = (await site.visit(page)).html

    return site.fetch('/_kay/live', { ...JSON_POST, body: JSON.stringify({ proofs: proofsOf(pagesOf(html)), watch } satisfies LiveRequest) })
  }

  beforeAll(async () => {
    site = await testSite({ root: ROOT, locals: request => ({ user: request.headers.get('x-user') ?? undefined }) })
    live = await values()
  })

  afterAll(async () => site.close())

  it('writes the live values a page read into it, each as it rendered, with a proof of their ids', async () => {
    live.visitors.set(3)
    live.room.set('lobby', { id: 'lobby', users: 2 })

    const { html } = await site.visit('/')
    const [page, ...others] = pagesOf(html)

    expect(others).toEqual([])
    expect(idsOf(page!)).toEqual([ROOM, VISITORS])
    expect(page!.values).toEqual(expect.arrayContaining([[VISITORS, '', 3], [ROOM, 'lobby', { id: 'lobby', users: 2 }]]))
    expect(page!.sig).toMatch(/^[\w-]{20,}$/)
    expect(html).toMatch(/<p class="online"><!--\[-->3<!--\]--> online<\/p>/)
  })

  it('writes nothing into a page reading none, which renders no island', async () => {
    const { html } = await site.visit('/about')

    expect(html).not.toContain('data-kay-live')
    expect(html).not.toContain('/_kay/live')
    expect(html).not.toContain('<slot data-component')
  })

  it('renders a keyed value for the key the page names, a default for a key nothing was set for', async () => {
    const { html } = await site.visit('/room/nowhere')

    expect(html).toMatch(/<p class="users" data-room="nowhere"><!--\[-->0<!--\]--> in <!--\[-->nowhere<!--\]--><\/p>/)
    expect(pagesOf(html)[0]!.values).toEqual([[ROOM, 'nowhere', { id: 'nowhere', users: 0 }]])
  })

  it('sends every watched value as it is, then each change', async () => {
    live.visitors.set(10)

    const feed = new Feed(await open('/other', [[VISITORS, '']]))

    expect(await feed.next()).toEqual([[VISITORS, '', 10]])

    live.visitors.set(n => n + 1)
    expect(await feed.next()).toEqual([[VISITORS, '', 11]])
    await feed.close()
  })

  it('sends one event for the changes of one tick, the last value of each', async () => {
    live.visitors.set(0)

    const feed = new Feed(await open('/', [[VISITORS, ''], [ROOM, 'lobby']]))

    await feed.next()
    live.visitors.set(1)
    live.visitors.set(2)
    live.room.set('lobby', { id: 'lobby', users: 5 })

    expect(await feed.next()).toEqual([[VISITORS, '', 2], [ROOM, 'lobby', { id: 'lobby', users: 5 }]])
    await feed.close()
  })

  it('sends nothing for a write that changes nothing', async () => {
    live.visitors.set(4)

    const feed = new Feed(await open('/other', [[VISITORS, '']]))

    await feed.next()
    live.visitors.set(4)
    live.visitors.set(5)

    expect(await feed.next()).toEqual([[VISITORS, '', 5]])
    await feed.close()
  })

  it('sends a key only the changes of that key', async () => {
    const feed = new Feed(await open('/', [[ROOM, 'lobby']]))

    expect(await feed.next()).toEqual([[ROOM, 'lobby', expect.objectContaining({ id: 'lobby' })]])
    live.room.set('elsewhere', { id: 'elsewhere', users: 9 })
    live.room.set('lobby', { id: 'lobby', users: 7 })

    expect(await feed.next()).toEqual([[ROOM, 'lobby', { id: 'lobby', users: 7 }]])
    live.room.delete('lobby')
    expect(await feed.next()).toEqual([[ROOM, 'lobby', { id: 'lobby', users: 0 }]])
    await feed.close()
  })

  it('stops watching once the connection closes', async () => {
    const { liveSlot } = await import('../src/runtime/live-value')
    const feed = new Feed(await open('/other', [[VISITORS, '']]))

    await feed.next()
    expect(liveSlot(VISITORS)!.listeners.get('')?.size).toBe(1)
    await feed.close()
    await tick()
    expect(liveSlot(VISITORS)!.listeners.get('')).toBeUndefined()
  })

  it('refuses a request without a page\'s proof, with a forged one or for ids the proof does not name', async () => {
    const { html } = await site.visit('/other')
    const [page] = pagesOf(html)
    const ask = async (proofs: LiveRequest['proofs'], watch: LiveRequest['watch']) => (await site.fetch('/_kay/live', { ...JSON_POST, body: JSON.stringify({ proofs, watch }) })).status

    expect(await ask([], [[VISITORS, '']])).toBe(403)
    expect(await ask([{ keys: proofsOf([page!])[0]!.keys, sig: `${page!.sig}x` }], [[VISITORS, '']])).toBe(403)
    expect(await ask([{ keys: [[SECRET, '']], sig: page!.sig }], [[SECRET, '']])).toBe(403)
    expect(await ask(proofsOf([page!]), [[SECRET, '']])).toBe(403)
    expect(await ask(proofsOf([page!]), [['src/live.ts#missing', '']])).toBe(403)
  })

  it('lets a proof cover only the keys its page read, not another key of the same value', async () => {
    const proofs = proofsOf(pagesOf((await site.visit('/room/lobby')).html))
    const ask = async (key: string) => (await site.fetch('/_kay/live', { ...JSON_POST, body: JSON.stringify({ proofs, watch: [[ROOM, key]] }) })).status

    expect(await ask('elsewhere')).toBe(403)
    expect(await ask('x'.repeat(300))).toBe(400)

    const feed = new Feed(await site.fetch('/_kay/live', { ...JSON_POST, body: JSON.stringify({ proofs, watch: [[ROOM, 'lobby']] }) }))

    expect((await feed.next()).map(([id, key]) => [id, key])).toEqual([[ROOM, 'lobby']])
    await feed.close()
  })

  it('lets a proof cover only what its page read, a watched id outside it ignored', async () => {
    const feed = new Feed(await open('/other', [[VISITORS, ''], [SECRET, '']]))

    expect((await feed.next()).map(([id]) => id)).toEqual([VISITORS])
    await feed.close()
  })

  it('refuses a request another site made, a malformed one and one watching nothing', async () => {
    const { html } = await site.visit('/other')
    const proofs = proofsOf(pagesOf(html))
    const post = async (body: string, headers: Record<string, string> = {}) => (await site.fetch('/_kay/live', { ...JSON_POST, headers: { ...JSON_POST.headers, ...headers }, body })).status
    const valid = JSON.stringify({ proofs, watch: [[VISITORS, '']] })

    expect(await post(valid, { 'sec-fetch-site': 'cross-site' })).toBe(403)
    expect(await post(valid, { origin: 'https://evil.example' })).toBe(403)
    expect(await post('{')).toBe(400)
    expect(await post(JSON.stringify({ proofs }))).toBe(400)
    expect(await post(JSON.stringify({ proofs, watch: [] }))).toBe(400)
    expect(await post(JSON.stringify({ proofs, watch: [[VISITORS, 4]] }))).toBe(400)
    expect(await post(JSON.stringify({ proofs: [{ keys: [[1, '']], sig: 'x' }], watch: [[VISITORS, '']] }))).toBe(400)
    expect(await post(JSON.stringify({ proofs, watch: Array.from({ length: 501 }, () => [VISITORS, '']) }))).toBe(400)
  })

  it('keeps a value from a page a guard refuses', async () => {
    const refused = await site.visit('/private')

    expect(refused.status).toBe(401)
    expect(refused.html).not.toContain('data-kay-live')

    const allowed = await site.visit('/private', { headers: { 'x-user': 'ada' } })

    expect(idsOf(pagesOf(allowed.html)[0]!)).toEqual([SECRET])
  })

  it('refuses a value a browser cannot be sent where it is set', async () => {
    expect(() => (live.visitors as { set: (value: unknown) => void }).set(new (class Opaque {})())).toThrow('cannot reach the browser')
  })

  it('reads and writes like a plain value outside a request, a keyed one falling back to what its declaration gives', async () => {
    live.visitors.set(8)
    live.room.delete('fresh')

    expect(live.visitors()).toBe(8)
    expect(live.room('fresh')).toEqual({ id: 'fresh', users: 0 })
  })
})

describe('live values in a page', () => {
  it.each([
    ['a base path and a trailing slash', { base: '/shop', trailingSlash: 'always' as const }, '/'],
    ['no base', {}, '/'],
  ])('gets its proof and its values with %s', async (_, options, path) => {
    const site = await testSite({ root: ROOT, ...options })

    try {
      const { html } = await site.visit(path)

      expect(idsOf(pagesOf(html)[0]!)).toEqual([ROOM, VISITORS])

      const answer = await site.fetch(`/_kay/live`, { ...JSON_POST, body: JSON.stringify({ proofs: proofsOf(pagesOf(html)), watch: [[VISITORS, '']] }) })

      expect(answer.status).toBe(200)
      expect(answer.headers.get('content-type')).toContain('text/event-stream')
      await answer.body!.cancel()
    }
    finally {
      await site.close()
    }
  })

  it('gets the same ids in each locale', async () => {
    const site = await testSite({ root: ROOT, i18n: { locales: ['en', 'fr'], defaultLocale: 'en' } })

    try {
      const english = pagesOf((await site.visit('/')).html)[0]!
      const french = pagesOf((await site.visit('/fr/')).html)[0]!

      expect(idsOf(french)).toEqual(idsOf(english))
      expect(french.sig).toBe(english.sig)
    }
    finally {
      await site.close()
    }
  })
})

describe('the id of a live value', () => {
  const named = (declaration: string) => liveIds(`import { live } from 'kay'\n\n${declaration}\n`, '/app/src/live.ts', '/app')

  it('is added after the argument however it is written', () => {
    expect(named('export const a = live(0)')).toContain('live(0, "src/live.ts#a")')
    expect(named('export const a = live((0))')).toContain('live((0), "src/live.ts#a")')
    expect(named('export const a = live(0,)')).toContain('live(0, "src/live.ts#a")')
    expect(named('export const a = live({ x: [1, 2] })')).toContain('live({ x: [1, 2] }, "src/live.ts#a")')
    expect(named('export const a = live(0 // first, then more\n)')).toContain('live(0, "src/live.ts#a" // first, then more\n)')
    expect(named('export const a = live(0 /* zero */)')).toContain('live(0, "src/live.ts#a" /* zero */)')
    expect(named('export const a = live(\n  (id: string) => ({ id }),\n)')).toContain('({ id }), "src/live.ts#a"\n)')
  })
})

describe('writing a live value in a browser', () => {
  const imported = { '../live': { visitors: 'live' as const, room: 'live' as const } }
  const compile = (source: string, filename = 'src/components/writer.kay') => compileKay(source, filename, { importedSignals: imported, check: true }).diagnostics.map(diagnostic => diagnostic.message)

  it('is refused where a template or a script assigns it', () => {
    expect(compile('---\nimport { visitors } from \'../live\'\n---\nbutton(onClick={() => visitors = 1}) Reset\n')).toEqual(['`visitors` is a live value, which the server writes and a browser only reads'])
  })

  it('is refused where a script or a handler calls its setter', () => {
    expect(compile('---\nimport { visitors } from \'../live\'\n---\nbutton(onClick={() => visitors.set(1)}) Reset\n')).toEqual(['`visitors` is a live value, written on the server: from a server fence, an action or a job'])
    expect(compile('---\nimport { room } from \'../live\'\n\nroom.set(\'a\', { id: \'a\', users: 1 })\n---\np Hi\n')).toEqual(['`room` is a live value, written on the server: from a server fence, an action or a job'])
  })

  it('is allowed in a server fence', () => {
    expect(compile('---\nimport { visitors } from \'../live\'\n--- server\nvisitors.set(n => n + 1)\n---\np Hi\n', 'src/routes/hit.kay')).toEqual([])
  })

  it('is refused in the template of a page that renders once, and read freely in its server fence', () => {
    const page = '---\nimport { visitors } from \'../live\'\n--- server\nconst now = visitors()\n---\np {visitors()} {now}\n'

    expect(compile(page, 'src/routes/count.kay')).toEqual(['`visitors` is a live value read in a template that renders once on the server'])
    expect(compile(page.replace('{visitors()} ', ''), 'src/routes/count.kay')).toEqual([])
    expect(compile('---\nimport { visitors } from \'../live\'\n---\np {visitors()}\n', 'src/routes/_layout.kay')).toEqual(['`visitors` is a live value read in a template that renders once on the server'])
    expect(compile('---\nimport { visitors } from \'../live\'\n---\np {visitors()}\n', 'src/routes/count.kay')).toEqual([])
  })

  it('is read as a signal is: called, not named', () => {
    expect(compile('---\nimport { visitors } from \'../live\'\n---\np {visitors}\n')).toEqual(['`visitors` is a live value, read by calling it'])
  })
})

const chrome = browserPath() ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined)

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(chrome === undefined && (process.env.CI ?? '') === '')('live values in a browser', () => {
  let site: TestSite
  let live: Values
  const connections: string[] = []

  beforeAll(async () => {
    const count = new Elysia().onRequest(({ request }) => {
      if (request.method === 'POST' && new URL(request.url).pathname === '/_kay/live')
        connections.push(request.url)
    })

    site = await testSite({ root: ROOT, use: [count], browser: { path: chrome } })
    live = await values()
  }, 120_000)

  afterAll(async () => site?.close())

  it('keeps a value current on the open page, from the server render on', async () => {
    live.visitors.set(7)

    await using page = await site.open('/')

    expect(await page.text('p.online')).toBe('7 online')
    live.visitors.set(8)
    await page.waitUntil(() => document.querySelector('p.online')?.textContent === '8 online')
    live.visitors.set(n => n + 10)
    await page.waitUntil(() => document.querySelector('p.online')?.textContent === '18 online')
    expect(page.errors).toEqual([])
  })

  it('carries every value of a page, a keyed one included, on one connection', async () => {
    connections.length = 0
    live.room.set('lobby', { id: 'lobby', users: 1 })

    await using page = await site.open('/')

    await page.waitUntil(() => document.querySelector('p.users')?.textContent === '1 in lobby')
    live.room.set('lobby', { id: 'lobby', users: 4 })
    await page.waitUntil(() => document.querySelector('p.users')?.textContent === '4 in lobby')
    expect(connections).toHaveLength(1)
  })

  it('opens no connection and loads no script for a page reading none', async () => {
    connections.length = 0

    await using page = await site.open('/about')

    await Bun.sleep(150)
    expect(connections).toEqual([])
    expect(await page.evaluate(() => document.querySelectorAll('script[type=module]').length)).toBe(0)
    expect(await page.evaluate(() => performance.getEntriesByType('resource').filter(entry => entry.name.endsWith('.js')).length)).toBe(0)
  })

  it('follows a link to a page reading the same value on the connection it has, and drops it on one reading none', async () => {
    connections.length = 0
    live.visitors.set(1)

    await using page = await site.open('/')

    await page.waitUntil(() => document.querySelector('p.users') !== null)
    await page.click('a.other')
    await page.waitUntil(() => location.pathname === '/other')
    expect(await page.text('p.online')).toBe('1 online')
    live.visitors.set(2)
    await page.waitUntil(() => document.querySelector('p.online')?.textContent === '2 online')
    await page.click('a.about')
    await page.waitUntil(() => location.pathname === '/about')

    const { liveSlot } = await import('../src/runtime/live-value')

    for (let waited = 0; liveSlot(VISITORS)!.listeners.get('') !== undefined && waited < 2000; waited += 25)
      await Bun.sleep(25)

    expect(liveSlot(VISITORS)!.listeners.get('')).toBeUndefined()
    await page.click('a.home')
    await page.waitUntil(() => location.pathname === '/')
    live.visitors.set(3)
    await page.waitUntil(() => document.querySelector('p.online')?.textContent === '3 online')
    expect(page.errors).toEqual([])
  })

  it('follows the value of the key a page was rendered for', async () => {
    live.room.set('green', { id: 'green', users: 2 })

    await using page = await site.open('/room/green')

    expect(await page.text('p.users')).toBe('2 in green')
    live.room.set('green', { id: 'green', users: 3 })
    await page.waitUntil(() => document.querySelector('p.users')?.textContent === '3 in green')
  })
})

// A server that refuses or drops the connections of a page as a deploy or a restart does: each POST to the live route takes the next step of `plan`, `drop` an event stream that ends at once and a number a response of that status; past the plan they go through.
function flaky() {
  const plan: (number | 'drop')[] = []
  const posts: string[] = []
  const app = new Elysia().onRequest(({ request }) => {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/_kay/live')
      return undefined

    posts.push(request.url)

    const step = plan.shift()

    if (step === 'drop')
      return new Response('', { headers: { 'content-type': 'text/event-stream' } })

    return step === undefined ? undefined : new Response(null, { status: step })
  })

  return { app, plan, posts }
}

describe.skipIf(chrome === undefined && (process.env.CI ?? '') === '')('live values across a restart', () => {
  let site: TestSite
  let live: Values
  const server = flaky()

  beforeAll(async () => {
    site = await testSite({ root: ROOT, use: [server.app], browser: { path: chrome } })
    live = await values()
  }, 120_000)

  afterAll(async () => site?.close())

  it.each([
    ['an event stream that ended', ['drop' as const]],
    ['a 403, a proof the server no longer takes', [403]],
    ['a 429', [429]],
    ['all of them in a row', ['drop' as const, 403, 429]],
  ])('keeps following past %s', async (_, plan) => {
    server.posts.length = 0
    server.plan.push(...plan)
    live.visitors.set(20)

    await using page = await site.open('/other')

    await page.waitUntil(() => document.querySelector('p.online')?.textContent === '20 online')
    live.visitors.set(21)
    await page.waitUntil(() => document.querySelector('p.online')?.textContent === '21 online', { timeout: 15_000 })
    expect(server.posts.length).toBe(plan.length + 1)
    expect(page.errors).toEqual([])
  })

  it('leaves one connection when the page changes during a backoff', async () => {
    server.posts.length = 0
    server.plan.push(429, 429, 429)
    live.visitors.set(30)

    await using page = await site.open('/')

    await page.waitUntil(() => document.querySelector('p.online') !== null)
    await page.click('a.other')
    await page.waitUntil(() => location.pathname === '/other')
    live.visitors.set(31)
    await page.waitUntil(() => document.querySelector('p.online')?.textContent === '31 online', { timeout: 15_000 })

    const { liveSlot } = await import('../src/runtime/live-value')

    expect(liveSlot(VISITORS)!.listeners.get('')?.size).toBe(1)
  })
})

describe('live values in a production build', () => {
  it('builds, keeps the pages reading none, and serves the rest per request with a connection each', async () => {
    const root = resolve(await fixtureCopy('live-values'))

    await Bun.write(join(root, 'kay.config.ts'), 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ log: false })\n')

    const build = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'build', root, '--no-check'], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'production' } })
    const [out, err, built] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited])

    if (built !== 0)
      throw new Error(`${out}${err}`)

    const manifest = await Bun.file(join(outputDir(root), 'manifest.json')).json() as { pages: Record<string, unknown> }

    expect(Object.keys(manifest.pages)).toContain('/about')
    expect(Object.keys(manifest.pages)).not.toContain('/')
    expect(Object.keys(manifest.pages)).not.toContain('/other')

    const wire = JSON.stringify(join(import.meta.dir, '../src/runtime/wire'))
    const server = JSON.stringify(join(import.meta.dir, '../src/server'))
    const script = [
      'import { Elysia } from \'elysia\'',
      `import { pages } from ${server}`,
      `import { decodeServerValue } from ${wire}`,
      '',
      `const app = new Elysia().use(await pages({ root: ${JSON.stringify(root)}, prebuilt: true, log: false, compress: false }))`,
      'const page = async path => (await app.handle(new Request(`http://localhost${path}`))).text()',
      'const home = await page(\'/\')',
      'const about = await page(\'/about\')',
      'const found = /<script type="application\\/json" data-kay-live>([^<]*)<\\/script>/.exec(home)?.[1]',
      'const proof = decodeServerValue(found)',
      'const live = await app.handle(new Request(\'http://localhost/_kay/live\', { method: \'POST\', headers: { \'content-type\': \'application/json\' }, body: JSON.stringify({ proofs: [{ keys: proof.values.map(([id, key]) => [id, key]), sig: proof.sig }], watch: [[\'src/live.ts#visitors\', \'\']] }) }))',
      'const first = new TextDecoder().decode((await live.body.getReader().read()).value)',
      'console.log(JSON.stringify({ home: home.includes(\'data-kay-live\'), module: /<script type="module"/.test(home), about: about.includes(\'data-kay-live\'), aboutModule: about.includes(\'type="module"\'), status: live.status, type: live.headers.get(\'content-type\'), first }))',
      'process.exit(0)',
      '',
    ].join('\n')

    await Bun.write(join(root, 'serve.ts'), script)

    const serve = Bun.spawn([process.execPath, join(root, 'serve.ts')], { cwd: root, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'production' } })
    const [served, problem, code] = await Promise.all([new Response(serve.stdout).text(), new Response(serve.stderr).text(), serve.exited])

    if (code !== 0)
      throw new Error(`${served}${problem}`)

    const answer = JSON.parse(served.slice(served.lastIndexOf('\n{') + 1)) as Record<string, unknown>

    expect(answer).toMatchObject({ home: true, module: true, about: false, aboutModule: false, status: 200 })
    expect(String(answer.type)).toContain('text/event-stream')
    expect(String(answer.first)).toContain('src/live.ts#visitors')
  }, 120_000)
})
