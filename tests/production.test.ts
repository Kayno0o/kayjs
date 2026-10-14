import type { Server } from 'bun'
import type { Action } from '../src/runtime'
import type { ClientBuild } from '../src/server/client'
import type { LogEntry } from '../src/server/log'
import type { ProtectionRefusal } from '../src/server/protection'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { brotliDecompressSync, constants } from 'node:zlib'
import { Database } from 'bun:sqlite'
import { describe, expect, it, setSystemTime, spyOn } from 'bun:test'
import { parse, stringify } from 'devalue'
import { Elysia, t } from 'elysia'
import { version } from '../package.json'
import { KayCompileError } from '../src/build/transform'
import { check } from '../src/check'
import { compileKay } from '../src/compiler'
import { resolveProject } from '../src/project'
import { action, logFrom } from '../src/runtime'
import { sqliteCache } from '../src/runtime/cache.server'
import { logSink, setLogSink } from '../src/runtime/log'
import { solveWork } from '../src/runtime/work'
import { inlineScriptHashes, invalidatePage, pages, requestId, shutdown, sqliteJobs, sqliteStore } from '../src/server'
import { servePages } from '../src/server/app'
import { readClient, readManifest } from '../src/server/client'
import { compressTextStrongest } from '../src/server/compress'
import { probeHealth } from '../src/server/lifecycle'
import { answeringRequest, useLogger } from '../src/server/log'
import { hookPrerendered } from '../src/server/page-hook'
import { clientAddress, countSucceeded, memoryRates, protectionRefusal, rateKey, rateLimit, sqliteRates } from '../src/server/protection'
import { securityHeaders } from '../src/server/security'
import { signStamp } from '../src/server/stamp'
import { CspViolation } from '../src/server/violations'
import { testSite } from '../src/test'
import { parsingRoutes, routePaths } from './elysia'
import { prerendered, refusedPrerender } from './prerendered'
import { fixtureCopy, scratchDir } from './scratch'

const ROUTES = 'tests/fixtures/seo/src/routes'
// A rate key as `sqliteRates` stores it: a SHA-256 in base64url.
const HASHED_KEY = /^[\w-]{43}$/

function socket(address: string): Server<unknown> {
  return { requestIP: () => ({ address }) } as unknown as Server<unknown>
}

// What a post was refused with, a honeypot pretending aside.
// What a script prints, run in a process of its own, as a test file run before may have given this one a stamp secret already.
async function isolated(script: string): Promise<unknown> {
  const run = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()])

  expect({ code: await run.exited, err }).toEqual({ code: 0, err: '' })

  return JSON.parse(out)
}

async function refusalOf(...args: Parameters<typeof protectionRefusal>): Promise<ProtectionRefusal | undefined> {
  return await protectionRefusal(...args) as ProtectionRefusal | undefined
}

// Bun's own timeout per test is 5 s: a test waiting here sets a longer one, so this error shows first.
const UNTIL_TEST_MS = 20_000

async function until(holds: () => Promise<boolean>, what: string, timeout = 10_000): Promise<void> {
  const end = performance.now() + timeout

  while (!await holds()) {
    if (performance.now() > end)
      throw new Error(`timed out waiting for ${what}`)

    await Bun.sleep(10)
  }
}

function directives(policy: string | null): Map<string, string[]> {
  return new Map(policy!.split('; ').map((directive) => {
    const [name, ...sources] = directive.split(' ')

    return [name!, sources]
  }))
}

