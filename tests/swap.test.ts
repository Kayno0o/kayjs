import type { ClientBuild } from '../src/server/client'
import { join } from 'node:path'
import process from 'node:process'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { t, ValidationError } from 'elysia'
import { context } from '../src/runtime'
import { action } from '../src/runtime/action'
import { hydrateIslands } from '../src/runtime/client'
import { formInput } from '../src/runtime/form'
import { child, component } from '../src/runtime/html'
import { island } from '../src/runtime/island.server'
import { checkForm } from '../src/runtime/validate'
import { encodeValue } from '../src/runtime/wire'
import { servePages } from '../src/server/app'
import { BrowserError } from '../src/server/errors'
import { formsScript } from '../src/server/forms'
import { renderStatic } from '../src/server/stream'

const routes = 'tests/fixtures/navigation/src/routes'
// The field an issue of the server's validation is about, as it reads it.
const FIELD = /^\/([^/]*)/
const FORMS = /<script type="application\/json" data-kay-forms>(.*?)<\/script>/
const client: ClientBuild = { entry: '/_kay/entry.js', entryImports: [], islands: {}, styles: new Map(), pages: new Map(), dir: join(process.cwd(), '.kay', 'client', 'dist'), navigation: true }
const app = await servePages(process.cwd(), { routes, security: false }, async () => client)

async function html(path: string): Promise<string> {
  return (await app.handle(new Request(`http://localhost${path}`))).text()
}

describe('page swap, on the server', () => {
  it('ships the entry to pages with islands or with forms posting to actions, nothing to the others', async () => {
    const plain = await html('/plain')
    const second = await html('/second')

    expect(plain).toContain('<script type="module" src="/_kay/entry.js">')
    expect(second).toContain('<script type="module" src="/_kay/entry.js">')
    expect(JSON.parse(FORMS.exec(second)![1]!)).toEqual({ '/_kay/action/tests/fixtures/navigation/src/routes/second.kay/add': { properties: { title: { type: 'string', minLength: 3, error: 'Too short' } }, required: ['title'] } })

    const bare = await servePages(process.cwd(), { routes: 'tests/fixtures/bare/src/routes', security: false }, async () => client)

    expect(await (await bare.handle(new Request('http://localhost/'))).text()).not.toContain('<script type="module"')
  })

  it('tells a form the swap posts where to go in a header, which XMLHttpRequest would not follow', async () => {
    const form = new FormData()

    form.set('title', 'ab')

    const response = await app.handle(new Request('http://localhost/_kay/action/tests/fixtures/navigation/src/routes/second.kay/add', { method: 'POST', headers: { 'origin': 'http://localhost', 'referer': 'http://localhost/second', 'x-kay-navigate': '1' }, body: form }))

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('x-kay-redirect')).toBe('http://localhost/second')
  })

  it('renders one state for the islands of a page, kept per request, a persisted one read from the request\'s cookie', async () => {
    expect(await html('/state')).toContain('<p class="total">Total <!--[-->5<!--]--></p>')
    expect(await html('/alone')).toContain('<p class="total">Total <!--[-->0<!--]--></p>')
    expect(await html('/alone')).toContain('Theme <!--[-->light<!--]-->')

    const dark = await app.handle(new Request('http://localhost/alone', { headers: { cookie: `theme=${encodeURIComponent(encodeValue('dark'))}` } }))

    expect(await dark.text()).toContain('Theme <!--[-->dark<!--]-->')
    expect(await html('/alone')).toContain('Theme <!--[-->light<!--]-->')
  })

  it('renders a try block\'s catch block when it throws, the error reported, marked for hydration to keep', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const caught: unknown[] = []
    const reporting = await servePages(process.cwd(), { routes, security: false, onError: error => void caught.push(error) }, async () => client)
    const page = await (await reporting.handle(new Request('http://localhost/fallback'))).text()

    logged.mockRestore()

    expect(page).toContain('<!--kay-failed--><p class="unavailable">Unavailable</p>')
    expect(page).toContain('<p class="fragile">Fine</p>')
    expect(caught.map(error => (error as Error).message)).toEqual(['Broken on the server'])
  })

  it('hands what a browser reports to onError, refusing another site\'s, a malformed one and a flood', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const caught: unknown[] = []
    const reporting = await servePages(process.cwd(), { routes, security: false, onError: error => void caught.push(error) }, async () => client)
    const report = async (body: string, headers: Record<string, string> = {}) => (await reporting.handle(new Request('http://localhost/_kay/error', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }))).status
    const sent = JSON.stringify({ name: 'TypeError', message: 'x is undefined', stack: 'TypeError: x is undefined\n    at chunk.js:1:2', url: 'http://localhost/fallback' })

    expect(await report(sent, { origin: 'http://localhost' })).toBe(204)
    expect(caught).toHaveLength(1)
    expect(caught[0]).toBeInstanceOf(BrowserError)
    expect(caught[0]).toMatchObject({ kind: 'TypeError', message: 'x is undefined', url: 'http://localhost/fallback' })
    expect(await report(sent, { origin: 'https://evil.example' })).toBe(403)
    expect(await report('{"message":1}')).toBe(400)

    const statuses = await Promise.all(Array.from({ length: 25 }, async () => report(sent)))

    expect(statuses).toContain(429)
    logged.mockRestore()
  })

  it('hands what a component provides to what it renders, and to nothing beside it', async () => {
    const page = await html('/tone')

    expect(page).toContain('<section class="box"><!--[--><p class="tone">loud</p><!--]-->')
    expect(page).toMatch(/<\/slot><p class="tone">plain<\/p>/)
  })

  it('lets a layout provide to its page, and a component to what it renders only', () => {
    const Tone = context('plain')
    const Label = () => ({ t: Tone.use() })
    const Layout = (props: { children: unknown }) => {
      Tone.provide('layout')

      return { t: child(props.children) }
    }
    const markup = renderStatic(() => [component(Layout, { get children() {
      return component(Label, {})
    } }), component(Label, {})]).html

    expect(markup).toBe('layoutplain')
  })

  it('marks an island kept across navigations, under its component or a key of its own', () => {
    const Player = island('player.kay', () => ({ t: '<button>Play</button>' }) as never)

    expect(child(Player({ persist: true }))).toContain('<slot data-component="player.kay" data-props="[{}]" data-persist="player.kay">')
    expect(child(Player({ persist: 'radio' }))).toContain('data-persist="radio"')
    expect(child(Player({}))).not.toContain('data-persist')
  })
})

