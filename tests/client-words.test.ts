import type { ClientBuild } from '../src/server/client'
import process from 'node:process'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { t } from 'elysia'
import { clientDir } from '../src/build/assets'
import { resolveProject } from '../src/project'
import { action } from '../src/runtime/action'
import { checkForm } from '../src/runtime/validate'
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

async function page(path: string, options: { dev?: boolean, i18n?: boolean } = {}): Promise<string> {
  const app = await servePages(resolveProject(process.cwd(), { routes: `${FIXTURE}/src/routes`, security: false, ...options.i18n !== false && { i18n } }, { dev: options.dev ?? false, prebuilt: false, underKayDev: false }), async () => client)

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

  it('sends nothing on a site without i18n', async () => {
    expect(payload(await page('/', { i18n: false }))).toBeUndefined()
  })
})

describe('the browser\'s form check in the page\'s locale', () => {
  beforeAll(() => GlobalRegistrator.register())
  afterAll(async () => GlobalRegistrator.unregister())

  function check(fields: [string, string][], schema: ReturnType<typeof t.Object>): Record<string, string> {
    const submitted = action(schema, () => undefined)

    ;(submitted as { url: string }).url = '/act'
    document.head.querySelector('script[data-kay-forms]')?.remove()
    document.head.insertAdjacentHTML('beforeend', formsScript(new Set([submitted])))
    document.body.innerHTML = `<form>${fields.map(([name, value]) => `<input name="${name}" value="${value}">`).join('')}</form>`
    checkForm(document.querySelector('form')!, '/act')

    // The first control of a name carries its message, so it is read last.
    const entries = [...document.querySelectorAll('input')].map((input): [string, string] => [input.name, input.validationMessage])

    return Object.fromEntries(entries.reverse())
  }

  function bring(messages: Record<string, string>, locale = 'fr'): void {
    document.head.querySelector('script[data-kay-i18n]')?.remove()
    document.head.insertAdjacentHTML('beforeend', `<script type="application/json" data-kay-i18n>${JSON.stringify({ locale, messages })}</script>`)
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

  it('words an empty field its schema asks one character of as required, as the server does, and keeps a schema\'s own error', () => {
    const own = t.Object({ name: t.String({ minLength: 1 }), nick: t.String({ minLength: 5, error: 'Five at least' }) })

    expect(check([['name', ''], ['nick', 'abc']], own)).toEqual({ name: 'Champ requis', nick: 'Five at least' })
    expect(check([['name', 'x'], ['nick', 'abcdef']], t.Object({ name: t.String({ minLength: 2 }), nick: t.String() }))).toEqual({ name: 'Au moins 2 caractères', nick: '' })
  })
})
