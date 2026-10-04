import type { ClientBuild } from '../src/server/client'
import { join } from 'node:path'
import process from 'node:process'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { child } from '../src/runtime/html'
import { island } from '../src/runtime/island.server'
import { checkForm } from '../src/runtime/validate'
import { servePages } from '../src/server/app'

const routes = 'tests/fixtures/navigation/src/routes'
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
})