describe('security headers', () => {
  it('sends a strict policy allowing kay\'s inline scripts, and the other headers, on pages and app routes alike', async () => {
    const app = new Elysia().get('/api/ping', () => 'pong').use(await pages({ routes: ROUTES, prebuilt: false }))

    for (const path of ['/about', '/api/ping', '/sitemap-missing']) {
      const response = await app.handle(new Request(`http://localhost${path}`))
      const policy = directives(response.headers.get('content-security-policy'))

      expect(policy.get('default-src')).toEqual(['\'self\''])
      expect(policy.get('script-src')).toEqual(['\'self\'', ...inlineScriptHashes()])
      expect(policy.get('object-src')).toEqual(['\'none\''])
      expect(policy.get('frame-ancestors')).toEqual(['\'self\''])
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
      expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN')
      expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin')
      expect(response.headers.get('cross-origin-resource-policy')).toBe('same-site')
      expect(response.headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()')
      expect(response.headers.get('x-permitted-cross-domain-policies')).toBe('none')
      expect(response.headers.has('content-security-policy-report-only')).toBe(false)
      expect(response.headers.has('reporting-endpoints')).toBe(false)
    }
  })

  it('adds what the islands run to the app\'s own directives, unless it removes one or sets it to none', () => {
    const islands = { 'script-src': ['\'wasm-unsafe-eval\''], 'worker-src': ['\'self\'', 'blob:'] }
    const own = securityHeaders({ islands, security: { csp: { 'script-src': ['\'self\'', 'https://cdn.example.com'], 'worker-src': false }, reportOnly: { 'worker-src': ['\'none\''] } } })!
    const enforced = directives(own['content-security-policy']!)
    const trial = directives(own['content-security-policy-report-only']!)

    expect(enforced.get('script-src')).toEqual(['\'self\'', 'https://cdn.example.com', '\'wasm-unsafe-eval\'', ...inlineScriptHashes()])
    expect(enforced.has('worker-src')).toBe(false)
    expect(trial.get('worker-src')).toEqual(['\'none\''])
    expect(trial.get('script-src')).toContain('\'wasm-unsafe-eval\'')
    expect(directives(securityHeaders({ islands })!['content-security-policy']!).get('worker-src')).toEqual(['\'self\'', 'blob:'])
    expect(securityHeaders({ islands, security: false })).toBeUndefined()
  })

  it('sends X-Frame-Options as frame-ancestors says, under the app\'s own', () => {
    const frames = (csp: Record<string, string[] | false> | false, headers?: Record<string, string | false>, page?: Record<string, string[]>) => securityHeaders({ security: { csp, headers } }, page ? [{ csp: page }] : [])!['x-frame-options']

    expect(frames({})).toBe('SAMEORIGIN')
    expect(frames({ 'frame-ancestors': ['\'none\''] })).toBe('DENY')
    expect(frames({ 'frame-ancestors': ['\'self\'', 'https://cms.example.com'] })).toBeUndefined()
    expect(frames({ 'frame-ancestors': ['https://cms.example.com'] })).toBeUndefined()
    expect(frames({ 'frame-ancestors': false })).toBeUndefined()
    expect(frames({}, {}, { 'frame-ancestors': ['https://cms.example.com'] })).toBeUndefined()
    expect(frames({ 'frame-ancestors': ['\'none\''] }, { 'x-frame-options': 'SAMEORIGIN' })).toBe('SAMEORIGIN')
    expect(frames(false)).toBe('SAMEORIGIN')
    expect(frames({ 'frame-ancestors': [] })).toBe('DENY')
    expect(frames({ 'frame-ancestors': ['\'None\''] })).toBe('DENY')
    expect(frames({ 'frame-ancestors': ['\'self\''] })).toBe('SAMEORIGIN')
    expect(frames({ 'frame-ancestors': ['\'self\'', '\'SELF\''] })).toBe('SAMEORIGIN')
    expect(securityHeaders({ security: { reportOnly: { 'frame-ancestors': ['\'none\''] } } })!['x-frame-options']).toBe('SAMEORIGIN')
    expect(securityHeaders({ security: false }, [{ headers: { 'cross-origin-embedder-policy': 'require-corp' } }])).toEqual({ 'cross-origin-embedder-policy': 'require-corp' })
  })

  it('starts a directive a page adds from the policy before the page, whatever order the page lists its directives in', () => {
    const policy = (csp: Record<string, string[]>) => directives(securityHeaders({}, [{ csp }])!['content-security-policy']!)
    const cdn = 'https://cdn.example.com'
    const player = 'https://player.example.com'
    const [first, second] = [policy({ 'worker-src': ['blob:'], 'script-src': [cdn], 'child-src': [player], 'frame-src': ['https://frame.example.com'] }), policy({ 'frame-src': ['https://frame.example.com'], 'child-src': [player], 'script-src': [cdn], 'worker-src': ['blob:'] })]

    for (const name of ['worker-src', 'frame-src', 'script-src', 'child-src'])
      expect(first.get(name)).toEqual(second.get(name))

    expect(first.get('worker-src')).not.toContain(cdn)
    expect(first.get('frame-src')).not.toContain(player)
  })

  it('sends them on the build\'s files and image variants too, under a header the app set itself', async () => {
    const routes = 'tests/fixtures/images/src/routes'
    const stock = await pages({ routes, prebuilt: false })
    const own = new Elysia()
      .onRequest(({ set }) => {
        set.headers['content-security-policy'] = 'default-src *'
      })
      .use(await pages({ routes, prebuilt: false }))
    const hero = (/src=(%2F_kay%2Fassets%2F[^&]+)&amp;/).exec(await (await stock.handle(new Request('http://localhost/'))).text())![1]!
    const paths = [decodeURIComponent(hero), `/_kay/image?src=${hero}&w=320`, `/_kay/image?src=${hero}&w=7`]

    for (const app of [stock, own]) {
      for (const path of paths) {
        const response = await app.handle(new Request(`http://localhost${path}`, { headers: { accept: 'image/avif' } }))

        expect(response.headers.get('x-content-type-options')).toBe('nosniff')
        expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN')
        expect(response.headers.get('content-security-policy')?.startsWith(app === own ? 'default-src *' : 'default-src \'self\'')).toBe(true)
      }
    }

    // A file route answers no other method, which gets Elysia's own answer, secured as any other.
    for (const path of paths) {
      const response = await stock.handle(new Request(`http://localhost${path}`, { method: 'POST' }))

      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN')
      expect(response.headers.get('content-security-policy')?.startsWith('default-src \'self\'')).toBe(true)
    }
  })

  it('allows the live-reload script in development, as the server\'s mode says whatever its config holds', async () => {
    const scriptSources = async (app: { handle: (request: Request) => Promise<Response> }) => directives((await app.handle(new Request('http://localhost/about'))).headers.get('content-security-policy')).get('script-src')
    const dev = { dev: true, prebuilt: false, underKayDev: false }

    expect(await scriptSources(await pages({ routes: ROUTES, prebuilt: false, dev: true }))).toEqual(['\'self\'', ...inlineScriptHashes({ dev: true })])
    expect(await scriptSources(await servePages(resolveProject(process.cwd(), { routes: ROUTES }, dev), async () => (await readClient(process.cwd()))!))).toEqual(['\'self\'', ...inlineScriptHashes({ dev: true })])
  })

  it('merges the app\'s directives and headers over kay\'s, false leaving one out', async () => {
    const app = await pages({
      routes: ROUTES,
      prebuilt: false,
      security: {
        csp: { 'img-src': ['\'self\''], 'frame-ancestors': false, 'script-src': ['\'self\'', 'https://cdn.example.com'] },
        headers: { 'Strict-Transport-Security': 'max-age=63072000', 'x-frame-options': false, 'permissions-policy': 'geolocation=(self)', 'cross-origin-opener-policy': false },
      },
    })
    const response = await app.handle(new Request('http://localhost/about'))
    const policy = directives(response.headers.get('content-security-policy'))

    expect(policy.get('img-src')).toEqual(['\'self\''])
    expect(policy.has('frame-ancestors')).toBe(false)
    expect(policy.get('script-src')).toEqual(['\'self\'', 'https://cdn.example.com', ...inlineScriptHashes()])
    expect(response.headers.get('strict-transport-security')).toBe('max-age=63072000')
    expect(response.headers.has('x-frame-options')).toBe(false)
    expect(response.headers.get('permissions-policy')).toBe('geolocation=(self)')
    expect(response.headers.has('cross-origin-opener-policy')).toBe(false)
  })

  it('sends what a page and its layouts set in `security` over the site\'s headers, and marks a page asking for full loads', async () => {
    const dir = await scratchDir('page-security-')
    const settings = (page: string) => `--- server\nexport const page = ${page}\n---\n`

    try {
      await Promise.all([
        Bun.write(join(dir, 'index.kay'), 'h1 Home\n'),
        Bun.write(join(dir, 'games/_layout.kay'), `${settings('{ security: { csp: { \'script-src\': [\'https://cdn.example.com\'] } } }')}slot\n`),
        Bun.write(join(dir, 'games/index.kay'), 'h1 Games\n'),
        Bun.write(join(dir, 'games/emulator.kay'), `${settings('{ security: { headers: { \'cross-origin-embedder-policy\': \'require-corp\', \'x-frame-options\': false }, csp: { \'worker-src\': [\'blob:\'], \'frame-src\': [\'https://player.example.com\'], \'object-src\': false } } }')}h1 Emulator\n`),
        Bun.write(join(dir, 'player.kay'), `${settings('{ reload: true }')}h1 Player\n`),
      ])
      const app = await pages({ routes: dir, prebuilt: false, security: { csp: { 'script-src': ['\'self\'', 'https://site.example.com'] } } })
      const get = async (path: string) => app.handle(new Request(`http://localhost${path}`))
      const [home, games, emulator, player] = await Promise.all(['/', '/games', '/games/emulator', '/player'].map(get))
      const policy = directives(emulator!.headers.get('content-security-policy'))

      expect(directives(home!.headers.get('content-security-policy')).get('script-src')).toEqual(['\'self\'', 'https://site.example.com', ...inlineScriptHashes()])
      expect(directives(games!.headers.get('content-security-policy')).get('script-src')).toEqual(['\'self\'', 'https://site.example.com', 'https://cdn.example.com', ...inlineScriptHashes()])
      expect(policy.get('script-src')).toEqual(['\'self\'', 'https://site.example.com', 'https://cdn.example.com', ...inlineScriptHashes()])
      // A directive the policy lacks starts from the one it falls back to: `worker-src` from `script-src`, past `child-src`.
      expect(policy.get('worker-src')).toEqual(['\'self\'', 'https://site.example.com', 'https://cdn.example.com', 'blob:'])
      // `frame-src` falls back to `child-src`, then `default-src`, never to `script-src`.
      expect(policy.get('frame-src')).toEqual([...policy.get('default-src')!, 'https://player.example.com'])
      expect(policy.has('object-src')).toBe(false)
      expect(emulator!.headers.get('cross-origin-embedder-policy')).toBe('require-corp')
      expect(emulator!.headers.get('cross-origin-opener-policy')).toBe('same-origin')
      expect(emulator!.headers.has('x-frame-options')).toBe(false)
      expect(games!.headers.get('x-frame-options')).toBe('SAMEORIGIN')
      expect(games!.headers.has('cross-origin-embedder-policy')).toBe(false)
      expect(player!.headers.get('x-kay-reload')).toBe('1')
      expect(player!.headers.get('content-security-policy')).toBe(home!.headers.get('content-security-policy'))
      expect(home!.headers.has('x-kay-reload')).toBe(false)

      // A site sending no security headers still sends what a page asks for.
      const bare = await (await pages({ routes: dir, prebuilt: false, security: false })).handle(new Request('http://localhost/games/emulator'))

      expect(bare.headers.get('cross-origin-embedder-policy')).toBe('require-corp')
      expect(bare.headers.has('content-security-policy')).toBe(false)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps a header a route sets, on its Response or through set.headers', async () => {
    const app = new Elysia()
      .use(await pages({ routes: ROUTES, prebuilt: false }))
      .get('/api/own', () => new Response('own', { headers: { 'x-frame-options': 'DENY' } }))
      .get('/api/set', ({ set }) => {
        set.headers['content-security-policy'] = 'default-src \'none\''

        return 'set'
      })

    expect((await app.handle(new Request('http://localhost/api/own'))).headers.get('x-frame-options')).toBe('DENY')
    expect((await app.handle(new Request('http://localhost/api/set'))).headers.get('content-security-policy')).toBe('default-src \'none\'')
  })

  it('keeps a header the app set itself, and sends none with security off', async () => {
    const own = new Elysia()
      .onRequest(({ set }) => {
        set.headers['content-security-policy'] = 'default-src *'
      })
      .use(await pages({ routes: ROUTES, prebuilt: false }))
    const off = await pages({ routes: ROUTES, prebuilt: false, security: false })
    const offResponse = await off.handle(new Request('http://localhost/about'))

    expect((await own.handle(new Request('http://localhost/about'))).headers.get('content-security-policy')).toBe('default-src *')
    expect(offResponse.headers.has('content-security-policy')).toBe(false)
    expect(offResponse.headers.has('x-content-type-options')).toBe(false)
  })

  it('sends report directives and a report-only policy beside the enforced one, for kay\'s route or a collector', async () => {
    const own = await pages({ routes: ROUTES, prebuilt: false, base: '/docs', security: { reports: true, reportOnly: { 'style-src': ['\'self\''] } } })
    const response = await own.handle(new Request('http://localhost/about'))
    const enforced = directives(response.headers.get('content-security-policy'))
    const trial = directives(response.headers.get('content-security-policy-report-only'))

    expect(response.headers.get('reporting-endpoints')).toBe('csp="/docs/_kay/csp"')
    expect(enforced.get('style-src')).toEqual(['\'self\'', '\'unsafe-inline\''])
    expect(enforced.get('report-uri')).toEqual(['/docs/_kay/csp'])
    expect(enforced.get('report-to')).toEqual(['csp'])
    expect(trial.get('style-src')).toEqual(['\'self\''])
    expect(trial.get('script-src')).toEqual(['\'self\'', ...inlineScriptHashes({ base: '/docs' })])
    expect(trial.get('report-to')).toEqual(['csp'])

    const collector = await pages({ routes: ROUTES, prebuilt: false, security: { csp: false, reports: 'https://reports.example.com/csp', reportOnly: { 'img-src': ['\'self\''] } } })
    const collected = await collector.handle(new Request('http://localhost/about'))

    expect(collected.headers.get('reporting-endpoints')).toBe('csp="https://reports.example.com/csp"')
    expect(collected.headers.has('content-security-policy')).toBe(false)
    expect(directives(collected.headers.get('content-security-policy-report-only')).get('report-uri')).toEqual(['https://reports.example.com/csp'])
    expect((await collector.handle(new Request('http://localhost/_kay/csp', { method: 'POST', body: '{}' }))).status).toBe(404)
  })

  it('logs each violation a browser reports once, in either format, and hands it to onError', async () => {
    const caught: unknown[] = []
    const app = await pages({ routes: ROUTES, prebuilt: false, security: { reports: true }, proxy: { header: 'x-real-ip' }, onError: error => void caught.push(error) })
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const post = async (body: string, address = '10.0.0.1') => (await app.handle(new Request('http://localhost/_kay/csp', { method: 'POST', headers: { 'content-type': 'application/reports+json', 'x-real-ip': address }, body }))).status
    const batch = JSON.stringify([
      { type: 'csp-violation', url: 'https://site.example/about?token=1', body: { documentURL: 'https://site.example/about?token=1', blockedURL: 'https://evil.example/x.js?q=1', effectiveDirective: 'script-src-elem', disposition: 'enforce', sourceFile: 'https://site.example/_kay/a.js?v=2', lineNumber: 3, columnNumber: 7 } },
      { type: 'deprecation', url: 'https://site.example/about', body: {} },
    ])
    const legacy = JSON.stringify({ 'csp-report': { 'document-uri': 'https://site.example/\nfake line', 'blocked-uri': 'inline', 'violated-directive': 'style-src-attr \'self\'', 'disposition': 'report', 'script-sample': 'color: red' } })

    try {
      expect(await post(batch)).toBe(204)
      expect(await post(batch)).toBe(204)
      expect(await post(legacy)).toBe(204)

      const [script, style] = caught as CspViolation[]

      expect(script).toBeInstanceOf(CspViolation)
      expect(script).toMatchObject({ directive: 'script-src-elem', blocked: 'https://evil.example/x.js', url: 'https://site.example/about', disposition: 'enforce', source: 'https://site.example/_kay/a.js:3:7' })
      expect(script!.message).toBe('script-src-elem blocked https://evil.example/x.js on https://site.example/about')
      expect(style).toMatchObject({ directive: 'style-src-attr', blocked: 'inline', url: 'https://site.example/ fake line', disposition: 'report', sample: 'color: red' })
      expect(style!.message).toEndWith('(report only)')
      expect(logged).toHaveBeenCalledTimes(2)

      // The report-only policy's copy of a violation the enforced one logged is logged too.
      expect(await post(batch.replace('"disposition":"enforce"', '"disposition":"report"'))).toBe(204)
      expect(caught).toHaveLength(3)
      expect((caught[2] as CspViolation).disposition).toBe('report')

      expect(await post('not json')).toBe(400)
      expect(await post('{"csp-report":{}}')).toBe(400)
      expect(await post('x'.repeat(65 * 1024))).toBe(413)

      const statuses = []

      for (let i = 0; i < 31; i++)
        statuses.push(await post('[]', '10.0.0.2'))

      expect(statuses.at(-2)).toBe(204)
      expect(statuses.at(-1)).toBe(429)
    }
    finally {
      logged.mockRestore()
    }
  })
})

describe('action protection', () => {
  const FIXTURE = 'tests/fixtures/production'
  // Held in a variable so tsc leaves the .kay import to Bun.
  const CONTACT = './fixtures/production/src/routes/contact.kay'
  const ENQUIRY = './fixtures/production/src/routes/enquiry.kay'
  const QUOTE = './fixtures/production/src/routes/quote.kay'

  it('leaves Elysia parsing no cookie, query or header on a page, action or API route that reads none', async () => {
    const app = await pages({ routes: `${FIXTURE}/src/routes`, api: `${FIXTURE}/src/api`, prebuilt: false, security: false })

    expect(routePaths(app)).toEqual(expect.arrayContaining(['/contact', expect.stringMatching(/^\/_kay\/action\//), expect.stringMatching(/^\/api\//)]))
    expect(parsingRoutes(app)).toEqual([])
  })

  it('refuses a form whose honeypot is filled in, with a message on the field, the handler never running', async () => {
    const site = await testSite({ routes: `${FIXTURE}/src/routes`, security: false })
    const { send } = await import(CONTACT) as { send: Action<{ message: string }, number, 'website'> }
    const trapped = await site.submit(send, { message: 'hello', website: 'https://spam.example' }, { from: '/contact' })
    const human = await site.submit(send, { message: 'hello', website: '' }, { from: '/contact' })

    expect(trapped.html).toContain('<p class="error">422 Leave this field empty</p>')
    expect(human.html).toContain('<p class="sent">Sent 5</p>')

    // Repeated, or a file, it is filled in all the same.
    for (const website of [['', 'https://spam.example'], new File(['x'], 'x.txt')])
      expect((await refusalOf(send as never, new Request('http://localhost/'), { website }, true, null))?.status).toBe(422)

    expect(await refusalOf(send as never, new Request('http://localhost/'), { website: [''] }, true, null)).toBeUndefined()
  })

  it('renders the honeypot field in a form posting to the action, out of sight, and leaves it to an island\'s template', async () => {
    const site = await testSite({ routes: `${FIXTURE}/src/routes`, security: false })
    const page = await site.visit('/contact')

    expect(page.html).toContain('enctype="multipart/form-data"><div style="position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden" aria-hidden="true" inert><input name="website" type="text" tabindex="-1" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore></div><input name="message"')
    expect(page.html.match(/name="website"/g)).toHaveLength(1)
    expect((await site.visit('/enquiry')).html).toContain('<input name="nectar" type="text" tabindex="-1" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore>')

    const form = 'form(action={send})\n  input(name="message" aria-label="Message")\n'

    expect(compileKay(form, 'page.kay', { output: 'html' }).tsx).toContain('KayFormProtection((send))')
    expect(compileKay('form(action={send} {...rest})\n  input(name="message" aria-label="Message")\n', 'page.kay', { output: 'html' }).tsx).toContain('() => KayFormProtection((send)) + (')
    expect(compileKay(form, 'page.kay', { output: 'html', hydratable: true, twinBuild: true }).tsx).not.toContain('KayFormProtection((send))')
  })

  it('counts only the posts that went through on a limit saying so, every attempt still counting on the others', async () => {
    const app = await pages({ routes: `${FIXTURE}/src/routes`, prebuilt: false, proxy: { hops: 1 } })
    const { enquire } = await import(ENQUIRY) as { enquire: Action<{ message: string }, number> }
    const call = async (from: string, message: string) => app.handle(new Request(`http://localhost${enquire.url}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kay-action': '1', 'x-forwarded-for': from }, body: stringify({ message }) }))

    // A mail server failing three times locks no one out.
    for (let attempt = 0; attempt < 3; attempt++)
      expect((await call('203.0.113.20', 'fail')).status).toBe(502)

    expect((await call('203.0.113.20', 'hi')).status).toBe(200)
    // The fifth attempt passes the limit on every attempt.
    expect((await call('203.0.113.20', 'fail')).status).toBe(429)

    expect((await call('203.0.113.21', 'hi')).status).toBe(200)

    const limited = await call('203.0.113.21', 'hi')

    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)

    // A handler throwing has not gone through; one sending the visitor on has.
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      expect((await call('203.0.113.22', 'throw')).status).toBe(500)
      expect((await call('203.0.113.22', 'throw')).status).toBe(500)
    }
    finally {
      logged.mockRestore()
    }

    expect((await call('203.0.113.22', 'away')).status).toBe(303)
    expect((await call('203.0.113.22', 'hi')).status).toBe(429)
  })

  it('counts an attempt on every limit, whichever refuses it', async () => {
    const every = memoryRates()
    const action = { url: '/_kay/action/both', protection: { rateLimit: [{ max: 1, window: '1m', count: 'succeeded' }, { max: 5, window: '1m', store: every }] } } as never
    const request = () => new Request('http://localhost/')

    await countSucceeded(action, request(), null)
    expect((await refusalOf(action, request(), {}, false, null))?.status).toBe(429)
    expect((await refusalOf(action, request(), {}, false, null))?.status).toBe(429)
    expect(every.peek('/_kay/action/both#1\nunknown')?.count).toBe(2)
  })

  it('puts a message ctx.fail is given where a form reads its own message', async () => {
    const app = await pages({ routes: `${FIXTURE}/src/routes`, prebuilt: false, proxy: { hops: 1 } })
    const site = await testSite({ routes: `${FIXTURE}/src/routes`, security: false })
    const { enquire } = await import(ENQUIRY) as { enquire: Action<{ message: string }, number> }
    const failed = await app.handle(new Request(`http://localhost${enquire.url}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kay-action': '1', 'x-forwarded-for': '203.0.113.30' }, body: stringify({ message: 'fail' }) }))

    expect(parse(await failed.text())).toEqual({ errors: { '': 'Not sent; try again later' }, data: 'Not sent; try again later' })
    expect((await site.submit(enquire, { message: 'fail' }, { from: '/enquiry' })).html).toContain('<p id="enquire-error" class="error">Not sent; try again later</p>')
  })

  it('answers a bot the honeypot caught as if its post went through, when the action says so', async () => {
    const app = await pages({ routes: `${FIXTURE}/src/routes`, prebuilt: false, proxy: { hops: 1 } })
    const site = await testSite({ routes: `${FIXTURE}/src/routes`, security: false })
    const { enquire } = await import(ENQUIRY) as { enquire: Action<{ message: string }, number, 'nectar'> }
    const form = new FormData()

    form.set('message', 'fail')
    form.set('nectar', 'https://spam.example')

    const call = await app.handle(new Request(`http://localhost${enquire.url}`, { method: 'POST', headers: { 'x-kay-action': 'form', 'x-forwarded-for': '203.0.113.40' }, body: form }))

    // The handler would have failed a message saying "fail".
    expect(call.status).toBe(200)
    expect(await call.text()).toBe('')
    expect((await site.submit(enquire, { message: 'fail', nectar: 'https://spam.example' }, { from: '/enquiry' })).html).toContain('<p class="sent">Sent</p>')
  })

  it('refuses a form posted sooner than `minTime` after its page rendered, then lets it through from the page that refused it once the time has passed', async () => {
    const site = await testSite({ routes: `${FIXTURE}/src/routes`, security: false })
    const { ask } = await import(QUOTE) as { ask: Action<{ message: string }, number> }
    const start = Date.now()

    try {
      setSystemTime(start)

      const page = await site.visit('/quote')
      const stamp = page.find(`form[action^="${ask.url}"] input[name="kay_since"]`)[0]?.attributes.value

      expect(page.html).toContain(`<input type="hidden" name="kay_since" value="${stamp}"><input name="message"`)

      setSystemTime(start + 1000)

      // The page's own stamp, which testSite would otherwise date back far enough to go through.
      const early = await site.submit(ask, { message: 'hello', kay_since: stamp }, { from: page })

      expect(early.html).toContain('<p class="error">422 Sent too fast; take a moment, then send it again</p>')
      // The refused page keeps the time the form first rendered at, so the visitor does not wait again from zero.
      expect(early.find(`form[action^="${ask.url}"] input[name="kay_since"]`)[0]?.attributes.value).toBe(stamp)

      setSystemTime(start + 3000)
      expect((await site.submit(ask, { message: 'hello' }, { from: early })).html).toContain('<p class="asked">Asked 5</p>')
    }
    finally {
      setSystemTime()
    }
  })

  it('refuses a plain post sent too soon, or as expired one whose stamp is missing, forged, another action\'s or too old, in the site\'s words when it has its own, and lets a call from kay\'s script through without one', async () => {
    const site = await testSite({ routes: `${FIXTURE}/src/routes`, security: false })
    const { ask, quick } = await import(QUOTE) as { ask: Action<{ message: string }, number>, quick: Action<{ message: string }, number> }
    const start = Date.now()
    const refusal = async (fields: Record<string, unknown>, plain = true) => (await refusalOf(ask as never, new Request('http://localhost/'), fields, true, null, plain))?.message

    try {
      setSystemTime(start - 86_400_000 - 1000)

      const yesterday = await site.visit('/quote')
      const stale = yesterday.find(`form[action^="${ask.url}"] input[name="kay_since"]`)[0]!.attributes.value

      setSystemTime(start - 5000)

      const page = await site.visit('/quote')
      const own = page.find(`form[action^="${ask.url}"] input[name="kay_since"]`)[0]!.attributes.value!
      const other = page.find(`form[action="${quick.url}"] input[name="kay_since"]`)[0]!.attributes.value

      setSystemTime(start)
      expect(await refusal({ message: 'hi', kay_since: own })).toBeUndefined()

      for (const kay_since of [undefined, `${(start - 5000).toString(36)}.forged`, `${(start - 9000).toString(36)}.${own.slice(own.indexOf('.') + 1)}`, other])
        expect(await refusal({ message: 'hi', kay_since })).toBe('This form has expired; send it again')

      expect(await refusal({ message: 'hi', kay_since: stale })).toBe('This form has expired; send it again')
      expect(await refusal({ message: 'hi', kay_since: signStamp(ask.url, start - 1000) })).toBe('Sent too fast; take a moment, then send it again')

      const worded = { url: '/_kay/action/worded', protection: { minTime: '3s', messages: { minTime: (reason: string) => `${reason}!` } } } as never

      expect((await refusalOf(worded, new Request('http://localhost/'), { kay_since: signStamp('/_kay/action/worded', start - 1000) }, true, null))?.message).toBe('early!')
      expect((await refusalOf(worded, new Request('http://localhost/'), {}, true, null))?.message).toBe('expired!')
      // A test posting with no page, or right after it, goes through unless it says how long the form was open.
      expect((await site.submit(ask, { message: 'hello' }, { from: '/quote' })).html).toContain('<p class="asked">Asked 5</p>')
      expect((await site.submit(ask, { message: 'hello' }, { from: await site.visit('/quote') })).html).toContain('<p class="asked">Asked 5</p>')
      // A page older than `maxAge` is still too old.
      expect((await site.submit(ask, { message: 'hello' }, { from: yesterday })).html).toContain('<p class="error">422 This form has expired; send it again</p>')
      // A stamp given to it wins over the page's.
      expect((await site.submit(ask, { message: 'hello', kay_since: 'forged' }, { from: page })).html).toContain('<p class="error">422 This form has expired; send it again</p>')
      expect((await site.submit(ask, { message: 'hello' }, { from: '/quote', openedFor: '5s' })).html).toContain('<p class="asked">Asked 5</p>')
      expect((await site.submit(ask, { message: 'hello' }, { from: page, openedFor: 0 })).html).toContain('<p class="error">422 Sent too fast; take a moment, then send it again</p>')
      expect((await site.submit(ask, { message: 'hello' }, { from: page, openedFor: '2d' })).html).toContain('<p class="error">422 This form has expired; send it again</p>')

      // An island's form renders no stamp; one it sends is still checked.
      expect(await refusal({ message: 'hi' }, false)).toBeUndefined()
      expect(await refusal({ message: 'hi', kay_since: 'forged' }, false)).toBe('This form has expired; send it again')
      expect(await site.call(ask, { message: 'hello' })).toBe(5)
    }
    finally {
      setSystemTime()
    }
  })

  it('answers a post sent too soon as if it went through, when `minTime` says so', async () => {
    const site = await testSite({ routes: `${FIXTURE}/src/routes`, security: false })
    const { quick } = await import(QUOTE) as { quick: Action<{ message: string }, number> }
    const page = await site.visit('/quote')

    // The handler would have answered the message's length.
    expect((await site.submit(quick, { message: 'hello' }, { from: page, openedFor: 0 })).html).toContain('<p class="sent">Sent </p>')
  })

  it('checks only a post the browser sends itself with `plain`, not the page swap\'s nor a call, a stamp they send included', async () => {
    const action = { url: '/_kay/action/plain', protection: { minTime: { after: '3s', plain: true } } } as never
    const early = { kay_since: signStamp('/_kay/action/plain', Date.now() - 1000) }
    const refusal = async (headers: Record<string, string>, plain: boolean) => (await refusalOf(action, new Request('http://localhost/', { headers }), early, true, null, plain))?.message

    expect(await refusal({}, true)).toBe('Sent too fast; take a moment, then send it again')
    expect(await refusal({ 'x-kay-navigate': '1' }, true)).toBeUndefined()
    expect(await refusal({}, false)).toBeUndefined()
  })

  it('signs the stamps with a key derived from the session\'s secret over the preview one, which replaces only the key of the process', async () => {
    const script = `import { createHmac } from 'node:crypto'
import { signStamp, signText, stampTime, useStampSecret } from ${JSON.stringify(join(import.meta.dir, '../src/server/stamp.ts'))}
const seen = []
const stamp = signStamp('/_kay/action/a', 1000)
seen.push(stampTime('/_kay/action/a', stamp), stampTime('/_kay/action/b', stamp) ?? null)
useStampSecret('the preview secret, long enough', 'preview')
const preview = signStamp('/_kay/action/a', 1000)
seen.push(stampTime('/_kay/action/a', stamp) ?? null, signText('link', '/news') === createHmac('sha256', 'the preview secret, long enough').update('link\\0/news').digest('base64url'))
useStampSecret('a session secret, long enough too', 'session')
const session = signStamp('/_kay/action/a', 1000)
seen.push(stampTime('/_kay/action/a', preview) ?? null)
useStampSecret('the preview secret, long enough', 'preview')
seen.push(stampTime('/_kay/action/a', session))
console.log(JSON.stringify(seen))
`

    expect(await isolated(script)).toEqual([1000, null, null, false, null, 1000])
  })

  it('warns a server started with no NODE_ENV, as Elysia then answers with the schema a request failed', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
    const env = process.env.NODE_ENV ?? 'test'

    delete process.env.NODE_ENV

    try {
      await pages({ routes: ROUTES, prebuilt: false })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('NODE_ENV is unset'))
    }
    finally {
      process.env.NODE_ENV = env
      warn.mockRestore()
    }
  })

  it('warns once, on a production server, when it signs with the key of the process alone', async () => {
    const warned = async (secret: string) => {
      const script = `import { setLogSink } from ${JSON.stringify(join(import.meta.dir, '../src/runtime/log.ts'))}
import { signStamp, useStampSecret, warnOnStampKey } from ${JSON.stringify(join(import.meta.dir, '../src/server/stamp.ts'))}
const warnings = []
setLogSink((level, message) => warnings.push(level + ' ' + message))
warnOnStampKey(true)
${secret}
signStamp('/_kay/action/a', 1000)
signStamp('/_kay/action/a', 2000)
console.log(JSON.stringify(warnings))
`

      return await isolated(script) as string[]
    }

    const alone = await warned('')

    expect(alone).toHaveLength(1)
    expect(alone[0]).toStartWith('warn links to private files, form stamps and the flash cookie are signed with a key of this process')
    expect(await warned('useStampSecret("the preview secret, long enough", "preview")')).toEqual([])
  })

  it('lets a client post as often as the limit allows in a window, then answers 429 with when to retry', async () => {
    const app = await pages({ routes: `${FIXTURE}/src/routes`, prebuilt: false, proxy: { hops: 1 } })
    const { send } = await import(CONTACT) as { send: Action<{ message: string }, number> }
    const call = async (from: string) => app.handle(new Request(`http://localhost${send.url}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kay-action': '1', 'x-forwarded-for': from }, body: stringify({ message: 'hi' }) }))

    expect((await call('203.0.113.7')).status).toBe(200)
    expect((await call('203.0.113.7')).status).toBe(200)

    const limited = await call('203.0.113.7')

    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(Number(limited.headers.get('retry-after'))).toBeLessThanOrEqual(60)
    expect(parse(await limited.text())).toEqual({ errors: { '': expect.stringMatching(/^Too many attempts; try again in \d+ s$/) }, data: undefined })
    expect((await call('198.51.100.2')).status).toBe(200)
  })

  it('takes a post from the site kay.config.ts names as its own, for a proxy that does not pass the browser\'s Host on', async () => {
    const app = await pages({ routes: `${FIXTURE}/src/routes`, prebuilt: false, site: 'https://shop.example', proxy: { hops: 1 } })
    const { send } = await import(CONTACT) as { send: Action<{ message: string }, number> }
    const call = async (origin: string) => app.handle(new Request(`http://127.0.0.1:3000${send.url}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kay-action': '1', 'x-forwarded-for': '203.0.113.60', origin }, body: stringify({ message: 'hi' }) }))

    expect((await call('https://shop.example')).status).toBe(200)
    expect((await call('https://evil.example')).status).toBe(403)
  })

  it('refuses in the messages the action gives, in place of kay\'s English', async () => {
    const app = await pages({ routes: `${FIXTURE}/src/routes`, prebuilt: false, proxy: { hops: 1 } })
    const { write } = await import(CONTACT) as { write: Action<{ message: string }, number, 'website'> }
    const call = async (message: string) => {
      const body = stringify({ message })

      return app.handle(new Request(`http://localhost${write.url}`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), 'x-kay-action': '1', 'x-forwarded-for': '203.0.113.8' }, body }))
    }

    expect((await refusalOf(write as never, new Request('http://localhost/'), { website: 'https://spam.example' }, true, null))?.message).toBe('Laissez ce champ vide')
    expect(parse(await (await call('a'.repeat(1100))).text())).toEqual({ errors: { '': '1024 octets au plus' }, data: undefined })
    expect((await call('hi')).status).toBe(200)

    const limited = await call('hi')

    expect(limited.status).toBe(429)
    expect(parse(await limited.text())).toEqual({ errors: { '': `Réessayez dans ${limited.headers.get('retry-after')} s` }, data: undefined })
  })

  it('limits a guard or an API route by name as an action is limited, names counting apart', async () => {
    const signIn = rateLimit('sign-in', { max: 2, window: '1m' })
    const search = rateLimit('search', { max: 2, window: '1m' })
    const request = () => new Request('http://localhost/login')

    expect(await signIn.hit(request())).toBeUndefined()
    expect(await signIn.hit(request())).toBeUndefined()
    expect(await signIn.hit(request())).toBeGreaterThan(0)
    expect(await search.hit(request())).toBeUndefined()
    // Under the app's own key, such as an account, whoever sends the request.
    expect(await search.hit('account-1')).toBeUndefined()
    expect(await search.hit('account-1')).toBeUndefined()
    expect(await search.hit('account-1')).toBeGreaterThan(0)
    expect(await search.hit('account-2')).toBeUndefined()
    expect(() => rateLimit('x', { max: 0, window: '1m' })).toThrow('max is 0')
    expect(() => rateLimit('x', { max: 1, window: 'soon' as never })).toThrow('window')
  })

  it('counts every process sharing a SQLite store together, for an action and a named limit alike', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-rates-'))

    try {
      const path = join(dir, 'rates.sqlite')
      // Two processes, each with its own connection to the file.
      const [first, second] = [sqliteRates(path), sqliteRates(path)]
      const request = () => new Request('http://localhost/')
      const limited = (store: typeof first) => ({ url: '/_kay/action/contact/send', protection: { rateLimit: { max: 2, window: '1m', store } } }) as never

      expect(await refusalOf(limited(first), request(), {}, false, null)).toBeUndefined()
      expect(await refusalOf(limited(second), request(), {}, false, null)).toBeUndefined()
      expect((await refusalOf(limited(first), request(), {}, false, null))?.status).toBe(429)

      const succeeded = (store: typeof first) => ({ url: '/_kay/action/contact/write', protection: { rateLimit: { max: 1, window: '1m', store, count: 'succeeded' } } }) as never

      expect(await refusalOf(succeeded(first), request(), {}, false, null)).toBeUndefined()
      await countSucceeded(succeeded(first), request(), null)
      expect((await refusalOf(succeeded(second), request(), {}, false, null))?.status).toBe(429)

      expect(await rateLimit('login', { max: 1, window: '1m', store: first }).hit(request())).toBeUndefined()
      expect(await rateLimit('login', { max: 1, window: '1m', store: second }).hit(request())).toBeGreaterThan(0)

      // A window that closed opens afresh.
      setSystemTime(Date.now() + 61_000)
      expect(await rateLimit('login', { max: 1, window: '1m', store: second }).hit(request())).toBeUndefined()

      // The file keeps no key as given, and only the server's user reads it.
      await rateLimit('reset', { max: 1, window: '1m', store: first }).hit('ada@example.com')
      const db = new Database(path, { readonly: true })

      const keys = db.query<{ key: string }, []>('SELECT key FROM kay_rates').all().map(row => row.key)

      expect([keys.length > 0, keys.filter(key => !HASHED_KEY.test(key))]).toEqual([true, []])
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      db.close()
    }
    finally {
      setSystemTime()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keys the hash of a stored rate key with the session\'s secret once one is set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-rates-'))
    const script = `import { Database } from 'bun:sqlite'
import { sqliteRates } from ${JSON.stringify(join(import.meta.dir, '../src/server/protection.ts'))}
import { useStampSecret } from ${JSON.stringify(join(import.meta.dir, '../src/server/stamp.ts'))}
const path = ${JSON.stringify(join(dir, 'rates.sqlite'))}
const store = sqliteRates(path)
store.hit('before', 60_000)
useStampSecret('a session secret, long enough too', 'session')
store.hit('after', 60_000)
const db = new Database(path)
const salt = db.query('SELECT salt FROM kay_rates_salt').get().salt
const plain = key => new Bun.CryptoHasher('sha256').update(salt).update(key).digest('base64url')
const keys = new Set(db.query('SELECT key FROM kay_rates').all().map(row => row.key))
console.log(JSON.stringify([keys.has(plain('before')), keys.has(plain('after')), keys.size]))
`

    try {
      expect(await isolated(script)).toEqual([true, false, 2])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses a rate limit window it cannot read as the action is declared', () => {
    expect(() => action(t.Object({}), () => 1, { rateLimit: { max: 1, window: 'soon' as never } })).toThrow('kay: rateLimit.window is \'soon\'; it takes a positive duration')
    expect(() => action(t.Object({}), () => 1, { rateLimit: [{ max: 1, window: '1m' }, { max: 1, window: '1m', count: 'succeeded', store: { hit: () => ({ count: 1, resetAt: 0 }) } }] })).toThrow('needs a peek(key) method')
  })

  it('counts an IPv6 client by its /64, so rotating addresses inside it buys nothing', () => {
    expect(rateKey('2001:db8:0:1:aaaa::1')).toBe('2001:db8:0:1::/64')
    expect(rateKey('2001:0db8:0000:0001:ffff:ffff:ffff:ffff')).toBe('2001:db8:0:1::/64')
    expect(rateKey('203.0.113.7')).toBe('203.0.113.7')
    expect(rateKey('::ffff:203.0.113.7')).toBe('::ffff:203.0.113.7')
  })

  it('takes the address the trusted proxies passed on, never one the client wrote before them', () => {
    const behind = new Request('http://localhost/', { headers: { 'x-forwarded-for': '1.1.1.1, 203.0.113.7, 172.70.1.1', 'cf-connecting-ip': '203.0.113.7' } })
    const skipped = new Request('http://localhost/', { headers: { 'x-forwarded-for': '203.0.113.8' } })

    expect(clientAddress(behind, socket('127.0.0.1'), { hops: 1 })).toBe('172.70.1.1')
    expect(clientAddress(behind, socket('::ffff:172.18.0.1'), { hops: 2 })).toBe('203.0.113.7')
    expect(clientAddress(behind, socket('100.101.1.1'), { header: 'cf-connecting-ip' })).toBe('203.0.113.7')
    // A request that skipped the outer proxy carries what the inner one appended, who reached it.
    expect(clientAddress(skipped, socket('10.0.0.2'), { hops: 2 })).toBe('203.0.113.8')
    // A client reaching the server itself forges nothing, whatever the setting.
    expect(clientAddress(behind, socket('198.51.100.9'), { hops: 2 })).toBe('198.51.100.9')
  })

  it('trusts a CDN reaching the server from the public ranges proxy.trusted lists, warning once when a header arrives from a public peer outside them', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
    const proxy = { header: 'cf-connecting-ip', trusted: ['173.245.48.0/20', '2400:cb00::/32', '198.51.100.1'] }
    const behind = new Request('http://localhost/', { headers: { 'cf-connecting-ip': '203.0.113.7' } })

    try {
      expect(clientAddress(behind, socket('173.245.50.1'), proxy)).toBe('203.0.113.7')
      expect(clientAddress(behind, socket('::ffff:173.245.50.1'), proxy)).toBe('203.0.113.7')
      expect(clientAddress(behind, socket('2400:cb00:2049::1'), proxy)).toBe('203.0.113.7')
      expect(clientAddress(behind, socket('198.51.100.1'), proxy)).toBe('203.0.113.7')
      expect(clientAddress(behind, socket('10.0.0.2'), proxy)).toBe('203.0.113.7')
      expect(warn).not.toHaveBeenCalled()
      expect(clientAddress(behind, socket('198.51.100.9'), proxy)).toBe('198.51.100.9')
      expect(clientAddress(behind, socket('198.51.100.10'), proxy)).toBe('198.51.100.10')
      expect(clientAddress(new Request('http://localhost/'), socket('198.51.100.11'), proxy)).toBe('198.51.100.11')
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]![0])).toContain('proxy.trusted')
    }
    finally {
      warn.mockRestore()
    }
  })

  it('counts the socket as the client without a proxy setting, warning once when requests come through one', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
    const forged = new Request('http://localhost/', { headers: { 'x-forwarded-for': '203.0.113.7' } })

    try {
      expect(clientAddress(forged, socket('198.51.100.9'))).toBe('198.51.100.9')
      expect(warn).not.toHaveBeenCalled()
      expect(clientAddress(forged, socket('192.168.1.20'))).toBe('192.168.1.20')
      expect(clientAddress(forged, socket('192.168.1.21'))).toBe('192.168.1.21')
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]![0])).toContain('proxy: { hops: 1 }')
    }
    finally {
      warn.mockRestore()
    }
  })

  it('reads the proxy setting pages() is given for every request it serves, an app route included', async () => {
    const whoami = async (proxy?: { hops: number }) => {
      const app = new Elysia().use(await pages({ routes: `${FIXTURE}/src/routes`, prebuilt: false, proxy })).get('/whoami', ({ request, server }) => clientAddress(request, server))

      return (await app.handle(new Request('http://localhost/whoami', { headers: { 'x-forwarded-for': '203.0.113.7' } }))).text()
    }

    expect(await whoami({ hops: 1 })).toBe('203.0.113.7')
    expect(await whoami()).toBe('unknown')
  })

  it('refuses a proxy setting it cannot read, as the server boots', async () => {
    for (const proxy of [{}, { hops: 1, header: 'x-real-ip' }, { hops: 0 }, { hops: 1.5 }, { header: ' ' }, { hops: 1, trusted: ['a CDN'] }, { hops: 1, trusted: ['10.0.0.0/33'] }, { hops: 1, trusted: ['::/129'] }])
      await expect(pages({ routes: `${FIXTURE}/src/routes`, prebuilt: false, proxy })).rejects.toThrow('kay: proxy')
  })

  it('types the honeypot as one of the form\'s fields for kay check, a misspelt one still refused', async () => {
    const copy = await fixtureCopy('production')
    const typo = join(copy, 'src/routes/typo.kay')

    try {
      expect(await check(copy)).toEqual([])

      await Bun.write(typo, '---\nimport { send } from \'./contact.kay\'\nimport { enquire } from \'./enquiry.kay\'\n---\nform(action={send})\n  input(name="websit" aria-label="Website")\nform(action={enquire})\n  input(name="nectar" aria-label="Nectar")\n')

      expect((await check(copy)).map(diagnostic => diagnostic.line)).toEqual([6])
    }
    finally {
      await rm(copy, { recursive: true, force: true })
    }
  })
})

