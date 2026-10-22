import type { Server } from 'bun'
import type { Action } from '../src/runtime'
import type { ByteSize } from '../src/runtime/byte-size'
import type { ProtectionRefusal } from '../src/server/protection'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { Database } from 'bun:sqlite'
import { describe, expect, it, setSystemTime, spyOn } from 'bun:test'
import { parse, stringify } from 'devalue'
import { Elysia, t } from 'elysia'
import { check } from '../src/check'
import { compileKay } from '../src/compiler'
import { action } from '../src/runtime'
import { openSqlite } from '../src/runtime/sqlite.server'
import { clientAddress, countSucceeded, memoryRates, protectionRefusal, rateKey, rateLimit, sqliteRates, trustProxy } from '../src/server/protection'
import { signStamp } from '../src/server/stamp'
import { testSite } from '../src/test'
import { parsingRoutes, routePaths } from './elysia'
import { fixtureCopy } from './scratch'
import { pages } from './shared-pages'

const PRODUCTION = 'tests/fixtures/production'
const SEO = 'tests/fixtures/seo'
// The seo fixture's routes, for the one site served from the checkout's own build.
const ROUTES = `${SEO}/src/routes`
// A rate key as `sqliteRates` stores it: a SHA-256 in base64url.
const HASHED_KEY = /^[\w-]{43}$/

function socket(address: string): Server<unknown> {
  return { requestIP: () => ({ address }) } as unknown as Server<unknown>
}

// What a post was refused with, a honeypot pretending aside.
// What a script prints, run in a process of its own, as a test file run before may have given this one a stamp secret already.
async function isolated(script: string, warned = ''): Promise<unknown> {
  const run = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()])

  expect({ code: await run.exited, err }).toEqual({ code: 0, err: warned })

  return JSON.parse(out)
}

async function refusalOf(action: Parameters<typeof protectionRefusal>[0], request: Request, body: unknown, form: boolean, server: null, plain?: boolean): Promise<ProtectionRefusal | undefined> {
  return await protectionRefusal(action, request, { body, form, server, plain }) as ProtectionRefusal | undefined
}

