import type { ClientBuild } from '../src/server/client'
import process from 'node:process'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { t } from 'elysia'
import { clientDir } from '../src/build/assets'
import { resolveProject } from '../src/project'
import { action } from '../src/runtime/action'
import { checkForm } from '../src/runtime/validate'
import { resetWords } from '../src/runtime/words.client'
import { servePages } from '../src/server/app'
import { formsScript } from '../src/server/forms'
import { INVALID_PARAMS } from '../src/server/words'

const FIXTURE = 'tests/fixtures/client-words'
const I18N = /<script type="application\/json" data-kay-i18n>(.*?)<\/script>/
const client: ClientBuild = { entry: '/_kay/entry.js', entryImports: [], islands: {}, styles: new Map(), pages: new Map(), dir: clientDir(process.cwd()), navigation: true }
const i18n = { locales: ['en', 'fr'], defaultLocale: 'en', messages: `${FIXTURE}/src/messages` }
const FRENCH = {
  'kay.invalid.required': 'Champ requis',
  'kay.invalid.tooShort': 'Au moins {min} caractères',
  'kay.invalid.tooLong': 'Au plus {max} caractères',
  'kay.invalid.pattern': 'Mauvais format',
  'kay.invalid.format': 'Pas au format {format}',
  'kay.invalid.tooFewItems': 'Au moins {min} choix',
  'kay.invalid.tooManyItems': 'Au plus {max} choix',
  'kay.invalid.tooSmall': '{min} ou plus',
  'kay.invalid.tooBig': '{max} ou moins',
  'kay.invalid.type': 'Valeur invalide',
}

async function page(path: string, options: { dev?: boolean, i18n?: boolean, base?: string, trailingSlash?: 'always' } = {}): Promise<string> {
  const app = await servePages(resolveProject(process.cwd(), { routes: `${FIXTURE}/src/routes`, security: false, ...options.base !== undefined && { base: options.base }, ...options.trailingSlash !== undefined && { trailingSlash: options.trailingSlash }, ...options.i18n !== false && { i18n } }, { dev: options.dev ?? false, prebuilt: false, underKayDev: false }), async () => client)

  return (await app.handle(new Request(`http://localhost${path}`))).text()
}

function payload(html: string): { locale?: string, messages: Record<string, string> } | undefined {
  const found = I18N.exec(html)

  return found ? JSON.parse(found[1]!) as { locale?: string, messages: Record<string, string> } : undefined
}

describe('the messages a page sends for the browser\'s form check', () => {
  for (const dev of [false, true]) {
    it(`brings every kay.invalid.* text of the page's locale when a form on it has a schema, ${dev ? 'in dev' : 'in production'}`, async () => {
      const french = payload(await page('/fr', { dev }))
      const english = payload(await page('/', { dev }))

      expect(french?.locale).toBe('fr')
      expect(french?.messages).toEqual(FRENCH)
      expect(Object.keys(french!.messages).sort()).toEqual(Object.keys(INVALID_PARAMS).sort())
      // The English catalog words none: the browser keeps Elysia's English, and the page sends nothing.
      expect(english).toBeUndefined()
    })
  }

  it('brings them on a page whose form is in an island', async () => {
    const html = await page('/fr/island')

    expect(payload(html)?.messages).toEqual(FRENCH)
    expect(payload(html)?.locale).toBe('fr')
  })

  it('brings them on a page whose form is in a streamed block', async () => {
    const html = await page('/fr/streamed')

    expect(payload(html)?.messages).toEqual(FRENCH)
    expect(payload(html)?.locale).toBe('fr')
  })

  it('sends nothing on a page without a form', async () => {
    expect(payload(await page('/fr/plain'))).toBeUndefined()
  })

  it('sends nothing on a site without i18n', async () => {
    expect(payload(await page('/', { i18n: false }))).toBeUndefined()
  })
})

const FORMS = /<script type="application\/json" data-kay-forms>(.*?)<\/script>/g
const ENTRY = /src="(?:\/blog)?\/_kay\/entry\.js"/g

function schemasOf(html: string): string[][] {
  return [...html.matchAll(FORMS)].map(found => Object.keys(JSON.parse(found[1]!) as object))
}