describe('API routes', () => {
  it('answer a bigint as JSON, written as its digits, keeping the status and headers the route set', async () => {
    const app = await pages({ routes: 'tests/fixtures/production/src/routes', api: 'tests/fixtures/production/src/api', prebuilt: false })
    const ledger = await app.handle(new Request('http://localhost/api/ledger'))
    const created = await app.handle(new Request('http://localhost/api/ledger/created'))

    expect(ledger.headers.get('content-type')).toStartWith('application/json')
    expect(await ledger.text()).toBe('{"id":"9007199254740993","entries":["1",{"amount":"2"}]}')
    expect(created.status).toBe(201)
    expect(created.headers.get('x-ledger')).toBe('kept')
    expect(await created.json()).toEqual(['3'])
  })

  it('answer 500 to a class instance or a Map, a status() body included, logging the route and what it answered, where Elysia would send [object Object]', async () => {
    const copy = await fixtureCopy('production')
    const entries: LogEntry[] = []

    try {
      await Bun.write(join(copy, 'src/api/rows.ts'), `import { api } from 'kay/server'

class Row {
  id = 1n
}

export default api()
  .get('/', () => new Row())
  .get('/map', () => new Map([['a', 1]]))
  .get('/blob', () => new Blob(['raw']))
  .get('/nested', () => ({ at: new Row() }))
  .get('/teapot', ({ status }) => status(418, new Row()))
  .get('/date', () => new Date(0))
  .get('/response', () => new Response('made'))
  .get('/generator', function* () {
    yield 'a'
    yield 'b'
  })
  .get('/bytes', () => new Uint8Array([104, 105]))
  .get('/shared', () => new SharedArrayBuffer(2))
  .get('/bare', () => Object.assign(Object.create(null) as object, { a: 1 }))
  .get('/status', ({ status }) => status(201, { ok: true }))
  .get('/redirect', ({ redirect }) => redirect('/elsewhere'))
`)

      const app = await pages({ routes: join(copy, 'src/routes'), api: join(copy, 'src/api'), prebuilt: false, log: entry => entries.push(entry) })
      const answer = async (path: string) => app.handle(new Request(`http://localhost/api/rows${path}`))
      const row = await answer('')

      expect([row.status, await row.text()]).toEqual([500, 'Internal Server Error'])
      expect((await answer('/map')).status).toBe(500)
      expect((await answer('/teapot')).status).toBe(500)
      expect(entries.map(entry => [entry.level, 'request' in entry && entry.request?.path, 'error' in entry && entry.error?.message])).toEqual([
        ['error', '/api/rows', expect.stringContaining('answered a Row')],
        ['error', '/api/rows/map', expect.stringContaining('answered a Map')],
        ['error', '/api/rows/teapot', expect.stringContaining('answered a Row')],
      ])
      expect(await (await answer('/blob')).text()).toBe('raw')
      expect(await (await answer('/nested')).json()).toEqual({ at: { id: '1' } })
      expect(await (await answer('/date')).text()).toBe(String(new Date(0)))
      expect(await (await answer('/response')).text()).toBe('made')
      expect(await (await answer('/generator')).text()).toBe('ab')
      expect(await (await answer('/bytes')).text()).toBe('hi')
      expect((await (await answer('/shared')).arrayBuffer()).byteLength).toBe(2)
      expect(await (await answer('/bare')).json()).toEqual({ a: 1 })

      const status = await answer('/status')

      expect([status.status, await status.json()]).toEqual([201, { ok: true }])

      const redirect = await answer('/redirect')

      expect([redirect.status, redirect.headers.get('location')]).toEqual([302, '/elsewhere'])
    }
    finally {
      await rm(copy, { recursive: true, force: true })
    }
  })
})

