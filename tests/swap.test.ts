import type { ClientBuild } from '../src/server/client'
import process from 'node:process'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it, setSystemTime, spyOn } from 'bun:test'
import { t, ValidationError } from 'elysia'
import { clientDir } from '../src/build/assets'
import { resolveProject } from '../src/project'
import { navigate, persisted, signal } from '../src/runtime'
import { action } from '../src/runtime/action'
import { hydrateIslands } from '../src/runtime/client'
import { attempt, hydrate, HydrationMismatch } from '../src/runtime/dom'
import { formInput } from '../src/runtime/form'
import { child } from '../src/runtime/html'
import { island } from '../src/runtime/island.server'
import { pageData } from '../src/runtime/page-data'
import { createSignal } from '../src/runtime/reactive'
import { checkForm } from '../src/runtime/validate'
import { encodeValue } from '../src/runtime/wire'
import { servePages } from '../src/server/app'
import { BrowserError } from '../src/server/errors'
import { formsScript } from '../src/server/forms'
import { inServerScope } from '../src/server/scope'

const routes = 'tests/fixtures/navigation/src/routes'
// The field an issue of the server's validation is about, as it reads it.
const FIELD = /^\/([^/]*)/
// Made at module level, as an app's shared state is.
const shared = createSignal('default')
const FORMS = /<script type="application\/json" data-kay-forms>(.*?)<\/script>/
const client: ClientBuild = { entry: '/_kay/entry.js', entryImports: [], islands: {}, styles: new Map(), pages: new Map(), dir: clientDir(process.cwd()), navigation: true }
const app = await servePages(resolveProject(process.cwd(), { routes, security: false }), async () => client)

async function html(path: string): Promise<string> {
  return (await app.handle(new Request(`http://localhost${path}`))).text()
}

