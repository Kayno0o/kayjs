import type { ClientBuild } from '../src/server/client'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { clientDir } from '../src/build/assets'
import { resolveProject } from '../src/project'
import { servePages } from '../src/server/app'
import { fieldMessage, validated } from '../src/server/field-errors'
import { testSite } from '../src/test'

type Rules = Record<string, { properties: Record<string, { error?: string }> }>

const FIXTURE = 'tests/fixtures/form-words'
const FORMS = /<script type="application\/json" data-kay-forms>(.*?)<\/script>/
const client: ClientBuild = { entry: '/_kay/entry.js', entryImports: [], islands: {}, styles: new Map(), pages: new Map(), dir: clientDir(process.cwd()), navigation: true }
const i18n = { locales: ['en', 'fr'], defaultLocale: 'en', messages: `${FIXTURE}/src/messages` }
const app = await servePages(resolveProject(process.cwd(), { routes: `${FIXTURE}/src/routes`, security: false, i18n }), async () => client)

async function rules(path: string): Promise<Rules[string]> {
  const html = await (await app.handle(new Request(`http://localhost${path}`))).text()

  return Object.values(JSON.parse(FORMS.exec(html)![1]!) as Rules)[0]!
}

describe('a field error written as a function', () => {
  it('reaches the page\'s rules in the page\'s language, and a function giving no text leaves the default wording', async () => {
    const english = await rules('/')
    const french = await rules('/fr')

    expect(english.properties.name!.error).toBe('Write a name')
    expect(french.properties.name!.error).toBe('Écrivez un nom')
    expect(english.properties.nickname!.error).toBeUndefined()
    expect(french.properties.note!.error).toBeUndefined()
  })

  it('refuses the post in the page\'s language, and a function giving no text leaves Elysia\'s wording', async () => {
    const site = await testSite({ routes: `${FIXTURE}/src/routes`, i18n })
    const { rename } = await import(`${import.meta.dir}/fixtures/form-words/src/routes/index.kay`) as { rename: Parameters<typeof site.submit>[0] }
    const input = { name: 'A', nickname: 'B', note: 'C' }
    const english = await site.submit(rename, input, { from: '/' })
    const french = await site.submit(rename, input, { from: '/fr' })

    expect(english.status).toBe(422)
    expect(english.html).toContain('Write a name')
    expect(french.status).toBe(422)
    expect(french.html).toContain('Écrivez un nom')
    expect(french.html).not.toContain('no message')
  })

  it('words a file of the wrong type and a refused union branch in the page\'s language', async () => {
    const site = await testSite({ routes: `${FIXTURE}/src/routes`, i18n })
    const { attach } = await import(`${import.meta.dir}/fixtures/form-words/src/routes/index.kay`) as { attach: Parameters<typeof site.submit>[0] }
    const input = { photo: new File(['text'], 'a.png', { type: 'image/png' }), contact: 'nope' }
    const french = await site.submit(attach, input, { from: '/fr' })

    expect(french.status).toBe(422)
    expect(french.html).toContain('Écrivez un nom')
  })
})

describe('the error functions of a schema', () => {
  const schema = {
    properties: {
      'a/b': { error: () => 'slashed' },
      'list': { items: { error: () => 'item' } },
      'either': { anyOf: [{ type: 'null' }, { error: () => 'branch' }] },
    },
  }

  it('are read at a pointer, an escaped name, an item and a union branch included, and never from the prototype', () => {
    expect(fieldMessage(schema, '/a~1b')).toBe('slashed')
    expect(fieldMessage(schema, '/list/3')).toBe('item')
    expect(fieldMessage(schema, '/either')).toBe('branch')
    expect(fieldMessage(schema, '/__proto__')).toBeUndefined()
    expect(fieldMessage(schema, '/constructor')).toBeUndefined()
  })

  it('are left out of the copy Elysia validates with, the schema itself untouched', () => {
    const copy = validated(schema as never) as unknown as typeof schema

    expect(copy).not.toBe(schema)
    expect(copy.properties['a/b']).not.toHaveProperty('error')
    expect(schema.properties['a/b'].error()).toBe('slashed')
    expect(validated(copy as never)).toBe(copy as never)
  })
})