describe('SQLite stores', () => {
  it('create the directory of their file, as data/ is missing on a fresh checkout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-stores-'))

    try {
      sqliteRates(join(dir, 'rates/rates.sqlite'))
      sqliteStore(join(dir, 'sessions/sessions.sqlite'))
      sqliteCache(join(dir, 'cache/cache.sqlite'))
      // The job store opens its file on the first write, so a server whose queue never gets a job writes nothing.
      await sqliteJobs(join(dir, 'jobs/jobs.sqlite')).lock('report', 0)

      for (const name of ['rates', 'sessions', 'cache', 'jobs'])
        expect(await Bun.file(join(dir, name, `${name}.sqlite`)).exists()).toBe(true)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('request body limits', () => {
  const FIXTURE = 'tests/fixtures/production'
  // Held in a variable so tsc leaves the .kay import to Bun.
  const NOTES = './fixtures/production/src/routes/notes.kay'
  const MB = 1024 * 1024
  const serve = async (bodyLimit?: number) => pages({ routes: `${FIXTURE}/src/routes`, api: `${FIXTURE}/src/api`, prebuilt: false, bodyLimit })
  // Sent in chunks, with no Content-Length to go by.
  const chunked = (size: number) => new ReadableStream<Uint8Array>({
    start(controller) {
      for (let sent = 0; sent < size; sent += 64 * 1024)
        controller.enqueue(new Uint8Array(Math.min(64 * 1024, size - sent)).fill(97))

      controller.close()
    },
  })

  it('answers an island\'s call sending over 1 MB with 413 and a form-wide error, the handler never running', async () => {
    const app = await serve()
    const { note } = await import(NOTES) as { note: Action<{ text: string }, number> }
    const call = async (text: string, slash = '') => {
      const body = stringify({ text })

      return app.handle(new Request(`http://localhost${note.url}${slash}`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), 'x-kay-action': '1' }, body }))
    }

    const refused = await call('a'.repeat(MB))

    expect(refused.status).toBe(413)
    expect(parse(await refused.text())).toEqual({ errors: { '': 'Too large to send; 1 MB at most' }, data: undefined })
    // Elysia serves the path with a trailing slash as the same route.
    expect((await call('a'.repeat(MB), '/')).status).toBe(413)
    expect(await (await call('a'.repeat(MB - 100))).text()).toBe(stringify(MB - 100))
  })

  it('sends a plain form post over the limit back to its page with the error, counting a body sent without Content-Length', async () => {
    const site = await testSite({ routes: `${FIXTURE}/src/routes`, security: false, bodyLimit: 64 * 1024 })
    const { note } = await import(NOTES) as { note: Action<{ text: string }, number> }

    expect((await site.submit(note, { text: 'a'.repeat(65 * 1024) }, { from: '/notes' })).html).toContain('<p class="error">413 Too large to send; 64 KB at most</p>')
    expect((await site.submit(note, { text: 'hello' }, { from: '/notes' })).html).toContain('<p class="sent">Sent 5</p>')
  })

  it('lets an action or an API module raise the limit for itself', async () => {
    const app = await serve()
    const { attach } = await import(NOTES) as { attach: Action<{ text: string }, number> }
    const text = 'a'.repeat(2 * MB)
    const body = stringify({ text })

    const attached = await app.handle(new Request(`http://localhost${attach.url}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kay-action': '1' }, body }))
    const uploaded = await app.handle(new Request('http://localhost/api/uploads', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: text }))
    const echoed = await app.handle(new Request('http://localhost/api/echo', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: text }))

    expect(await attached.text()).toBe(stringify(2 * MB))
    expect(await uploaded.text()).toBe(String(2 * MB))
    expect(echoed.status).toBe(413)
    expect(await echoed.text()).toBe('Request body too large')
  })

  it('refuses a chunked body as soon as it passes the limit, and leaves a smaller one whole for the route', async () => {
    const app = await serve(MB)
    const post = async (size: number) => app.handle(new Request('http://localhost/api/echo', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: chunked(size) }))

    expect((await post(2 * MB)).status).toBe(413)
    expect(await (await post(MB)).text()).toBe(String(MB))
  })

  it('refuses a limit it cannot read, as the server boots', async () => {
    for (const bodyLimit of [0, -1, 1.5])
      await expect(serve(bodyLimit)).rejects.toThrow('kay: bodyLimit')
  })
})

describe('revalidation', () => {
  const routes = 'tests/fixtures/production/src/routes'
  // Held in a variable so tsc leaves the .kay import to Bun.
  const NEWS = './fixtures/production/src/routes/news.kay'
  const root = process.cwd()
  const build = prerendered({ routes })

  it('invalidates the prerendered pages of the apps still running, an app stopped letting go of its own', async () => {
    const { news } = await import('./fixtures/production/src/news')

    try {
      const stopped = await build.serve({ routes, prebuilt: true, security: false, log: false })
      const running = await build.serve({ routes, prebuilt: true, security: false, log: false })
      const edition = async (app: typeof running) => (await (await app.handle(new Request('http://localhost/news'))).text()).match(/<h1>(Edition \d)<\/h1>/)?.[1]

      stopped.listen(0)
      await shutdown(stopped)
      news.edition = 2
      invalidatePage('/news')

      expect(await edition(running)).toBe('Edition 2')
      expect(await edition(stopped)).toBe('Edition 1')

      // Started again, it takes its pages back.
      stopped.listen(0)
      news.edition = 3
      invalidatePage('/news')
      await shutdown(stopped)

      expect(await edition(stopped)).toBe('Edition 3')
    }
    finally {
      news.edition = 1
    }
  })

  it('lets go of an app nothing reaches any more, one that only answered through handle() included', async () => {
    // The paths invalidatePage meets, one per prerendered page of every app it reaches.
    const reached = () => {
      const paths: string[] = []

      invalidatePage((path) => {
        paths.push(path)

        return false
      })

      return paths.filter(path => path === '/news').length
    }

    const before = reached()
    const dropped = await (async () => {
      const app = await build.serve({ routes, prebuilt: true, security: false, log: false })

      await app.handle(new Request('http://localhost/news'))

      return new WeakRef(app)
    })()

    expect(reached()).toBe(before + 1)

    // A timer of the request holds it a little while.
    for (let attempt = 0; attempt < 40 && (dropped.deref() !== undefined || reached() > before); attempt++) {
      Bun.gc(true)
      await Bun.sleep(50)
    }

    expect(dropped.deref()).toBeUndefined()
    expect(reached()).toBeLessThanOrEqual(before)
  })

  it('serves a stale prerendered page while rendering it again in the background, then the new one with its own tag', async () => {
    const { news } = await import('./fixtures/production/src/news')

    try {
      const app = await build.serve({ routes, prebuilt: true, security: false })
      const visit = async (headers: Record<string, string> = {}) => app.handle(new Request('http://localhost/news', { headers }))
      const built = await visit()
      const etag = built.headers.get('etag')!

      news.edition = 2
      news.delay = 200
      expect(await built.text()).toContain('<h1>Edition 1</h1>')
      expect(await (await visit()).text()).toContain('<h1>Edition 1</h1>')

      setSystemTime(Date.now() + 61_000)
      // The first request past the period still gets the page as it was built, as does one while the new render runs.
      expect(await (await visit()).text()).toContain('<h1>Edition 1</h1>')
      expect(await (await visit()).text()).toContain('<h1>Edition 1</h1>')
      await until(async () => (await (await visit()).text()).includes('<h1>Edition 2</h1>'), 'edition 2 to be served')

      const fresh = await visit({ 'if-none-match': etag, 'accept-encoding': 'br' })

      expect(fresh.status).toBe(200)
      expect(fresh.headers.get('etag')).not.toBe(etag)
      expect(new TextDecoder().decode(brotliDecompressSync(await fresh.bytes()))).toContain('<h1>Edition 2</h1>')
    }
    finally {
      setSystemTime()
      news.edition = 1
      news.delay = 0
    }
  }, UNTIL_TEST_MS)

  it('keeps the page it has when a render fails, trying again a minute later at most', async () => {
    const { news } = await import('./fixtures/production/src/news')
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const app = await build.serve({ routes, prebuilt: true, security: false })
      const visit = async () => (await app.handle(new Request('http://localhost/news'))).text()

      news.failing = true
      setSystemTime(Date.now() + 61_000)
      await visit()
      await until(async () => logged.mock.calls.length > 0, 'the failed render to be logged')
      expect(await visit()).toContain('<h1>Edition 1</h1>')

      news.failing = false
      news.edition = 3
      await visit()
      // Long enough for a render tried again too soon to be served, however loaded the machine.
      await Bun.sleep(500)
      expect(await visit()).toContain('<h1>Edition 1</h1>')

      setSystemTime(Date.now() + 122_000)
      await visit()
      await until(async () => (await visit()).includes('<h1>Edition 3</h1>'), 'edition 3 to be served')
    }
    finally {
      setSystemTime()
      logged.mockRestore()
      news.edition = 1
      news.failing = false
    }
  }, UNTIL_TEST_MS)

  it('renders the pages again on their first request when the server runs for another site than the build', async () => {
    const warned = spyOn(console, 'warn').mockImplementation(() => undefined)
    const canonical = async (app: Awaited<ReturnType<typeof pages>>) => (await (await app.handle(new Request('http://localhost/news'))).text()).match(/<link rel="canonical" href="([^"]+)">/)?.[1]

    try {
      await build.keeping(async () => {
        await build.prerender({ routes, site: 'https://example.com' })

        expect(await canonical(await build.serve({ routes, prebuilt: true, security: false, site: 'https://example.com' }))).toBe('https://example.com/news')
        expect(warned).not.toHaveBeenCalled()

        // Built where the variable naming the host is unset, run where it is.
        expect(await canonical(await build.serve({ routes, prebuilt: true, security: false, site: 'http://127.0.0.1:4173' }))).toBe('http://127.0.0.1:4173/news')
        expect(warned).toHaveBeenCalledWith('kay: kay build rendered its pages for https://example.com and this server runs for http://127.0.0.1:4173: each renders again on its first request')

        // Once rendered again, it goes out as small as the build would have written it.
        const moved = await build.serve({ routes, prebuilt: true, security: false, site: 'http://127.0.0.1:4173' })
        const html = await (await moved.handle(new Request('http://localhost/news'))).text()

        const strongest = (await compressTextStrongest(html)).br!
        const served = async () => (await moved.handle(new Request('http://localhost/news', { headers: { 'accept-encoding': 'br' } }))).bytes()

        // The strongest compression runs in the background, after the page is served.
        await until(async () => Buffer.from(await served()).equals(strongest), 'the strongest brotli to be served')
      })
    }
    finally {
      warned.mockRestore()
    }
  }, UNTIL_TEST_MS)

  it('warns once at boot of a server with seo set and no site, which kay build leaves to SITE_URL', async () => {
    const warned = spyOn(console, 'warn').mockImplementation(() => undefined)
    const missing = 'kay: `seo` is set, but not the origin the site is public at, in kay.config.ts or SITE_URL: pages get no canonical link or og:url, and the site no sitemap or robots.txt'

    try {
      await build.serve({ routes, prebuilt: true, security: false, seo: { name: 'Example' } })

      expect(warned.mock.calls.filter(([message]) => message === missing)).toHaveLength(1)

      warned.mockClear()
      await build.serve({ routes, prebuilt: true, security: false, seo: { name: 'Example' }, site: 'https://example.com' })
      await build.serve({ routes, prebuilt: true, security: false })

      expect(warned.mock.calls.filter(([message]) => message === missing)).toEqual([])
    }
    finally {
      warned.mockRestore()
    }
  })

  it('builds a page reading the site with none set, and renders it again for the site the server runs for', async () => {
    const warned = spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      expect((await readManifest(root, build.dir))!.pages!['/origin']!.readsSite).toBe(true)

      const app = await build.serve({ routes, prebuilt: true, security: false, site: 'https://example.com' })

      expect(await (await app.handle(new Request('http://localhost/origin'))).text()).toContain('<p class="origin">https://example.com</p>')
      // Built for no site and served for one, as one build for several hosts is, it goes quietly.
      expect(warned).not.toHaveBeenCalled()
      await expect(refusedPrerender({ routes }, (await readClient(root))!, { exportAll: true })).rejects.toThrow('origin.kay: it reads the site, through siteUrl() or siteOrigin()')
    }
    finally {
      warned.mockRestore()
    }
  })

  it('renders a page an action invalidated before the next request gets it, whatever its revalidate period', async () => {
    const { news } = await import('./fixtures/production/src/news')

    try {
      const app = await build.serve({ routes, prebuilt: true, security: false })
      const { publish } = await import(NEWS) as { publish: Action<{ edition: number }, void> }
      const visit = async (headers: Record<string, string> = {}) => app.handle(new Request('http://localhost/news', { headers }))
      const built = await visit()
      const etag = built.headers.get('etag')!

      expect(await built.text()).toContain('<h1>Edition 1</h1>')

      const posted = await app.handle(new Request(`http://localhost${publish.url}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'referer': 'http://localhost/news' }, body: new URLSearchParams({ edition: '4' }) }))

      expect(posted.status).toBe(303)

      const fresh = await visit({ 'if-none-match': etag })

      expect(fresh.status).toBe(200)
      expect(fresh.headers.get('etag')).not.toBe(etag)
      expect(await fresh.text()).toContain('<h1>Edition 4</h1>')

      // A function names every page it matches; a path no page has names nothing.
      news.edition = 5
      invalidatePage(path => path.startsWith('/ne'))
      invalidatePage('/nowhere')
      expect(await (await visit()).text()).toContain('<h1>Edition 5</h1>')
      news.edition = 6
      expect(await (await visit()).text()).toContain('<h1>Edition 5</h1>')
    }
    finally {
      news.edition = 1
    }
  })

  it('runs the page hook of an extension over a page the server renders again, as the build ran it', async () => {
    const { news } = await import('./fixtures/production/src/news')
    const extensions = [{ name: 'signed', transformPage: ({ path, html }: { path: string, html: string }) => html.replace('</body>', `<!--signed ${path}--></body>`) }]

    try {
      await build.keeping(async () => {
        await hookPrerendered(root, extensions.map(extension => extension.transformPage), { clientDir: (await build.client()).dir, publicDir: join(root, 'public'), base: '' }, build.dir)

        const app = await build.serve({ routes, prebuilt: true, security: false, extensions })
        const visit = async () => (await app.handle(new Request('http://localhost/news'))).text()
        const built = await visit()

        expect(built).toContain('<h1>Edition 1</h1>')
        expect(built).toContain('<!--signed /news--></body>')
        expect(built.match(/<!--signed/g)).toHaveLength(1)

        news.edition = 2
        invalidatePage('/news')

        const fresh = await visit()

        expect(fresh).toContain('<h1>Edition 2</h1>')
        expect(fresh).toContain('<!--signed /news--></body>')
      })
    }
    finally {
      news.edition = 1
    }
  })

  it('refuses a revalidate that is no positive duration', async () => {
    const copy = await fixtureCopy('production')

    try {
      await Bun.write(join(copy, 'src/routes/broken.kay'), '--- server\nexport const page = { prerender: true, revalidate: \'hourly\' }\n---\np Broken\n')

      await expect(refusedPrerender({ routes: `${copy}/src/routes` }, (await readClient(root))!)).rejects.toThrow('broken.kay\'s revalidate is \'hourly\'; it takes a positive duration')
    }
    finally {
      await rm(copy, { recursive: true, force: true })
    }
  })
})