describe('page swap, on the server', () => {
  it('ships the entry to pages with islands or with forms posting to actions, nothing to the others', async () => {
    const plain = await html('/plain')
    const second = await html('/second')

    expect(plain).toContain('<script type="module" src="/_kay/entry.js">')
    expect(second).toContain('<script type="module" src="/_kay/entry.js">')
    expect(JSON.parse(FORMS.exec(second)![1]!)).toEqual({ '/_kay/action/tests/fixtures/navigation/src/routes/second.kay/add': { properties: { title: { type: 'string', maxLength: 200, minLength: 3, error: 'Too short' } }, required: ['title'] } })

    const bare = await servePages(resolveProject(process.cwd(), { routes: 'tests/fixtures/bare/src/routes', security: false }), async () => client)

    expect(await (await bare.handle(new Request('http://localhost/'))).text()).not.toContain('<script type="module"')
  })

  it('tells a form the swap posts where to go in a header, which XMLHttpRequest would not follow, and marks the page a refused one renders', async () => {
    const post = async (title: string) => {
      const form = new FormData()

      form.set('title', title)

      return app.handle(new Request('http://localhost/_kay/action/tests/fixtures/navigation/src/routes/second.kay/add', { method: 'POST', headers: { 'origin': 'http://localhost', 'referer': 'http://localhost/second', 'x-kay-navigate': '1' }, body: form }))
    }
    const added = await post('Swapped')
    const refused = await post('ab')

    expect(added.status).toBe(303)
    expect(added.headers.get('location')).toBeNull()
    expect(added.headers.get('x-kay-redirect')).toBe('http://localhost/second')
    expect(refused.status).toBe(422)
    expect(refused.headers.get('x-kay-redirect')).toBeNull()
    expect(refused.headers.get('x-kay-failure')).toBe('1')
    expect(await refused.text()).toContain('Too short')
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
    const reporting = await servePages(resolveProject(process.cwd(), { routes, security: false, onError: error => void caught.push(error) }), async () => client)
    const page = await (await reporting.handle(new Request('http://localhost/fallback'))).text()

    logged.mockRestore()

    expect(page).toContain('<!--kay-failed--><p class="unavailable">Unavailable</p>')
    expect(page).toContain('<p class="fragile">Fine</p>')
    expect(caught.map(error => (error as Error).message)).toEqual(['Broken on the server'])
  })

  it('hands what a browser reports to onError, refusing another site\'s, a malformed one and a flood, and dropping control characters', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const caught: unknown[] = []
    const reporting = await servePages(resolveProject(process.cwd(), { routes, security: false, onError: error => void caught.push(error) }), async () => client)
    const report = async (body: string, headers: Record<string, string> = {}) => (await reporting.handle(new Request('http://localhost/_kay/error', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }))).status
    const sent = JSON.stringify({ name: 'TypeError', message: 'x is undefined', stack: 'TypeError: x is undefined\n    at chunk.js:1:2', url: 'http://localhost/fallback' })

    expect(await report(sent, { origin: 'http://localhost' })).toBe(204)
    expect(caught).toHaveLength(1)
    expect(caught[0]).toBeInstanceOf(BrowserError)
    expect(caught[0]).toMatchObject({ kind: 'TypeError', message: 'x is undefined', url: 'http://localhost/fallback', stack: 'TypeError: x is undefined\n    at chunk.js:1:2' })
    // A forged log line, a terminal escape or a bidi override goes in as plain text, the stack keeping its line breaks with every line but its header indented.
    expect(await report(JSON.stringify({ name: 'Error', message: 'broke\nkay: GET / 200\u001B[2J\u202E', stack: 'Error: broke\r\n    at chunk.js:1:2\nkay: GET /admin 200', url: '/' }))).toBe(204)
    expect(caught[1]).toMatchObject({ message: 'broke kay: GET / 200 [2J ', stack: '    Error: broke \n    at chunk.js:1:2\n    kay: GET /admin 200' })
    expect(await report(sent, { origin: 'https://evil.example' })).toBe(403)
    expect(await report('{"message":1}')).toBe(400)

    const statuses = await Promise.all(Array.from({ length: 25 }, async () => report(sent)))

    expect(statuses).toContain(429)
    logged.mockRestore()
  })

  it('hands what a component provides to what it renders, and to nothing beside it', async () => {
    const page = await html('/tone')

    expect(page).toContain('<section class="box"><!--[--><p class="tone">loud</p><!--]-->')
    // The layout's value reaches the page; the island beside, detached, reads the default.
    expect(page).toMatch(/<\/slot><p class="tone">layout<\/p>/)
    expect(page).toContain('<button class="reader">plain</button>')
  })

  it('tells caches a page a persisted cookie shaped depends on cookies', async () => {
    expect((await app.handle(new Request('http://localhost/alone'))).headers.get('vary')).toContain('cookie')
    expect((await app.handle(new Request('http://localhost/plain'))).headers.get('vary') ?? '').not.toContain('cookie')
  })

  it('keeps a write a page\'s own render makes to a module\'s signal for that request only', () => {
    const request = new Request('http://localhost/')
    const report = () => undefined

    inServerScope(request, report, () => shared[1]('first request'))

    expect(inServerScope(request, report, () => shared[0]())).toBe('default')
    expect(shared[0]()).toBe('default')
  })

  it('renders a persisted query param as queryParam does, by the page\'s schema, its value standing for the param left out', () => {
    const report = () => undefined
    const read = (url: string) => inServerScope(new Request(url), report, (): unknown[] => [persisted('q', 'all', { storage: 'query' })(), persisted('page', '1', { storage: 'query' })()], undefined, { page: { type: 'integer', default: 1 } })

    expect(read('http://localhost/?q=kay&page=3')).toEqual(['kay', 3])
    expect(read('http://localhost/?page=x')).toEqual(['all', 1])
  })

  it('marks an island kept across navigations, under its component or a key of its own', () => {
    const Player = island('player.kay', () => ({ t: '<button>Play</button>' }))

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

  it('goes to no javascript: URL navigate() is handed, as one read from a query param could be', async () => {
    for (const href of ['javascript:alert(1)', ' JavaScript:alert(1)'])
      await expect(navigate(href as never)).rejects.toThrow('kay: navigate() refuses javascript:')
  })

  it('leaves the default for a persisted cookie cut short', () => {
    document.cookie = 'cut=%E0%A4%A'

    expect(persisted('cut', 'light')()).toBe('light')
  })

  // `bun run check` fails on an `@ts-expect-error` with no error under it, so the type check is what this asserts.
  it('refuses persist and storage on a plain signal, which persisted() took over', () => {
    // @ts-expect-error -- persisted('a', 'x') keeps a value
    expect(signal('x', { persist: 'a' })()).toBe('x')
    // @ts-expect-error -- persisted('a', 'x', { storage: 'local' }) does
    expect(signal('x', { storage: 'local' })()).toBe('x')
  })

  it('keeps a persisted query param as queryParam does, leaving out its value and the schema\'s default', () => {
    const setURL = (url: string) => (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(url)

    document.head.innerHTML = '<script type="application/json" data-kay-query>{"page":{"type":"integer","default":1}}</script>'
    setURL('http://localhost/list?q=kay&page=3')

    const query = persisted('q', 'all', { storage: 'query' })
    const page = persisted<number>('page', 2, { storage: 'query' })

    expect<unknown[]>([query(), page()]).toEqual(['kay', 3])

    query.set('all')
    page.set(5)
    expect(location.search).toBe('?page=5')

    page.set(1)
    expect(location.search).toBe('')

    page.set(5)
    page.set(2)
    expect(location.search).toBe('')

    query.set('bun')
    expect(location.search).toBe('?q=bun')

    // Left out, the param reads as the schema's default, as the page's loads read it, before the value given.
    setURL('http://localhost/list')
    expect(persisted<number>('page', 2, { storage: 'query' })()).toBe(1)
    expect(persisted('q', 'all', { storage: 'query' })()).toBe('all')
    document.head.innerHTML = ''
  })

  it('keeps a fast-changing query param under the browser\'s history limit, the last value written once the window has room, the signal always current', () => {
    const setURL = (url: string) => (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(url)
    const replace = spyOn(history, 'replaceState')
    const timers: (() => void)[] = []
    const later = spyOn(globalThis, 'setTimeout').mockImplementation(((run: () => void) => {
      timers.push(run)

      return 0
    }) as unknown as typeof setTimeout)

    try {
      document.head.innerHTML = ''
      setURL('http://localhost/slider')
      // A window of its own, whatever the tests before it wrote.
      setSystemTime(Date.now() + 60_000)

      const level = persisted<number>('level', 0, { storage: 'query' })

      for (let value = 1; value <= 80; value++) {
        level.set(value)
        expect(level()).toBe(value)
      }

      expect(replace).toHaveBeenCalledTimes(50)
      expect(location.search).toBe('?level=50')
      expect(timers.length).toBeGreaterThan(0)

      setSystemTime(Date.now() + 31_000)
      timers.at(-1)!()
      expect(location.search).toBe('?level=80')
      expect(level()).toBe(80)
    }
    finally {
      setSystemTime()
      later.mockRestore()
      replace.mockRestore()
    }
  })

  it('never throws out of set() when the browser refuses a history write, the signal kept', () => {
    const refuse = spyOn(history, 'replaceState').mockImplementation(() => {
      throw new DOMException('Attempt to use history.replaceState() more than 100 times per 30 seconds', 'SecurityError')
    })

    try {
      setSystemTime(Date.now() + 60_000)

      const refused = persisted('refused', 'a', { storage: 'query' })

      expect(() => refused.set('b')).not.toThrow()
      expect(refused()).toBe('b')
    }
    finally {
      setSystemTime()
      refuse.mockRestore()
    }
  })

  it('drops a deferred query write once the page has swapped to another path', () => {
    const setURL = (url: string) => (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(url)
    const timers: (() => void)[] = []
    const later = spyOn(globalThis, 'setTimeout').mockImplementation(((run: () => void) => {
      timers.push(run)

      return 0
    }) as unknown as typeof setTimeout)

    try {
      setURL('http://localhost/one')
      setSystemTime(Date.now() + 60_000)

      const moved = persisted<number>('moved', 0, { storage: 'query' })

      for (let value = 1; value <= 55; value++)
        moved.set(value)

      expect(timers.length).toBeGreaterThan(0)
      setURL('http://localhost/two')
      timers.at(-1)!()
      expect(location.search).toBe('')
    }
    finally {
      setSystemTime()
      later.mockRestore()
    }
  })

  it('keeps a string in the query unless the signal is typed otherwise, as the URL holds text', () => {
    // @ts-expect-error -- a query param is a string unless typed otherwise
    expect(persisted('page', 1, { storage: 'query' })()).toBe(1)
    expect(persisted<number>('page', 1, { storage: 'query' })()).toBe(1)
  })

  it('parses each page data script once, a script a swap brings afresh, and skips one that does not parse after reporting it once, until its text changes', () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const seen: string[] = []
    const parse = (text: string) => {
      seen.push(text)

      return JSON.parse(text) as unknown
    }

    try {
      document.body.innerHTML = '<script type="application/json" data-test>{"a":1}</script><script type="application/json" data-test>{broken</script><script type="application/json" data-test>{"b":2}</script>'

      const first = pageData<object>('script[data-test]', parse)

      expect(first).toEqual([{ a: 1 }, { b: 2 }])
      expect(pageData<object>('script[data-test]', parse)[0]).toBe(first[0])
      expect(seen).toHaveLength(3)
      expect(logged).toHaveBeenCalledTimes(1)

      // As a script read before the stream ended it, reported once however many texts it has.
      document.querySelectorAll('script[data-test]')[1]!.textContent = '{broken still'
      expect(pageData<object>('script[data-test]', parse)).toEqual([{ a: 1 }, { b: 2 }])
      expect(logged).toHaveBeenCalledTimes(1)
      document.querySelectorAll('script[data-test]')[1]!.textContent = '{"c":3}'
      expect(pageData<object>('script[data-test]', parse)).toEqual([{ a: 1 }, { c: 3 }, { b: 2 }])
      expect(seen).toHaveLength(5)

      document.body.innerHTML = '<script type="application/json" data-test>{"a":1}</script>'
      expect(pageData<object>('script[data-test]', parse)[0]).not.toBe(first[0]!)
      expect(seen).toHaveLength(6)
    }
    finally {
      logged.mockRestore()
      document.body.innerHTML = ''
    }
  })

  it('leaves markup a try block would not claim to its island, which renders afresh', () => {
    const element = document.createElement('div')

    element.innerHTML = '<p>changed</p>'

    expect(() => hydrate(() => attempt(element, null, null, () => {
      throw new HydrationMismatch('the markup changed')
    }, () => 'fallback'), element)).toThrow('the markup changed')
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
