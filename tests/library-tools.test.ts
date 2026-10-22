import type { ToolResult } from 'kay/library'
import type { Action } from '../src/runtime'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { actionTool, currentRequest } from 'kay/library'
import { pages } from 'kay/server'
import { encodeValue } from '../src/runtime/wire'
import { testSite } from '../src/test'

const locals = (request: Request) => ({ key: request.headers.get('authorization') === 'Bearer open' ? 'open' : undefined })

// No `mcp`: a library calls actions as tools in-process whether or not the app serves the endpoint.
const site = await testSite({ root: 'tests/fixtures/library-tools', islands: false, locals })
const mounted = await testSite({ root: 'tests/fixtures/library-tools', islands: false, base: '/shop', trailingSlash: 'always', locals })
const localized = await testSite({ root: 'tests/fixtures/library-tools', islands: false, i18n: { locales: ['fr', 'en'], defaultLocale: 'fr', messages: resolve('tests/fixtures/i18n/src/messages') } })

// Imported once a site loads `.kay` modules.
const { current, later, names, recorded, run, shape, unregistered } = await import(join(import.meta.dir, 'fixtures/library-tools/src/routes/index.kay')) as { current: Action<Record<never, never>, string | null>, later: Action<Record<never, never>, undefined>, names: Action<Record<never, never>, string[]>, recorded: Action<Record<never, never>, string | null | undefined>, unregistered: Action<Record<never, never>, string>, run: Action<{ name: string, args: Record<string, unknown> }, ToolResult>, shape: Action<{ name: string }, Record<string, unknown> | undefined> }
const { addNote } = await import(join(import.meta.dir, 'fixtures/library-tools/src/routes/targets/_actions.kay')) as { addNote: Parameters<typeof actionTool>[0] }

afterAll(async () => {
  await Promise.all([site.close(), mounted.close(), localized.close()])
})

async function call(name: string, args: Record<string, unknown> = {}, target = site, headers: Record<string, string> = {}): Promise<ToolResult> {
  return target.call(run, { name, args }, { headers })
}

function text(result: ToolResult): string {
  return (result.content[0] as { text: string }).text
}