describe('a prerendered page posted to', () => {
  const routes = 'tests/fixtures/production/src/routes'
  // Held in a variable so tsc leaves the .kay import to Bun.
  const NEWSLETTER = './fixtures/production/src/routes/newsletter.kay'
  const BROCHURE = './fixtures/production/src/routes/brochure.kay'
  const LEAFLET = './fixtures/production/src/routes/leaflet.kay'
  const PAMPHLET = './fixtures/production/src/routes/pamphlet.kay'
  const root = process.cwd()
  const withEntry = (client: ClientBuild): ClientBuild => ({ ...client, entry: '/_kay/entry.js', navigation: true })

  const build = prerendered({ routes }, withEntry)

  it('renders for the post a form sent, and for the request carrying how it went, kept by no cache, the built file served before and after', async () => {
    const app = await build.serve({ routes, prebuilt: true, security: false })
    const { join: subscribe } = await import(NEWSLETTER) as { join: Action<{ email: string }, string> }
    const visit = async (headers: Record<string, string> = {}) => app.handle(new Request('http://localhost/newsletter', { headers }))
    const post = async (email: string) => app.handle(new Request(`http://localhost${subscribe.url}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'referer': 'http://localhost/newsletter' }, body: new URLSearchParams({ email }) }))
    // What the browser does with the redirect a post that went through answers: back to the page, sending the cookie it was just given.
    const followed = async (response: Response) => {
      const cookie = response.headers.get('set-cookie')!

      expect(response.headers.get('location')).toBe('http://localhost/newsletter')

      return visit({ cookie: cookie.slice(0, cookie.indexOf(';')) })
    }

    const built = await visit()
    const etag = built.headers.get('etag')!

    expect(etag).toBeTruthy()
    expect(await built.text()).not.toContain('<p class="joined">')
    // A cookie whose name merely holds the result cookie's is no result.
    expect((await visit({ cookie: 'not_kay_flash=1' })).headers.get('etag')).toBe(etag)

    const refused = await post('nope')

    expect(refused.status).toBe(422)
    expect(refused.headers.get('cache-control')).toBe('private, no-store')
    expect(refused.headers.has('etag')).toBe(false)

    const html = await refused.text()

    expect(html).toContain('<p class="error">Not an email</p>')
    expect(html).toContain('value="nope"')

    const joined = await followed(await post('ada@example.com'))

    expect(joined.headers.get('cache-control')).toBe('private, no-store')
    expect(joined.headers.get('set-cookie')).toContain('kay_flash=;')
    expect(await joined.text()).toContain('<p class="joined">Welcome ada</p>')

    const after = await visit({ 'if-none-match': etag })

    expect(after.status).toBe(304)
    expect(after.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
  })

  it('signs the stamp of a form posting to an action with `minTime` on every visit, the page rendered once at build, kept by no cache', async () => {
    const start = Date.now()

    try {
      expect(await Bun.file(join(build.pages, 'brochure.html')).text()).toContain('name="kay_since" value="kay-stamp:')

      const app = await build.serve({ routes, prebuilt: true, security: false })
      const { order } = await import(BROCHURE) as { order: Action<{ address: string }, number> }
      const visit = async (encoding: string) => app.handle(new Request('http://localhost/brochure', { headers: { 'accept-encoding': encoding } }))
      const stampOf = (html: string) => (/name="kay_since" value="([^"]+)"/).exec(html)![1]!
      const post = async (stamp: string) => app.handle(new Request(`http://localhost${order.url}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'referer': 'http://localhost/brochure' }, body: new URLSearchParams({ address: '1 Main St', kay_since: stamp }) }))

      setSystemTime(start)

      const plain = await visit('identity')

      expect(plain.headers.get('cache-control')).toBe('private, no-store')
      expect(plain.headers.has('etag')).toBe(false)

      const first = stampOf(await plain.text())

      setSystemTime(start + 1000)

      const zipped = await visit('gzip')

      expect(zipped.headers.get('content-encoding')).toBe('gzip')

      const second = stampOf(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await zipped.arrayBuffer()))))

      expect(second).not.toBe(first)
      expect((await post(second)).status).toBe(422)

      setSystemTime(start + 3000)
      expect((await post(first)).status).toBe(303)
    }
    finally {
      setSystemTime()
    }
  })

  it('signs a fresh proof-of-work challenge into a prerendered page on every visit, each solved once', async () => {
    expect(await Bun.file(join(build.pages, 'leaflet.html')).text()).toContain('"kay-work:')

    const app = await build.serve({ routes, prebuilt: true, security: false })
    const { subscribe } = await import(LEAFLET) as { subscribe: Action<{ email: string }, number> }
    const challengeOf = async () => Object.values(JSON.parse((/data-kay-work>(.*?)<\/script>/).exec(await (await app.handle(new Request('http://localhost/leaflet'))).text())![1]!) as Record<string, string>)[0]!
    const post = async (solution: string) => app.handle(new Request(`http://localhost${subscribe.url}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'referer': 'http://localhost/leaflet', 'x-kay-work': solution }, body: new URLSearchParams({ email: 'a@b.c' }) }))
    const first = await challengeOf()

    expect(await challengeOf()).not.toBe(first)

    const solution = solveWork(first)!

    expect((await post(solution)).status).toBe(303)
    expect((await post(solution)).status).toBe(422)
    await expect(refusedPrerender({ routes }, withEntry((await readClient(root))!), { exportAll: true })).rejects.toThrow('flyer.kay: a form in it posts to an action with `minTime` or `proofOfWork`')
  })

  it('signs a fresh `workChallenge` into a prerendered page\'s field on every visit, which the action verifies once', async () => {
    expect(await Bun.file(join(build.pages, 'pamphlet.html')).text()).toContain('data-kay-work="kay-work:')

    const app = await build.serve({ routes, prebuilt: true, security: false })
    const { join: joinUp } = await import(PAMPHLET) as { join: Action<{ proof: string }, string> }
    const challengeOf = async () => (/data-kay-work="([^"]+)"/).exec(await (await app.handle(new Request('http://localhost/pamphlet'))).text())![1]!
    const post = async (proof: string) => app.handle(new Request(`http://localhost${joinUp.url}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'referer': 'http://localhost/pamphlet' }, body: new URLSearchParams({ proof }) }))
    const first = await challengeOf()

    expect(first).not.toStartWith('kay-work:')
    expect(await challengeOf()).not.toBe(first)

    const solution = solveWork(first)!

    expect((await post(solution)).status).toBe(303)
    expect((await post(solution)).status).toBe(422)
  })
})