// What a form in a streamed block needs is shipped in the stream as the shell would have: kaynooo/kayjs#960.
describe('a form inside a streamed block', () => {
  const sites: [string, { base?: string, trailingSlash?: 'always' }][] = [
    ['', {}],
    ['/blog', { base: '/blog', trailingSlash: 'always' }],
  ]

  for (const [prefix, options] of sites) {
    const path = (route: string) => `${route}${options.trailingSlash === 'always' ? '/' : ''}`

    describe(prefix === '' ? 'on a site at the root' : 'under a base with a trailing slash', () => {
      it('ships the rules, the locale\'s messages and the entry when only the block holds a form', async () => {
        const html = await page(path('/fr/streamed'), options)
        const forms = schemasOf(html)

        expect(forms).toHaveLength(1)
        expect(forms[0]).toHaveLength(1)
        expect(forms[0]![0]).toEndWith('/check')
        // The schemas go by the action's path without the base, as the browser asks for them.
        expect(forms[0]![0]!.startsWith('/_kay/')).toBe(true)
        expect(payload(html)).toMatchObject({ locale: 'fr', messages: FRENCH })
        expect(html.match(ENTRY)).toHaveLength(1)
        // They come with the block, after the shell.
        expect(html.indexOf('data-kay-forms')).toBeGreaterThan(html.indexOf('Shell'))
      })

      it('words nothing on a site without i18n, but still ships the rules and the entry', async () => {
        const html = await page(path('/streamed'), { ...options, i18n: false })

        expect(schemasOf(html)).toHaveLength(1)
        expect(payload(html)).toBeUndefined()
        expect(html.match(ENTRY)).toHaveLength(1)
      })

      it('sends only what the shell lacks for a block when the shell has a form too', async () => {
        const html = await page(path('/fr/both'), options)
        const forms = schemasOf(html)

        // The shell has `check`; the block adds `other` only.
        expect(forms).toHaveLength(2)
        expect(forms[0]).toHaveLength(1)
        expect(forms[1]).toHaveLength(1)
        expect(forms[1]![0]).toEndWith('/other')
        expect(html.match(/data-kay-i18n/g)).toHaveLength(1)
        expect(html.match(ENTRY)).toHaveLength(1)
      })

      it('ships them once for the parts of an iterable block', async () => {
        const html = await page(path('/fr/parts'), options)

        expect(html.match(/data-kay-await="/g)!.length).toBeGreaterThan(1)
        expect(schemasOf(html)).toHaveLength(1)
        expect(html.match(/data-kay-i18n/g)).toHaveLength(1)
        expect(html.match(ENTRY)).toHaveLength(1)
        expect(payload(html)?.messages).toEqual(FRENCH)
      })
    })
  }
})

describe('the browser\'s form check in the page\'s locale', () => {
  beforeAll(() => GlobalRegistrator.register())
  afterAll(async () => GlobalRegistrator.unregister())
  // Each test is a fresh page load: the words a page brought stay in the module otherwise.
  beforeEach(() => {
    resetWords()
    document.head.innerHTML = ''
    document.body.innerHTML = ''
  })

  function check(fields: [string, string][], schema: ReturnType<typeof t.Object>): Record<string, string> {
    const submitted = action(schema, () => undefined)

    ;(submitted as { url: string }).url = '/act'
    document.head.querySelector('script[data-kay-forms]')?.remove()
    document.head.insertAdjacentHTML('beforeend', formsScript(new Set([submitted])))
    document.querySelector('form')?.remove()
    document.body.insertAdjacentHTML('afterbegin', `<form>${fields.map(([name, value]) => `<input name="${name}" value="${value}">`).join('')}</form>`)
    checkForm(document.querySelector('form')!, '/act')

    // The first control of a name carries its message, so it is read last.
    const entries = [...document.querySelectorAll('input')].map((input): [string, string] => [input.name, input.validationMessage])

    return Object.fromEntries(entries.reverse())
  }

  function bring(messages: Record<string, string>, locale = 'fr'): void {
    document.head.querySelector('script[data-kay-i18n]')?.remove()
    document.head.insertAdjacentHTML('beforeend', `<script type="application/json" data-kay-i18n>${JSON.stringify({ locale, messages })}</script>`)
  }

  // A streamed block or a swapped page brings its own script, which the check reads the next time it needs a word.
  function append(parent: Element, text: string): void {
    parent.insertAdjacentHTML('beforeend', `<script type="application/json" data-kay-i18n>${text}</script>`)
  }

  const schema = t.Object({
    short: t.String({ minLength: 3 }),
    long: t.String({ maxLength: 2 }),
    word: t.String({ pattern: '^[a-z]+$' }),
    mail: t.String({ format: 'email' }),
    count: t.Number({ minimum: 1 }),
    top: t.Number({ maximum: 5 }),
    kind: t.Literal('a'),
    tags: t.Array(t.String(), { minItems: 2 }),
    many: t.Array(t.String(), { maxItems: 1 }),
    blank: t.String({ minLength: 1 }),
  })
  const fields: [string, string][] = [['short', 'ab'], ['long', 'abc'], ['word', 'A1'], ['mail', 'nope'], ['count', '0'], ['top', '9'], ['kind', 'b'], ['tags', 'x'], ['many', 'a'], ['many', 'b'], ['blank', '']]

  it('speaks Elysia\'s English on a page that brought no messages, as a site without i18n', () => {
    expect(check(fields, schema)).toEqual({
      short: 'Expected string length greater or equal to 3',
      long: 'Expected string length less or equal to 2',
      word: 'Expected string to match \'^[a-z]+$\'',
      mail: 'Property \'mail\' should be email',
      count: 'Expected number to be greater or equal to 1',
      top: 'Expected number to be less or equal to 5',
      kind: 'Expected \'a\'',
      tags: 'Expected array length to be greater or equal to 2',
      many: 'Expected array length to be less or equal to 1',
      blank: 'Expected string length greater or equal to 1',
    })
  })

  it('keeps Elysia\'s English for a key the page did not bring', () => {
    bring({ 'kay.invalid.tooShort': 'Au moins {min} caractères' })

    const messages = check(fields, schema)

    expect(messages.short).toBe('Au moins 3 caractères')
    expect(messages.long).toBe('Expected string length less or equal to 2')
    expect(messages.mail).toBe('Property \'mail\' should be email')
  })

  it('words each kind of refusal in the page\'s locale with the same params as the server', () => {
    bring(FRENCH)

    expect(check(fields, schema)).toEqual({
      short: 'Au moins 3 caractères',
      long: 'Au plus 2 caractères',
      word: 'Mauvais format',
      mail: 'Pas au format email',
      count: '1 ou plus',
      top: '5 ou moins',
      kind: 'Valeur invalide',
      tags: 'Au moins 2 choix',
      many: 'Au plus 1 choix',
      blank: 'Champ requis',
    })
  })

  it('words a bound before the type of a number, and an exclusive bound as a type refusal, as the server does', () => {
    bring(FRENCH)
    const numbers = t.Object({ whole: t.Integer({ minimum: 1 }), below: t.Number({ exclusiveMaximum: 10 }), plain: t.Integer() })

    expect(check([['whole', '0.5'], ['below', '10'], ['plain', '1.5']], numbers)).toEqual({ whole: '1 ou plus', below: 'Valeur invalide', plain: 'Valeur invalide' })
  })

  it('words an empty field its schema asks one character of as required, as the server does, and keeps a schema\'s own error', () => {
    bring(FRENCH)
    const own = t.Object({ name: t.String({ minLength: 1 }), nick: t.String({ minLength: 5, error: 'Five at least' }) })

    expect(check([['name', ''], ['nick', 'abc']], own)).toEqual({ name: 'Champ requis', nick: 'Five at least' })
    expect(check([['name', 'x'], ['nick', 'abcdef']], t.Object({ name: t.String({ minLength: 2 }), nick: t.String() }))).toEqual({ name: 'Au moins 2 caractères', nick: '' })
  })

  it('reads the script a swapped page brings in the head, beside the words of the page it left', async () => {
    bring({ 'kay.invalid.tooShort': 'Au moins {min} caractères' })
    expect(check(fields, schema).long).toBe('Expected string length less or equal to 2')

    await Promise.resolve()
    append(document.head, JSON.stringify({ messages: { 'kay.invalid.tooLong': 'Au plus {max} caractères' } }))

    const messages = check(fields, schema)

    expect(messages.short).toBe('Au moins 3 caractères')
    expect(messages.long).toBe('Au plus 2 caractères')
  })

  it('reads a script a streamed block appends to the body once it is whole, and skips it while it streams', async () => {
    bring({ 'kay.invalid.tooShort': 'Au moins {min} caractères' })
    append(document.body, '{"messages":{"kay.invalid.tooLo')
    expect(check(fields, schema).long).toBe('Expected string length less or equal to 2')

    document.body.querySelector('script[data-kay-i18n]')?.remove()
    await Promise.resolve()
    append(document.body, JSON.stringify({ messages: { 'kay.invalid.tooLong': 'Au plus {max} caractères' } }))
    expect(check(fields, schema).long).toBe('Au plus 2 caractères')
  })

  it('finds the rules of a form in the script a streamed block brought, past the shell\'s', () => {
    bring(FRENCH)

    const first = action(t.Object({ name: t.String({ minLength: 3 }) }), () => undefined)
    const second = action(t.Object({ title: t.String({ minLength: 4 }) }), () => undefined)

    ;(first as { url: string }).url = '/first'
    ;(second as { url: string }).url = '/second'
    document.head.insertAdjacentHTML('beforeend', formsScript(new Set([first])))
    document.body.insertAdjacentHTML('beforeend', formsScript(new Set([second])))
    document.body.insertAdjacentHTML('afterbegin', '<form><input name="title" value="ab"></form>')
    checkForm(document.querySelector('form')!, '/second')
    expect(document.querySelector('input')!.validationMessage).toBe('Au moins 4 caractères')
  })

  it('checks a form an island rendered after the page loaded as one the page held', () => {
    bring(FRENCH)

    const submitted = action(t.Object({ name: t.String({ minLength: 3 }) }), () => undefined)

    ;(submitted as { url: string }).url = '/act'
    document.head.insertAdjacentHTML('beforeend', formsScript(new Set([submitted])))

    const island = document.createElement('div')

    island.innerHTML = '<form><input name="name" value="ab"></form>'
    document.body.append(island)
    checkForm(island.querySelector('form')!, '/act')
    expect(island.querySelector('input')!.validationMessage).toBe('Au moins 3 caractères')
  })
})