describe('an action as a tool', () => {
  it('is named after its export and described from its schema', async () => {
    expect(await site.call(shape, { name: 'addNote' })).toEqual({
      name: 'add_note',
      description: 'Add note',
      inputSchema: { type: 'object', properties: { title: { type: 'string', minLength: 3, error: 'Too short' }, pinned: { type: 'boolean' } }, required: ['title'] },
    })
  })

  it('takes the name and description its tool option sets', async () => {
    expect(await site.call(shape, { name: 'described' })).toMatchObject({ name: 'described', description: 'Says it was described' })
    expect(await site.call(shape, { name: 'named' })).toMatchObject({ name: 'Say_Hello', description: 'Says hello' })
  })

  it('is none for an action taking a file, one of a page with params and one that set tool: false', async () => {
    expect(await site.call(shape, { name: 'upload' })).toBeUndefined()
    expect(await site.call(shape, { name: 'rename' })).toBeUndefined()
    expect(await site.call(shape, { name: 'vetoed' })).toBeUndefined()
  })

  it('refuses an action no page module exports, as no URL serves it, every time', async () => {
    expect(await site.call(unregistered)).toContain('actionTool()')
    expect(await site.call(unregistered)).toContain('actionTool()')
  })

  it('names an action once per set of names a library keeps', async () => {
    expect(await site.call(names)).toEqual(['add_note', 'add_note_2', 'add_note'])
  })

  it('takes the call an api({ cors }) module let in from another site', async () => {
    const response = await site.fetch('/api/partner', { headers: { 'origin': 'https://partner.example', 'sec-fetch-site': 'cross-site' } })

    expect(((await response.json()) as ToolResult).structuredContent).toMatchObject({ title: 'Milk' })
  })

  it('refuses a call for a request a browser sent from another site, whatever its method', async () => {
    const read = async (headers: Record<string, string>) => ((await (await site.fetch('/api/current/tool', { headers })).json()) as ToolResult)

    expect((await read({ 'origin': 'https://evil.example', 'sec-fetch-site': 'cross-site' })).isError).toBe(true)
    expect((await read({ 'sec-fetch-site': 'cross-site' })).isError).toBe(true)
    expect((await read({ 'sec-fetch-site': 'same-origin' })).structuredContent).toMatchObject({ title: 'Milk' })
  })

  it('returns what the handler returned', async () => {
    const result = await call('addNote', { title: 'Milk' })

    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toEqual({ id: 1, title: 'Milk', at: '1970-01-01T00:00:00.000Z' })
  })

  it('answers the fields a schema refused, so the model can correct and call again', async () => {
    const result = await call('addNote', { title: 'x' })

    expect(result.isError).toBe(true)
    expect(JSON.parse(text(result))).toEqual({ status: 422, errors: { title: 'Too short' } })
  })

  it('answers what the handler passed to ctx.fail, a redirect and a throw as errors', async () => {
    expect(JSON.parse(text(await call('refuses')))).toEqual({ status: 409, errors: {}, data: { reason: 'full' } })
    expect(text(await call('sendsAway'))).toContain('/done')

    const broken = await call('breaks')

    expect(broken.isError).toBe(true)
    expect(text(broken)).not.toContain('boom')
  })

  it('runs as the visitor, behind the guards of its directory', async () => {
    const anonymous = await call('wipe', { confirm: true })

    expect(anonymous.isError).toBe(true)
    expect(text(anonymous)).toBe('Sign in')
    expect((await call('wipe', { confirm: true }, site, { authorization: 'Bearer open' })).structuredContent).toEqual({ by: 'open' })
  })

  it('counts the rate limit by the visitor, and skips what only a form a person filled in passes', async () => {
    const calls = [await call('signup', { email: 'a@b.example' }), await call('signup', { email: 'a@b.example' }), await call('signup', { email: 'a@b.example' })]

    expect(calls.map(each => each.isError ?? false)).toEqual([false, false, true])
    expect((JSON.parse(text(calls[2]!)) as { status: number }).status).toBe(429)
    expect(text(await call('solve'))).toBe('solved')
  })

  it('asks the proof of work of the same action posted with a forged marker header', async () => {
    const url = '/_kay/action/src/routes/targets/_actions.kay/solve'
    const headers = { 'content-type': 'application/json', 'x-kay-action': '1', 'origin': 'http://localhost', 'x-kay-agent': 'guess', 'x-kay-agent-client': '1.2.3.4', 'x-kay-agent-tool': 'solve' }

    expect((await site.fetch(url, { method: 'POST', headers, body: encodeValue({}) })).status).toBe(422)
  })

  it('runs under a base, a trailing slash and in the visitor\'s locale', async () => {
    expect((await call('addNote', { title: 'Milk' }, mounted)).structuredContent).toMatchObject({ title: 'Milk' })
    expect((await call('language', {}, localized, { 'accept-language': 'en' })).structuredContent).toEqual({ locale: 'en' })
  })

  it('runs in the locale of the page the visitor is on, over their Accept-Language', async () => {
    const result = await localized.call(run, { name: 'language', args: {} }, { from: '/en/', headers: { 'accept-language': 'fr' } })

    expect(result.structuredContent).toEqual({ locale: 'en' })
  })

  it('keeps two visitors calling at once apart', async () => {
    const [open, anonymous] = await Promise.all([call('wipe', { confirm: true }, site, { authorization: 'Bearer open' }), call('wipe', { confirm: true })])

    expect(open.structuredContent).toEqual({ by: 'open' })
    expect(anonymous.isError).toBe(true)
  })

  it('counts the rate limit by the visitor, whatever client header the request forges', async () => {
    const forged = async () => call('limited', {}, site, { 'x-kay-agent-client': crypto.randomUUID() })
    const calls = [await forged(), await forged(), await forged()]

    expect(calls.map(each => each.isError ?? false)).toEqual([false, false, true])
  })

  it('refuses a call made outside any request, naming the way out', async () => {
    await expect(actionTool(addNote)!.call({ title: 'Milk' })).rejects.toThrow('request')
  })
})

describe('the current request', () => {
  it('is the request a page and an action answer', async () => {
    expect((await site.visit('/')).html).toContain('http://localhost/')
    expect(await site.call(current)).toContain('/_kay/action/')
  })

  it('is none in an API route, whose handler passes its own request to a tool', async () => {
    expect(await (await site.fetch('/api/current')).json()).toEqual({ url: null })

    const response = await site.fetch('/api/current/tool', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Milk' }) })

    expect(((await response.json()) as ToolResult).structuredContent).toMatchObject({ title: 'Milk' })
  })

  it('is none once the answer is made', async () => {
    await site.call(later)
    await Bun.sleep(30)
    expect(await site.call(recorded)).toBeNull()
  })

  it('is none outside a request', () => {
    expect(currentRequest()).toBeUndefined()
  })
})

describe('a tool call with no server, as under app.handle()', () => {
  // Each app has its own default locale, which a tool call runs in, so a call dispatched into the wrong app shows.
  async function build(locales: string[]) {
    return new Elysia().use(await pages({ root: 'tests/fixtures/library-tools', prebuilt: false, security: false, i18n: { locales, defaultLocale: locales[0]!, messages: resolve('tests/fixtures/i18n/src/messages') } }))
  }

  it('runs in the app answering the request, whichever app was built last', async () => {
    const french = await build(['fr', 'en'])
    const english = await build(['en', 'fr'])
    const language = async (app: Elysia) => ((await (await app.handle(new Request('http://localhost/api/current/language', { headers: { 'sec-fetch-site': 'same-origin' } }))).json()) as ToolResult).structuredContent
    const [inFrench, inEnglish] = await Promise.all([language(french), language(english)])

    expect(inFrench).toEqual({ locale: 'fr' })
    expect(inEnglish).toEqual({ locale: 'en' })
  })
})