describe('compression', () => {
  const routes = 'tests/fixtures/production/src/routes'

  it('compresses what renders per request for a browser taking brotli or gzip, headers and cookies kept', async () => {
    // Registered after the pages, as hooks only reach the routes that come after them.
    const app = new Elysia()
      .use(await pages({ routes, prebuilt: false, compress: true }))
      .get('/api/report', () => new Response(JSON.stringify({ rows: Array.from({ length: 100 }, (_, i) => i) }), { headers: { 'content-type': 'application/json', 'set-cookie': 'seen=1' } }))
      .get('/api/tiny', () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '2' } }))
      .get('/api/ok', () => new Response('ok', { headers: { 'content-type': 'text/plain' } }))
      .get('/api/raw', () => new Response('x'.repeat(1000), { headers: { 'content-type': 'text/plain', 'cache-control': 'no-transform' } }))
      .get('/api/photo', () => new Response(new Uint8Array(1000), { headers: { 'content-type': 'image/webp' } }))
      .get('/api/encoded', () => new Response('already', { headers: { 'content-type': 'text/css', 'content-encoding': 'br' } }))
    const fetch = async (path: string, encoding: string) => app.handle(new Request(`http://localhost${path}`, { headers: { 'accept-encoding': encoding } }))
    const page = await fetch('/contact', 'gzip, deflate, br, zstd')
    const plain = await fetch('/contact', 'identity')

    expect(page.headers.get('content-encoding')).toBe('br')
    expect(page.headers.get('vary')).toContain('accept-encoding')
    expect(page.headers.get('content-security-policy')).toStartWith('default-src \'self\'')
    expect(new TextDecoder().decode(brotliDecompressSync(await page.bytes()))).toBe(await plain.text())
    expect(plain.headers.get('content-encoding')).toBeNull()
    expect(plain.headers.get('vary')).toContain('accept-encoding')

    const report = await fetch('/api/report', 'gzip')

    expect(report.headers.get('content-encoding')).toBe('gzip')
    expect(report.headers.get('set-cookie')).toBe('seen=1')
    expect(JSON.parse(new TextDecoder().decode(Bun.gunzipSync(await report.bytes())))).toMatchObject({ rows: expect.any(Array) })
    expect(plain.headers.get('vary')).toBe('cookie, accept-encoding')

    // Left alone, each keeps its body.
    for (const [path, body] of [['/api/tiny', '{}'], ['/api/raw', 'x'.repeat(1000)], ['/api/photo', '\0'.repeat(1000)], ['/api/encoded', 'already']] as const) {
      const response = await fetch(path, 'br')

      expect(response.headers.get('content-encoding')).toBe(path === '/api/encoded' ? 'br' : null)
      expect(await response.text()).toBe(body)
    }

    // Too small to gain, its length unknown until read: sent as it is.
    const ok = await fetch('/api/ok', 'br')

    expect(ok.headers.get('content-encoding')).toBeNull()
    expect(ok.headers.get('vary')).toBeNull()
    expect(await ok.text()).toBe('ok')
  })

  it('compresses in production unless told not to, and nowhere else unless told to', async () => {
    const encodingOf = async (options: { compress?: boolean }) => {
      const app = new Elysia().use(await pages({ routes, prebuilt: false, ...options }))
      const page = await app.handle(new Request('http://localhost/contact', { headers: { 'accept-encoding': 'br' } }))

      return page.headers.get('content-encoding')
    }
    const before = process.env.NODE_ENV

    try {
      process.env.NODE_ENV = 'production'
      expect(await encodingOf({})).toBe('br')
      expect(await encodingOf({ compress: false })).toBeNull()
      process.env.NODE_ENV = 'development'
      expect(await encodingOf({})).toBeNull()
    }
    finally {
      if (before === undefined)
        delete process.env.NODE_ENV
      else
        process.env.NODE_ENV = before
    }
  })

  it('splices fixed texts into the gzip of a page, wherever they sit and however much lies around them, and compresses anything else as before', async () => {
    const { compressResponse, fixedTexts, wholeResponse } = await import('../src/server/compress')
    const a = `<style>.a{color:red}${'.x{margin:0}'.repeat(40)}</style>`
    const b = `<style>.b{color:blue}${'.y{padding:0}'.repeat(40)}</style>`
    const fixed = fixedTexts([a, b, a])
    const send = async (body: string, accept: string, type = 'text/html') => (await compressResponse(new Request('http://localhost/', { headers: { 'accept-encoding': accept } }), wholeResponse(body, { headers: { 'content-type': type } }), fixed))!
    const decoded = async (response: Response) => {
      const bytes = new Uint8Array(await response.arrayBuffer())

      return response.headers.get('content-encoding') === 'gzip' ? new TextDecoder().decode(Bun.gunzipSync(bytes)) : brotliDecompressSync(bytes).toString()
    }
    const text = `<p>${'café '.repeat(80)}</p>`

    expect(fixed).toHaveLength(2)

    // Side by side, leading, trailing, alone, twice, in another order than given, and around more than deflates on the main thread.
    for (const page of [`<head>${a}${b}</head>${text}`, `${a}${text}`, `${text}${b}`, a, `${a}${text}${a}`, `${b}${a}`, `${a}${text.repeat(200)}${b}`]) {
      const response = await send(page, 'br, gzip')

      expect(response.headers.get('content-encoding')).toBe('gzip')
      expect(await decoded(response)).toBe(page)
    }

    for (const [page, accept, type] of [[`${a}${text}`, 'br, gzip;q=0', 'text/html'], [text, 'br, gzip', 'text/html'], [`{"css":${JSON.stringify(a)}}`, 'br, gzip', 'application/json']] as const) {
      const response = await send(page, accept, type)

      expect(response.headers.get('content-encoding')).toBe('br')
      expect(await decoded(response)).toBe(page)
    }
  })

  it('sends a body of 15 KB or more that waited on zlib\'s threads as a stream, which Bun writes corked, and a smaller one or one compressed within the request\'s tick with its length', async () => {
    const { compressResponse, fixedTexts, wholeResponse } = await import('../src/server/compress')
    // Hashed numbers compress to about half their size, well past what Bun corks once a reply waited on a zlib callback.
    const words = (count: number, from = 0) => Array.from({ length: count }, (_, i) => ((i + from) * 2654435761 % 1e9).toString(36)).join(' ')
    const style = `<style>${words(6000, 1)}</style>`
    const fixed = fixedTexts([style])
    // Random bytes, which no compression shrinks enough to send compressed.
    let seed = 1
    const noise = Uint8Array.from({ length: 20_000 }, () => (seed = Math.imul(seed, 1664525) + 1013904223 | 0) >>> 24)
    const pages: Record<string, string | Uint8Array<ArrayBuffer>> = { '/pool': `<p>${words(12000)}</p>`, '/spliced': `${style}<p>${words(12000)}</p>`, '/here': `${style}<p>${words(100)}</p>`, '/small': `<p>${words(1500)}</p>`, '/noise': noise }
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async (request) => {
      const response = wholeResponse(pages[new URL(request.url).pathname]!, { headers: { 'content-type': 'text/html' } })

      return await compressResponse(request, response, fixed) ?? response
    } })

    try {
      for (const [path, accept, encoding, stream] of [['/pool', 'br', 'br', true], ['/spliced', 'br, gzip', 'gzip', true], ['/noise', 'br', null, true], ['/here', 'br, gzip', 'gzip', false], ['/small', 'br', 'br', false]] as const) {
        const url = `http://127.0.0.1:${server.port}${path}`
        const sent = await (await fetch(url, { headers: { 'accept-encoding': accept }, decompress: false })).bytes()
        const response = await fetch(url, { headers: { 'accept-encoding': accept } })

        // Each lands on its side of the line by its size as sent, not by luck of the ratio.
        expect(sent.length >= 15 * 1024).toBe(path !== '/small')
        expect(response.headers.get('content-encoding')).toBe(encoding)
        expect(response.headers.get('transfer-encoding')).toBe(stream ? 'chunked' : null)
        expect(await response.bytes()).toEqual(Buffer.from(pages[path]!))
      }
    }
    finally {
      await server.stop(true)
    }
  })

  it('sends a streamed page\'s early chunks before the stream ends', async () => {
    const { compressResponse } = await import('../src/server/compress')
    let push!: (text: string) => void
    let close!: () => void
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = text => controller.enqueue(new TextEncoder().encode(text))
        close = () => controller.close()
      },
    })
    const response = (await compressResponse(new Request('http://localhost/', { headers: { 'accept-encoding': 'br' } }), new Response(body, { headers: { 'content-type': 'text/html' } })))!
    const reader = response.body!.getReader()
    const parts: Uint8Array[] = []

    push(`<p>${'shell '.repeat(100)}</p>`)
    parts.push((await reader.read()).value!)
    // The shell decodes on its own, before the rest exists.
    expect(new TextDecoder().decode(brotliDecompressSync(Buffer.concat(parts), { finishFlush: constants.BROTLI_OPERATION_FLUSH }))).toStartWith('<p>shell')

    push('<p>later</p>')
    close()

    for (let read = await reader.read(); !read.done; read = await reader.read())
      parts.push(read.value)

    expect(new TextDecoder().decode(brotliDecompressSync(Buffer.concat(parts)))).toEndWith('<p>later</p>')
  })

  it('leaves the body unread for a client taking no encoding, telling caches the response varies', async () => {
    const { compressResponse } = await import('../src/server/compress')
    const response = new Response('x'.repeat(1000), { headers: { 'content-type': 'text/html' } })

    expect(compressResponse(new Request('http://localhost/', { headers: { 'accept-encoding': 'identity' } }), response)).toBeUndefined()
    expect(response.bodyUsed).toBe(false)
    expect(response.headers.get('vary')).toBe('accept-encoding')
  })

  it('judges a body kay made whole by its size, a small one left unread', async () => {
    const { compressResponse, wholeResponse } = await import('../src/server/compress')
    const request = new Request('http://localhost/', { headers: { 'accept-encoding': 'br' } })
    const small = wholeResponse('ok', { headers: { 'content-type': 'text/plain' } })

    expect(compressResponse(request, small)).toBeUndefined()
    expect(small.bodyUsed).toBe(false)

    const page = (await compressResponse(request, wholeResponse(`<p>${'é page '.repeat(100)}</p>`, { headers: { 'content-type': 'text/html' } })))!

    expect(page.headers.get('content-encoding')).toBe('br')
    expect(new TextDecoder().decode(brotliDecompressSync(await page.bytes()))).toBe(`<p>${'é page '.repeat(100)}</p>`)
  })

  it('leaves responses alone unless compress is on', async () => {
    const app = await pages({ routes, prebuilt: false })

    expect((await app.handle(new Request('http://localhost/contact', { headers: { 'accept-encoding': 'br' } }))).headers.get('content-encoding')).toBeNull()
  })
})