describe('page swap, checking a form in the browser', () => {
  beforeAll(() => GlobalRegistrator.register())
  afterAll(async () => GlobalRegistrator.unregister())

  function form(fields: string, rules: object): HTMLFormElement {
    document.head.innerHTML = `<script type="application/json" data-kay-forms>${JSON.stringify({ '/act': rules })}</script>`
    document.body.innerHTML = `<form>${fields}</form>`

    return document.querySelector('form')!
  }

  function messages(element: HTMLFormElement): Record<string, string> {
    return Object.fromEntries([...element.querySelectorAll('input')].map(input => [input.name, input.validationMessage]))
  }

  it('gives each refused field the message the server would', () => {
    const checked = form('<input name="title" value="ab"><input name="count" value="0"><input name="code" value="A1"><input name="age" value="x">', {
      properties: {
        title: { type: 'string', minLength: 3 },
        count: { minimum: 1, anyOf: [{ format: 'integer', type: 'string' }, { minimum: 1, type: 'integer' }] },
        code: { type: 'string', pattern: '^[a-z]+$', error: 'Lower case letters only' },
        age: { type: 'number', maximum: 120 },
      },
      required: ['title', 'count', 'code', 'age'],
    })

    expect(checkForm(checked, '/act')).toBe(false)
    expect(messages(checked)).toEqual({
      title: 'Expected string length greater or equal to 3',
      count: 'Property \'count\' should be one of: \'integer\', \'integer\'',
      code: 'Lower case letters only',
      age: 'Expected number',
    })
  })

  it('lets a valid form post, a blank optional field read as left out', () => {
    const checked = form('<input name="title" value="abc"><input name="age" value="">', {
      properties: { title: { type: 'string', minLength: 3 }, age: { type: 'number', maximum: 120 } },
      required: ['title'],
    })

    expect(checkForm(checked, '/act')).toBe(true)
    expect(messages(checked)).toEqual({ title: '', age: '' })
  })

  it('leaves a form to the server when the page holds no schema for its action', () => {
    expect(checkForm(form('<input name="title" value="">', { properties: {}, required: [] }), '/other')).toBe(true)
  })

  it('refuses each field with the very message the server gives it', () => {
    const schema = t.Object({
      short: t.String({ minLength: 3 }),
      long: t.String({ maxLength: 2 }),
      word: t.String({ pattern: '^[a-z]+$' }),
      mail: t.String({ format: 'email' }),
      id: t.String({ format: 'uuid' }),
      count: t.Integer({ minimum: 1 }),
      amount: t.Numeric({ exclusiveMaximum: 10 }),
      ratio: t.Number({ maximum: 1 }),
      kind: t.Literal('a'),
      tags: t.Array(t.String({ minLength: 2, error: 'Tag too short' })),
      sizes: t.Array(t.Integer(), { minItems: 3 }),
      named: t.String({ minLength: 5, error: 'Five letters at least' }),
    })
    const posted: [string, string][] = [['short', 'ab'], ['long', 'abc'], ['word', 'A1'], ['mail', 'nope'], ['id', '123'], ['count', '1.5'], ['amount', '10'], ['ratio', 'x'], ['kind', 'b'], ['tags', 'ok'], ['tags', 'x'], ['sizes', '1'], ['named', 'abc']]
    const submitted = action(schema, () => undefined)

    ;(submitted as { url: string }).url = '/act'
    document.head.innerHTML = formsScript(new Set([submitted]))
    document.body.innerHTML = `<form>${posted.map(([name, value]) => `<input name="${name}" value="${value}">`).join('')}</form>`

    const element = document.querySelector('form')!
    const body: Record<string, unknown> = {}

    for (const [name, value] of posted)
      body[name] = name in body ? [body[name]].flat().concat(value) : value

    const server: Record<string, string> = {}

    for (const issue of new ValidationError('body', schema, formInput(schema, body)).all) {
      const field = 'path' in issue ? FIELD.exec(issue.path)?.[1] ?? '' : ''
      const custom = 'schema' in issue ? (issue.schema as { error?: unknown }).error : undefined

      server[field] ??= typeof custom === 'string' ? custom : issue.summary!
    }

    expect(checkForm(element, '/act')).toBe(false)
    expect(Object.keys(server).sort()).toEqual([...new Set(posted.map(([name]) => name))].sort())

    for (const name of Object.keys(server))
      expect([name, element.querySelector<HTMLInputElement>(`input[name="${name}"]`)!.validationMessage]).toEqual([name, server[name]!])
  })

  it('leaves alone an island a swap took away while its chunk loaded', async () => {
    let rendered = false
    let release!: () => void
    const loaded = new Promise<void>(resolve => (release = resolve))

    document.body.innerHTML = '<slot data-component="late.kay" data-props="[{}]"></slot>'

    const hydrating = hydrateIslands({
      'late.kay': async () => {
        await loaded

        return { default: () => (rendered = true) }
      },
    })

    document.body.innerHTML = ''
    release()
    await hydrating

    expect(rendered).toBe(false)
  })
})