describe('action protection', () => {
  const FIXTURE = PRODUCTION
  // Held in a variable so tsc leaves the .kay import to Bun.
  const CONTACT = './fixtures/production/src/routes/contact.kay'
  const ENQUIRY = './fixtures/production/src/routes/enquiry.kay'
  const QUOTE = './fixtures/production/src/routes/quote.kay'

  it('leaves Elysia parsing no cookie, query or header on a page, action or API route that reads none', async () => {
    const app = await pages({ root: FIXTURE, prebuilt: false, security: false })

    expect(routePaths(app)).toEqual(expect.arrayContaining(['/contact', expect.stringMatching(/^\/_kay\/action\//), expect.stringMatching(/^\/api\//)]))
    expect(parsingRoutes(app)).toEqual([])
  })

  it('refuses a form whose honeypot is filled in, with a message on the field, the handler never running', async () => {
    const site = await testSite({ root: FIXTURE, security: false })
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
    const site = await testSite({ root: FIXTURE, security: false })
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
    const app = await pages({ root: FIXTURE, prebuilt: false, proxy: { hops: 1 } })
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
    const app = await pages({ root: FIXTURE, prebuilt: false, proxy: { hops: 1 } })
    const site = await testSite({ root: FIXTURE, security: false })
    const { enquire } = await import(ENQUIRY) as { enquire: Action<{ message: string }, number> }
    const failed = await app.handle(new Request(`http://localhost${enquire.url}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kay-action': '1', 'x-forwarded-for': '203.0.113.30' }, body: stringify({ message: 'fail' }) }))

    expect(parse(await failed.text())).toEqual({ errors: { '': 'Not sent; try again later' }, data: 'Not sent; try again later' })
    expect((await site.submit(enquire, { message: 'fail' }, { from: '/enquiry' })).html).toContain('<p id="enquire-error" class="error">Not sent; try again later</p>')
  })

  it('answers a bot the honeypot caught as if its post went through, when the action says so', async () => {
    const app = await pages({ root: FIXTURE, prebuilt: false, proxy: { hops: 1 } })
    const site = await testSite({ root: FIXTURE, security: false })
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
    const site = await testSite({ root: FIXTURE, security: false })
    const { ask } = await import(QUOTE) as { ask: Action<{ message: string }, number> }
    const start = Date.now()

    try {
      setSystemTime(start)

      const page = await site.visit('/quote')
      const stamp = page.stamp(ask)

      expect(stamp).toBeString()
      expect(page.html).toContain(`<input type="hidden" name="kay_since" value="${stamp}"><input name="message"`)

      setSystemTime(start + 1000)

      // The page's own stamp, which testSite would otherwise date back far enough to go through.
      const early = await site.submit(ask, { message: 'hello' }, { from: page, stamp })

      expect(early.html).toContain('<p class="error">422 Sent too fast; take a moment, then send it again</p>')
      // The refused page keeps the time the form first rendered at, so the visitor does not wait again from zero.
      expect(early.stamp(ask)).toBe(stamp)

      setSystemTime(start + 3000)
      expect((await site.submit(ask, { message: 'hello' }, { from: early })).html).toContain('<p class="asked">Asked 5</p>')
    }
    finally {
      setSystemTime()
    }
  })

  it('refuses a plain post sent too soon, or as expired one whose stamp is missing, forged, another action\'s or too old, in the site\'s words when it has its own, and lets a call from kay\'s script through without one', async () => {
    const site = await testSite({ root: FIXTURE, security: false })
    const { ask, quick } = await import(QUOTE) as { ask: Action<{ message: string }, number>, quick: Action<{ message: string }, number> }
    const start = Date.now()
    const refusal = async (fields: Record<string, unknown>, plain = true) => (await refusalOf(ask as never, new Request('http://localhost/'), fields, true, null, plain))?.message

    try {
      setSystemTime(start - 86_400_000 - 1000)

      const yesterday = await site.visit('/quote')
      const stale = yesterday.stamp(ask)!

      setSystemTime(start - 5000)

      const page = await site.visit('/quote')
      const own = page.stamp(ask)!
      const other = page.stamp(quick)

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
      // A stamp given to it wins over the page's, as a field or as the `stamp` option.
      expect((await site.submit(ask, { message: 'hello' }, { from: page, stamp: 'forged' })).html).toContain('<p class="error">422 This form has expired; send it again</p>')
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
    const site = await testSite({ root: FIXTURE, security: false })
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
      await pages({ root: SEO, prebuilt: false })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('NODE_ENV is unset'))
    }
    finally {
      process.env.NODE_ENV = env
      warn.mockRestore()
    }
  })

  it('warns a server started with a NODE_ENV kay does not know, naming what it runs without, and not for the three it does', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
    const env = process.env.NODE_ENV ?? 'test'
    const warned = () => warn.mock.calls.filter(([message]) => String(message).includes('which kay does not know'))

    try {
      for (const name of ['staging', 'prod', '']) {
        process.env.NODE_ENV = name
        warn.mockClear()
        await pages({ root: SEO, prebuilt: false })
        expect(warned()).toHaveLength(1)
        expect(String(warned()[0]![0])).toContain('without the production defaults')
        expect(String(warned()[0]![0])).toContain('compresses nothing')
      }

      for (const name of ['production', 'development', 'test']) {
        process.env.NODE_ENV = name
        warn.mockClear()
        await pages({ root: SEO, prebuilt: false })
        expect(warned()).toHaveLength(0)
      }
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

  it('signs with the secret of the config or KAY_SECRET, below the session and above the preview one, and refuses a short one', async () => {
    const stamps = async (script: string, env: Record<string, string> = {}) => {
      const run = Bun.spawn([process.execPath, '-e', `import { setLogSink } from ${JSON.stringify(join(import.meta.dir, '../src/runtime/log.ts'))}
import { setupStampSecret, signStamp, sharedKey, useStampSecret, warnOnStampKey } from ${JSON.stringify(join(import.meta.dir, '../src/server/stamp.ts'))}
const warnings = []
setLogSink((level, message) => warnings.push(level + ' ' + message))
warnOnStampKey(true)
${script}
console.log(JSON.stringify({ warnings, shared: sharedKey('x')?.toString('hex') }))
`], { env: { ...process.env, KAY_SECRET: '', ...env }, stdout: 'pipe', stderr: 'pipe' })
      const [out, err] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()])

      return { code: await run.exited, out, err }
    }
    const long = 'a configured secret of enough length for kay'
    const shared = async (script: string, env?: Record<string, string>) => {
      const { code, out, err } = await stamps(script, env)

      expect({ code, err }).toEqual({ code: 0, err: '' })

      return JSON.parse(out) as { warnings: string[], shared: string | undefined }
    }
    const config = await shared(`setupStampSecret(${JSON.stringify(long)}); signStamp('a', 1)`)
    const env = await shared('setupStampSecret(undefined); signStamp(\'a\', 1)', { KAY_SECRET: long })

    // No warning, and a key every replica derives alike.
    expect(config.warnings).toEqual([])
    expect(config.shared).toBeDefined()
    expect(env).toEqual(config)
    expect((await shared(`setupStampSecret(${JSON.stringify(long)}); useStampSecret('the session secret, long enough!!!!', 'session'); signStamp('a', 1)`)).shared).not.toBe(config.shared)
    expect((await shared(`useStampSecret('the session secret, long enough!!!!', 'session'); setupStampSecret(${JSON.stringify(long)}); signStamp('a', 1)`)).shared).not.toBe(config.shared)
    expect((await shared(`useStampSecret('the preview secret, long enough!!!!', 'preview'); setupStampSecret(${JSON.stringify(long)}); signStamp('a', 1)`)).shared).toBe(config.shared)
    expect((await shared(`setupStampSecret(${JSON.stringify(long)}); useStampSecret('the preview secret, long enough!!!!', 'preview'); signStamp('a', 1)`)).shared).toBe(config.shared)
    expect((await stamps('setupStampSecret("short")')).err).toContain('`secret` in kay.config.ts holds a secret 5 characters long')
    expect((await stamps('setupStampSecret(undefined)', { KAY_SECRET: 'short' })).err).toContain('KAY_SECRET holds a secret 5 characters long')
  })

  it('reaches the stamp secret from the config\'s secret and from KAY_SECRET through pages(), warning of neither', async () => {
    const long = 'a configured secret of enough length for kay'
    const script = (options: string) => `import { setLogSink } from ${JSON.stringify(join(import.meta.dir, '../src/runtime/log.ts'))}
import { pages } from ${JSON.stringify(join(import.meta.dir, '../src/server/index.ts'))}
import { sharedKey, signStamp } from ${JSON.stringify(join(import.meta.dir, '../src/server/stamp.ts'))}
const warnings = []
setLogSink((level, message) => warnings.push(level + ' ' + message))
process.env.NODE_ENV = 'production'
await pages({ root: ${JSON.stringify(join(import.meta.dir, 'fixtures/seo'))}, routes: ${JSON.stringify(join(import.meta.dir, '../', ROUTES))}, prebuilt: false${options} })
signStamp('a', 1)
console.log(JSON.stringify({ warnings, shared: sharedKey('x')?.toString('hex') }))
process.exit(0)
`
    const run = async (source: string, env: Record<string, string>) => {
      const child = Bun.spawn([process.execPath, '-e', source], { env: { ...process.env, KAY_SECRET: '', ...env }, stdout: 'pipe', stderr: 'pipe' })
      const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])

      expect({ code: await child.exited, err }).toEqual({ code: 0, err: '' })

      return JSON.parse(out) as { warnings: string[], shared: string | undefined }
    }
    const config = await run(script(`, secret: ${JSON.stringify(long)}`), {})
    const env = await run(script(''), { KAY_SECRET: long })
    // An empty `secret: process.env.KAY_SECRET` is none.
    const empty = await run(script(', secret: \'\''), { KAY_SECRET: long })

    expect(config.warnings).toEqual([])
    expect(config.shared).toBeDefined()
    expect(env).toEqual(config)
    expect(empty).toEqual(config)
  })

  it('says nothing of the key of the process under bun test, and names where the secret goes elsewhere', async () => {
    const script = (env: string) => `import { setLogSink } from ${JSON.stringify(join(import.meta.dir, '../src/runtime/log.ts'))}
import { pages } from ${JSON.stringify(join(import.meta.dir, '../src/server/index.ts'))}
import { signStamp } from ${JSON.stringify(join(import.meta.dir, '../src/server/stamp.ts'))}
const warnings = []
setLogSink((level, message) => warnings.push(level + ' ' + message))
process.env.NODE_ENV = ${JSON.stringify(env)}
await pages({ root: ${JSON.stringify(join(import.meta.dir, 'fixtures/seo'))}, routes: ${JSON.stringify(join(import.meta.dir, '../', ROUTES))}, prebuilt: false })
signStamp('a', 1)
console.log(JSON.stringify(warnings))
process.exit(0)
`
    const test = await isolated(script('test')) as string[]
    const production = await isolated(script('production')) as string[]

    expect(test).toEqual([])
    expect(production.filter(line => line.includes('signed with a key of this process'))).toHaveLength(1)
    expect(production.join('\n')).toContain('set KAY_SECRET')
  })

  it('lets a client post as often as the limit allows in a window, then answers 429 with when to retry', async () => {
    const app = await pages({ root: FIXTURE, prebuilt: false, proxy: { hops: 1 } })
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
    const app = await pages({ root: FIXTURE, prebuilt: false, site: 'https://shop.example', proxy: { hops: 1 } })
    const { send } = await import(CONTACT) as { send: Action<{ message: string }, number> }
    const call = async (origin: string) => app.handle(new Request(`http://127.0.0.1:3000${send.url}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kay-action': '1', 'x-forwarded-for': '203.0.113.60', origin }, body: stringify({ message: 'hi' }) }))

    expect((await call('https://shop.example')).status).toBe(200)
    expect((await call('https://evil.example')).status).toBe(403)
  })

  it('refuses in the messages the action gives, in place of kay\'s English', async () => {
    const app = await pages({ root: FIXTURE, prebuilt: false, proxy: { hops: 1 } })
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

  it('opens a shared SQLite file in WAL without a disk sync per commit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-sqlite-'))

    try {
      const db = openSqlite(join(dir, 'shared.sqlite'))

      expect([db.query('PRAGMA journal_mode').get(), db.query('PRAGMA synchronous').get()]).toEqual([{ journal_mode: 'wal' }, { synchronous: 1 }])
      db.close()
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('never stores a rate key as a plain hash of its input, with no secret, a secret or a restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-rates-'))
    const script = `import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { sqliteRates } from ${JSON.stringify(join(import.meta.dir, '../src/server/protection.ts'))}
import { useStampSecret } from ${JSON.stringify(join(import.meta.dir, '../src/server/stamp.ts'))}
const path = ${JSON.stringify(join(dir, 'rates.sqlite'))}
const inputs = ['203.0.113.7', 'ada@example.com', 'login\\nkey:ada@example.com', 'login\\n203.0.113.7']
const sha = (...parts) => { const hasher = new Bun.CryptoHasher('sha256'); for (const part of parts) hasher.update(part); return hasher.digest('base64url') }
const first = sqliteRates(path)
const hits = []
for (const input of inputs) hits.push(first.hit(input, '60000ms').count)
// A restart within the window: a new store on the same file counts on.
const second = sqliteRates(path)
for (const input of inputs) hits.push(second.hit(input, '60000ms').count)
const noSecret = new Set(new Database(path).query('SELECT key FROM kay_rates').all().map(row => row.key))
const keyFile = readFileSync(path + '.key', 'utf8')
const guesses = inputs.flatMap(input => [sha(input), sha(keyFile, input), sha(Buffer.from(keyFile, 'base64url'), input)])
const plain = guesses.filter(guess => noSecret.has(guess)).length
useStampSecret('a session secret, long enough too', 'session')
second.hit('after', '60000ms')
const withSecret = new Set(new Database(path).query('SELECT key FROM kay_rates').all().map(row => row.key))
const hasSalt = new Database(path).query("SELECT name FROM sqlite_master WHERE name = 'kay_rates_salt'").all().length
console.log(JSON.stringify({ hits, plain, size: noSecret.size, after: withSecret.size, plainAfter: withSecret.has(sha('after')), hasSalt }))
`

    try {
      expect(await isolated(script)).toEqual({ hits: [1, 1, 1, 1, 2, 2, 2, 2], plain: 0, size: 4, after: 5, plainAfter: false, hasSalt: 0 })
      expect((await stat(join(dir, 'rates.sqlite.key'))).mode & 0o777).toBe(0o600)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('shares one key file between processes opening a store at once, and between restarts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-rates-'))
    const path = join(dir, 'rates.sqlite')
    const script = `import { sqliteRates } from ${JSON.stringify(join(import.meta.dir, '../src/server/protection.ts'))}
const store = sqliteRates(${JSON.stringify(path)})
console.log(JSON.stringify(store.hit('203.0.113.7', '60000ms').count))
`

    try {
      const counts = await Promise.all(Array.from({ length: 6 }, async () => isolated(script)))

      // Six processes with six different keys would each count 1.
      expect((counts as number[]).toSorted()).toEqual([1, 2, 3, 4, 5, 6])
      expect(await isolated(script)).toBe(7)
      expect((await readdir(dir)).filter(name => name.includes('.key'))).toEqual(['rates.sqlite.key'])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('replaces a key file holding no key, once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-rates-'))
    const path = join(dir, 'rates.sqlite')

    try {
      await Bun.write(`${path}.key`, 'short')
      // In a process of its own, as a file run before in this one may have set the app's secret, which leaves the key file alone.
      expect(await isolated(`import { sqliteRates } from ${JSON.stringify(join(import.meta.dir, '../src/server/protection.ts'))}
console.log(JSON.stringify(sqliteRates(${JSON.stringify(path)}).hit('a', '60000ms').count))
`, `[kay] ${path}.key held no rate-limit key and was replaced\n`)).toBe(1)
      expect((await Bun.file(`${path}.key`).text()).length).toBe(43)
      expect((await readdir(dir)).filter(name => name.includes('.key'))).toEqual(['rates.sqlite.key'])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('makes no key file while the app\'s secret is set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-rates-'))
    const script = `import { sqliteRates } from ${JSON.stringify(join(import.meta.dir, '../src/server/protection.ts'))}
import { useStampSecret } from ${JSON.stringify(join(import.meta.dir, '../src/server/stamp.ts'))}
useStampSecret('a session secret, long enough too', 'session')
const store = sqliteRates(${JSON.stringify(join(dir, 'rates.sqlite'))})
store.hit('ada@example.com', '60000ms')
console.log(JSON.stringify(store.hit('ada@example.com', '60000ms').count))
`

    try {
      expect(await isolated(script)).toBe(2)
      expect(await readdir(dir)).not.toContain('rates.sqlite.key')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.each([
    ['a window it cannot read', { max: 1, window: 'soon' as never }, 'kay: rateLimit.window is \'soon\'; it takes a positive duration'],
    ['a store without peek on a limit counting successes', [{ max: 1, window: '1m' }, { max: 1, window: '1m', count: 'succeeded', store: { hit: () => ({ count: 1, resetAt: 0 }) } }] as never, 'needs a peek(key) method'],
  ])('refuses %s as the action is declared', (_name, rateLimit, message) => {
    expect(() => action(t.Object({}), () => 1, { protect: { rateLimit } })).toThrow(message)
  })

  it.each([
    ['2001:db8:0:1:aaaa::1', '2001:db8:0:1::/64'],
    ['2001:0db8:0000:0001:ffff:ffff:ffff:ffff', '2001:db8:0:1::/64'],
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '::ffff:203.0.113.7'],
  ])('counts the client %s as %s, an IPv6 one by its /64 so rotating addresses inside it buys nothing', (address, key) => {
    expect(rateKey(address)).toBe(key)
  })

  const behind = new Request('http://localhost/', { headers: { 'x-forwarded-for': '1.1.1.1, 203.0.113.7, 172.70.1.1', 'cf-connecting-ip': '203.0.113.7' } })
  const skipped = new Request('http://localhost/', { headers: { 'x-forwarded-for': '203.0.113.8' } })

  it.each([
    ['one hop', behind, '127.0.0.1', { hops: 1 }, '172.70.1.1'],
    ['two hops, the peer written as IPv6', behind, '::ffff:172.18.0.1', { hops: 2 }, '203.0.113.7'],
    ['a header', behind, '100.101.1.1', { header: 'cf-connecting-ip' }, '203.0.113.7'],
    // A request that skipped the outer proxy carries what the inner one appended, who reached it.
    ['two hops over a request that skipped the outer proxy', skipped, '10.0.0.2', { hops: 2 }, '203.0.113.8'],
    // `true` is one proxy and a number that many.
    ['true', behind, '127.0.0.1', true as const, '172.70.1.1'],
    ['a number', behind, '127.0.0.1', 2, '203.0.113.7'],
    // A client reaching the server itself forges nothing, whatever the setting.
    ['a client reaching the server itself', behind, '198.51.100.9', { hops: 2 }, '198.51.100.9'],
  ])('takes the address the trusted proxies passed on, never one the client wrote before them: %s', (_name, request, peer, proxy, address) => {
    expect(clientAddress(request, socket(peer), proxy)).toBe(address)
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
      const app = new Elysia().use(await pages({ root: FIXTURE, prebuilt: false, proxy })).get('/whoami', ({ request, server }) => clientAddress(request, server))

      return (await app.handle(new Request('http://localhost/whoami', { headers: { 'x-forwarded-for': '203.0.113.7' } }))).text()
    }

    expect(await whoami({ hops: 1 })).toBe('203.0.113.7')
    expect(await whoami()).toBe('unknown')
  })

  it('refuses a proxy setting it cannot read, as the server boots', async () => {
    // One through `pages()`, which reads it as the server boots; the rest where it is read, as setting the routes up costs half a second each, which a busy host multiplies.
    await expect(pages({ root: FIXTURE, prebuilt: false, proxy: {} })).rejects.toThrow('kay: proxy')
  })

  it.each([
    [{ hops: 1, header: 'x-real-ip' }],
    [{ hops: 0 }],
    [{ hops: 1.5 }],
    [0],
    [1.5],
    [{ header: ' ' }],
    [{ hops: 1, trusted: ['a CDN'] }],
    [{ hops: 1, trusted: ['10.0.0.0/33'] }],
    [{ hops: 1, trusted: ['::/129'] }],
  ])('refuses the proxy setting %p where it is read', (proxy) => {
    expect(() => trustProxy(new Elysia(), proxy)).toThrow('kay: proxy')
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
  }, 30_000)
})

describe('request body limits', () => {
  const FIXTURE = PRODUCTION
  // Held in a variable so tsc leaves the .kay import to Bun.
  const NOTES = './fixtures/production/src/routes/notes.kay'
  const MB = 1024 * 1024
  const serve = async (maxSize?: ByteSize) => pages({ root: FIXTURE, prebuilt: false, maxSize })
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
    const site = await testSite({ root: FIXTURE, security: false, maxSize: 64 * 1024 })
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

  it('reads the limit as a size, in the config, an action and an API module', async () => {
    const app = await serve('1mb')
    const post = async (size: number) => app.handle(new Request('http://localhost/api/echo', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: chunked(size) }))
    const site = await testSite({ root: FIXTURE, security: false, maxSize: '64kb' })
    const { note } = await import(NOTES) as { note: Action<{ text: string }, number> }

    expect((await post(2 * MB)).status).toBe(413)
    expect(await (await post(MB)).text()).toBe(String(MB))
    expect((await site.submit(note, { text: 'a'.repeat(65 * 1024) }, { from: '/notes' })).html).toContain('413 Too large to send; 64 KB at most')
    expect((await site.submit(note, { text: 'hello' }, { from: '/notes' })).html).toContain('<p class="sent">Sent 5</p>')
  })

  it('still takes the config\'s bodyLimit, the old name of maxSize', async () => {
    const site = await testSite({ root: FIXTURE, security: false, bodyLimit: '64kb' })
    const { note } = await import(NOTES) as { note: Action<{ text: string }, number> }

    expect((await site.submit(note, { text: 'a'.repeat(65 * 1024) }, { from: '/notes' })).html).toContain('413 Too large to send; 64 KB at most')
  })

  it.each([0, -1, 1.5, '0kb', '-1kb', '1.5b', '1gb', 'big', ''])('refuses a limit of %p, as the server boots', async (maxSize) => {
    await expect(serve(maxSize as ByteSize)).rejects.toThrow('kay: maxSize')
  })
})