describe('footprint', () => {
  it('serves without loading the compiler or resvg, which only development and the build need', async () => {
    // A process of its own, as this one compiled `.kay` files already; Babel is CommonJS, so loading it fills require.cache.
    const probe = Bun.spawn(['bun', '-e', 'await import(\'./src/server/index.ts\'); await import(\'./src/server/internal.ts\'); console.log(Object.keys(require.cache).filter(key => key.includes(\'@babel\') || key.includes(\'@resvg\')).join(\'\\n\'))'], { stdout: 'pipe' })

    expect((await new Response(probe.stdout).text()).trim()).toBe('')
    expect(await probe.exited).toBe(0)
  })
})

describe('lifecycle', () => {
  // A server in a process of its own, with the port kay's first line printed and what it prints after.
  async function startServer(env: Record<string, string> = {}) {
    const server = Bun.spawn(['bun', 'tests/fixtures/production/server.ts'], { env: { ...process.env, NODE_ENV: 'production', ...env }, stdout: 'pipe', stderr: 'pipe' })
    const reader = server.stdout.getReader()
    let output = ''

    while (!output.includes('\n')) {
      const { value, done } = await reader.read()

      if (done)
        throw new Error(`the server exited: ${await new Response(server.stderr).text()}`)

      output += new TextDecoder().decode(value)
    }

    expect(output).toMatch(new RegExp(`^kay: listening on http://localhost:\\d+, kay ${version} in production, 0 pages prerendered\n`))

    const port = (/localhost:(\d+)/).exec(output)![1]
    const rest = (async () => {
      for (;;) {
        const { value, done } = await reader.read()

        if (done)
          return output

        output += new TextDecoder().decode(value)
      }
    })()

    const url = `http://localhost:${port}`
    // Sent, and resolving once the server is answering it, which a loaded machine may take longer than a sleep to get to.
    const slow = async () => {
      const response = fetch(`${url}/slow`)

      for (const start = Date.now(); !output.includes('slow started\n') && Date.now() - start < 10_000;)
        await Bun.sleep(10)

      return { response }
    }

    return { server, url, slow, output: async () => rest }
  }

  it('answers the health route while it takes requests', async () => {
    const app = await pages({ routes: 'tests/fixtures/production/src/routes', prebuilt: false })
    const unhealthy = await pages({ routes: 'tests/fixtures/production/src/routes', prebuilt: false, health: { path: '/up', check: () => false } })
    const health = await app.handle(new Request('http://localhost/_kay/health'))

    expect(health.status).toBe(200)
    expect(await health.text()).toBe('ok')
    expect(health.headers.get('cache-control')).toBe('no-store')
    expect((await unhealthy.handle(new Request('http://localhost/up'))).status).toBe(503)
    expect((await (await pages({ routes: 'tests/fixtures/production/src/routes', prebuilt: false, health: false })).handle(new Request('http://localhost/_kay/health'))).status).toBe(404)
  })

  it('logs a health check that throws with its path, never its query', async () => {
    const failing = await pages({ routes: 'tests/fixtures/production/src/routes', prebuilt: false, health: { check: () => {
      throw new Error('Database down')
    } } })
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      expect((await failing.handle(new Request('http://localhost/_kay/health?token=secret'))).status).toBe(503)
      expect(logged.mock.calls.map(call => String(call[0]))).toEqual([expect.stringMatching(/^kay: GET \/_kay\/health, request \S+: the health check failed\nError: Database down\n/)])
    }
    finally {
      logged.mockRestore()
    }
  })

  it('probes the health route of a server beside it, as an executable run with --health does', async () => {
    const app = new Elysia().use(await pages({ routes: 'tests/fixtures/production/src/routes', prebuilt: false, health: { path: '/up' } })).listen(0)
    const quiet = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      expect(await probeHealth({ path: '/up' }, String(app.server!.port))).toBe(0)
      expect(await probeHealth(undefined, String(app.server!.port))).toBe(1)
      expect(await probeHealth(false, String(app.server!.port))).toBe(1)
    }
    finally {
      quiet.mockRestore()
      await app.stop()
    }
  })

  it('on SIGTERM lets open requests finish, runs the stop hooks, and exits', async () => {
    const { server, url, slow, output } = await startServer()

    expect((await fetch(`${url}/_kay/health`)).status).toBe(200)

    const { response } = await slow()

    server.kill('SIGTERM')

    expect(await (await response).text()).toBe('slow done')
    expect(await server.exited).toBe(0)
    expect(await output()).toContain('jobs stopped')
  }, 20_000)

  it('closes what is still open past the shutdown timeout and exits with 1', async () => {
    const { server, slow } = await startServer({ SHUTDOWN_TIMEOUT: '0.2', SLOW_MS: '5000' })
    const { response } = await slow()
    const status = (async () => {
      try {
        return (await response).status
      }
      catch {
        return 'closed'
      }
    })()

    server.kill('SIGTERM')

    expect(await server.exited).toBe(1)
    expect(await status).toBe('closed')
  }, 20_000)
})

describe('request logging', () => {
  const routes = 'tests/fixtures/production/src/routes'
  // Elysia runs the hook writing a line once the event loop gets to it, after the response and even the shutdown, later still on a loaded machine.
  const written = async (count: () => number, expected: number) => {
    for (const start = Date.now(); count() < expected && Date.now() - start < 5000;)
      await Bun.sleep(10)
  }

  it('says where it listens and what runs, then logs one line per request with its status and duration, leaving kay\'s own routes out', async () => {
    const lines = spyOn(console, 'log').mockImplementation(() => undefined)

    try {
      const app = new Elysia().use(await pages({ routes, prebuilt: false, log: true })).get('/api/fail', ({ set }) => {
        set.status = 418

        return 'teapot'
      }).listen(0)

      const ids: (string | null)[] = []

      for (const path of ['/contact?token=secret', '/api/fail', '/_kay/health', '/missing']) {
        const response = await fetch(`http://localhost:${app.server!.port}${path}`)

        ids.push(response.headers.get('x-request-id'))
        await response.text()
      }

      const port = app.server!.port

      await shutdown(app)
      await written(() => lines.mock.calls.length, 4)
      expect(lines.mock.calls.map(call => String(call[0]).replace(/\d+ms /, 'Nms '))).toEqual([`kay: listening on http://localhost:${port}, kay ${version} in test, 0 pages prerendered`, `GET /contact 200 Nms ${ids[0]}`, `GET /api/fail 418 Nms ${ids[1]}`, `GET /missing 404 Nms ${ids[3]}`])
      expect(new Set(ids).size).toBe(4)
    }
    finally {
      lines.mockRestore()
    }
  })

  it('answers each request with an id of its own, the one a trusted proxy passed on, kept across a rewrite and readable from onError', async () => {
    const ids: string[] = []
    const passed = { 'x-request-id': 'edge-42' }
    const open = await pages({ routes, prebuilt: false, rewrite: url => url.pathname === '/old-contact' ? '/contact' : undefined })
    const behind = await pages({ routes, prebuilt: false, proxy: { hops: 1 }, onError: (_, request) => void ids.push(requestId(request)) })
    const idOf = async (app: typeof open, path: string, headers: Record<string, string> = {}) => (await app.handle(new Request(`http://localhost${path}`, { headers }))).headers.get('x-request-id')
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const first = await idOf(open, '/contact', passed)
      const second = await idOf(open, '/contact')

      expect(first).toMatch(/^[\w-]{22}$/)
      expect(second).not.toBe(first)
      expect(await idOf(open, '/old-contact')).toMatch(/^[\w-]{22}$/)
      expect(await idOf(behind, '/contact', passed)).toBe('edge-42')
      expect(await idOf(behind, '/contact', { 'x-request-id': 'a'.repeat(200) })).not.toBe('a'.repeat(200))
      expect(await idOf(behind, '/missing')).toMatch(/^[\w-]{22}$/)

      await behind.handle(new Request('http://localhost/_kay/error', { method: 'POST', headers: { ...passed, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Error', message: 'Broken island', url: '/contact', stack: '' }) }))
      await Bun.sleep(10)
      expect(ids).toEqual(['edge-42'])
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(/^kay: POST \/_kay\/error, request edge-42\n/))
    }
    finally {
      logged.mockRestore()
    }
  })

  it('writes kay\'s own messages in the same format, under the request they were logged for', async () => {
    const health = { check: () => {
      throw new Error('Database down')
    } }
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const entries: LogEntry[] = []

    try {
      const json = await pages({ routes, prebuilt: false, log: 'json', health })

      await json.handle(new Request('http://localhost/_kay/health?token=secret'))
      expect(JSON.parse(String(logged.mock.calls[0]![0]))).toEqual({ type: 'message', time: expect.any(String), level: 'error', from: 'kay', message: 'the health check failed', request: { method: 'GET', path: '/_kay/health', id: expect.any(String) }, error: { name: 'Error', message: 'Database down', stack: expect.stringMatching(/^Error: Database down\n\s+at check \(\S+production\.test\.ts:\d+:\d+\)/) } })

      const custom = await pages({ routes, prebuilt: false, log: entry => void entries.push(entry), health })

      await custom.handle(new Request('http://localhost/_kay/health'))
      expect(logged).toHaveBeenCalledTimes(1)
      expect(entries).toEqual([{ type: 'message', time: expect.any(String), level: 'error', from: 'kay', message: 'the health check failed', request: { method: 'GET', path: '/_kay/health', id: expect.any(String) }, error: { name: 'Error', message: 'Database down', stack: expect.any(String) } }])
    }
    finally {
      logged.mockRestore()
      useLogger(true)
    }
  })

  it('writes a compile error as kay check prints it, the report in place of a stack, the one the dev server rebuilds from IPC included', () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const thrown = new KayCompileError([{ file: join(process.cwd(), 'src/broken.kay'), source: 'p ok\nelse\n  p no\n', start: 5, end: 9, message: '`else` must directly follow an `if`' }])
    // As `kay dev`'s client build hands it over: a plain error named after the class, its stack the class name over the message.
    const rebuilt = Object.assign(new Error(thrown.message), { name: 'KayCompileError' })
    const report = 'error: `else` must directly follow an `if`\n --> src/broken.kay:2:1\n  |\n1 | p ok\n2 | else\n  | ^^^^'

    rebuilt.stack = `KayCompileError: ${thrown.message}`

    try {
      for (const error of [thrown, rebuilt]) {
        useLogger(true)
        logFrom('kay').error('the server could not start', error)
        expect(logged.mock.calls.at(-1)![0]).toBe(`kay: the server could not start\n${report}`)

        useLogger('json')
        logFrom('kay').error('the server could not start', error)
        expect((JSON.parse(String(logged.mock.calls.at(-1)![0])) as LogEntry & { type: 'message' }).error).toEqual({ name: 'KayCompileError', message: thrown.message, stack: report })
      }
    }
    finally {
      logged.mockRestore()
      useLogger(true)
    }
  })

  it('writes a library\'s messages the same way, headed by its name and the request they were logged under', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const entries: LogEntry[] = []
    const mail = logFrom('kayjs-mail')

    try {
      useLogger(entry => void entries.push(entry))
      await answeringRequest(new Request('http://localhost/signup?token=secret', { method: 'POST' }), async () => mail.warn('a mail was refused'))
      expect(entries).toEqual([{ type: 'message', time: expect.any(String), level: 'warn', from: 'kayjs-mail', message: 'a mail was refused', request: { method: 'POST', path: '/signup', id: expect.any(String) } }])

      useLogger(true)
      mail.error('the outbox is full', new Error('Disk full'))
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(/^kayjs-mail: the outbox is full\nError: Disk full\n/))

      useLogger('json')
      mail.error('a mail bounced')
      expect(JSON.parse(String(logged.mock.calls.at(-1)![0]))).toEqual({ type: 'message', time: expect.any(String), level: 'error', from: 'kayjs-mail', message: 'a mail bounced' })
      expect(() => logFrom('')).toThrow('kay: logFrom takes the name heading the library\'s messages')
    }
    finally {
      logged.mockRestore()
      useLogger(true)
    }
  })

  it('writes a library\'s messages to the console without a server, and to a sink set by a kay that predates `from`', () => {
    const warned = spyOn(console, 'warn').mockImplementation(() => undefined)
    const sink = logSink()!
    const calls: unknown[][] = []

    try {
      ;(globalThis as Record<symbol, unknown>)[Symbol.for('kay.log')] = undefined
      logFrom('kayjs-mail').warn('no server yet', 'why')
      expect(warned.mock.calls).toEqual([['[kayjs-mail] no server yet', 'why']])

      setLogSink((level, message, error, request) => void calls.push([level, message, error, request]))
      logFrom('kayjs-mail').error('the outbox is full', 'Disk full')
      expect(calls).toEqual([['error', 'the outbox is full', 'Disk full', undefined]])
    }
    finally {
      setLogSink(sink)
      warned.mockRestore()
    }
  })

  it('heads what an endpoint and an API module\'s guard log with the request they answer', async () => {
    const dir = await scratchDir('library-log-')
    const entries: LogEntry[] = []
    const logging = 'import { logFrom } from \'kay\'\n\nconst log = logFrom(\'kayjs-feed\')\n\n'

    try {
      await Promise.all([
        Bun.write(join(dir, 'routes/feed.txt.ts'), `${logging}export function GET() {\n  log.info('feed read')\n\n  return 'items'\n}\n`),
        Bun.write(join(dir, 'api/_guard.ts'), `import { guard } from 'kay'\n\n${logging}export default guard(() => {\n  log.info('api guarded')\n})\n`),
        Bun.write(join(dir, 'api/notes.ts'), 'import { api } from \'kay/server\'\n\nexport default api().get(\'/\', () => [])\n'),
      ])
      const app = await pages({ routes: join(dir, 'routes'), api: join(dir, 'api'), prebuilt: false, log: entry => void entries.push(entry) })

      await app.handle(new Request('http://localhost/feed.txt'))
      await app.handle(new Request('http://localhost/api/notes'))
      expect(entries.filter(entry => entry.type === 'message')).toEqual([
        { type: 'message', time: expect.any(String), level: 'info', from: 'kayjs-feed', message: 'feed read', request: { method: 'GET', path: '/feed.txt', id: expect.any(String) } },
        { type: 'message', time: expect.any(String), level: 'info', from: 'kayjs-feed', message: 'api guarded', request: { method: 'GET', path: '/api/notes', id: expect.any(String) } },
      ])
    }
    finally {
      useLogger(true)
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('writes JSON, or hands each entry to a function', async () => {
    const lines = spyOn(console, 'log').mockImplementation(() => undefined)
    const entries: unknown[] = []

    try {
      const json = await pages({ routes, prebuilt: false, log: 'json' })
      const custom = await pages({ routes, prebuilt: false, log: entry => entries.push(entry) })
      const quiet = await pages({ routes, prebuilt: false })

      for (const [app, expected] of [[json, 2], [custom, 4], [quiet, 4]] as const) {
        app.listen(0)
        await (await fetch(`http://localhost:${app.server!.port}/contact`)).text()
        await shutdown(app)
        await written(() => lines.mock.calls.length + entries.length, expected)
      }

      const started = { type: 'message', time: expect.any(String), level: 'info', from: 'kay', message: expect.stringMatching(/^listening on http:\/\/localhost:\d+, kay /) }

      expect(lines.mock.calls.map(call => JSON.parse(String(call[0])) as unknown)).toEqual([started, { type: 'request', time: expect.any(String), level: 'info', method: 'GET', path: '/contact', status: 200, duration: expect.any(Number), id: expect.any(String) }])
      expect(entries).toEqual([started, { type: 'request', time: expect.any(String), level: 'info', method: 'GET', path: '/contact', status: 200, duration: expect.any(Number), id: expect.any(String) }])
    }
    finally {
      lines.mockRestore()
    }
  })
})

describe('rewrites', () => {
  const routes = 'tests/fixtures/production/src/routes'
  const rewrite = (url: URL) => url.hostname === 'shop.localhost' ? `/shop${url.pathname}${url.search}` : undefined

  it('serves a host from a section through the whole app, the query kept and derives reached', async () => {
    const app = new Elysia()
      .derive(({ request }) => ({ seenAt: new URL(request.url).pathname }))
      .use(await pages({ routes, prebuilt: false, security: false, rewrite }))
      .get('/shop/api/where', ({ seenAt }) => seenAt)
      .get('/shop/api/marked', ({ request }) => String(request.headers.has('x-kay-rewritten') || request.headers.has('x-kay-client')))
      .post('/shop/api/echo', ({ body }) => body)
      .listen(0)
    const fetchAt = async (host: string, path: string) => fetch(`http://localhost:${app.server!.port}${path}`, { headers: { host } })

    try {
      expect(await (await fetchAt('shop.localhost', '/mug?color=red')).text()).toContain('<p class="item">Shop mug in red at /shop/mug</p>')
      expect(await (await fetchAt('shop.localhost', '/api/where')).text()).toBe('/shop/api/where')
      expect(await (await fetchAt('shop.localhost', '/api/marked')).text()).toBe('false')
      // kay's own routes keep their paths on every host.
      expect((await fetchAt('shop.localhost', '/_kay/health')).status).toBe(200)

      const echoed = await fetch(`http://localhost:${app.server!.port}/api/echo`, { method: 'POST', headers: { 'host': 'shop.localhost', 'content-type': 'application/json' }, body: JSON.stringify({ mug: 'red' }) })

      expect(await echoed.json()).toEqual({ mug: 'red' })
      expect(await (await fetchAt('localhost', '/shop/mug')).text()).toContain('<p class="item">Shop mug in any at /shop/mug</p>')
      expect((await fetchAt('localhost', '/mug')).status).toBe(404)
      // Without a server, kay's own pages serve it.
      expect(await (await (await pages({ routes, prebuilt: false, rewrite })).handle(new Request('http://shop.localhost/mug'))).text()).toContain('<p class="item">Shop mug in any at /shop/mug</p>')
    }
    finally {
      await shutdown(app)
    }
  })

  it('keeps the socket\'s address for a rewritten request, a client never passing for one', async () => {
    const { rewrittenAddress } = await import('../src/server/rewrite')
    const forged = new Request('http://localhost/', { headers: { 'x-kay-rewritten': 'guess', 'x-kay-client': '1.2.3.4' } })

    expect(rewrittenAddress(forged)).toBeUndefined()
  })

  it('refuses a rewrite to anything but a path', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const app = await pages({ routes, prebuilt: false, rewrite: () => 'https://elsewhere.example/' })

    try {
      expect((await app.handle(new Request('http://localhost/contact'))).status).toBe(500)
      expect(String(logged.mock.calls[0]![0])).toContain('it returns a path starting with one /')
    }
    finally {
      logged.mockRestore()
    }
  })
})
