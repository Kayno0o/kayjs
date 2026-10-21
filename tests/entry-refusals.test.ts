import type { LocaleState } from '../src/runtime/locale-state'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { t } from 'elysia'
import { humanize } from '../packages/cms/src/fields'
import { checkContent } from '../src/check/project'
import { writeContentManifests } from '../src/content/server'
import { ContentError, dataIssues, decodeEntries } from '../src/content/validate'
import { runInLocale } from '../src/runtime/locale-state'
import { fixtureCopy } from './scratch'

const schema = t.Object({
  title: t.String({ minLength: 1 }),
  summary: t.String({ minLength: 3, maxLength: 5 }),
  slug: t.String({ pattern: '^[a-z]+$' }),
  publishedAt: t.String({ title: 'Date de parution', format: 'date-time' }),
  rating: t.Number({ minimum: 1, maximum: 5 }),
  tags: t.Array(t.String({ minLength: 2 }), { minItems: 1, maxItems: 2 }),
  flag: t.Boolean(),
  networks: t.Object({
    youtube: t.String({ format: 'uri' }),
    handle: t.Optional(t.Union([t.String({ minLength: 2 }), t.Null()], { title: 'Pseudo' })),
  }),
  seoURL: t.Optional(t.String({ minLength: 4 })),
})

const VALID = { title: 'T', summary: 'abcd', slug: 'ok', publishedAt: '2026-01-01T00:00:00Z', rating: 3, tags: ['aa'], flag: true, networks: { youtube: 'https://youtu.be/x' } }

const messagesOf = (data: unknown): Record<string, string> => Object.fromEntries(dataIssues(schema, data).map(({ path, message }) => [path, message]))

const FRENCH: LocaleState = {
  locale: 'fr',
  settings: { locales: ['fr'], defaultLocale: 'fr', prefixDefault: false, pages: [] },
  path: '/',
  messages: new Map<string, string>([
    ['kay.entry.required', '{field} est obligatoire'],
    ['kay.entry.format', '{field} n\'est pas une adresse {format} valide'],
    ['kay.entry.tooShort', '{field} demande au moins {min} caractères'],
    ['kay.entry.item', '{field}, élément {n}'],
  ]),
}

describe('an entry the schema refuses', () => {
  it('reads as a sentence naming the field by its label, for each keyword', () => {
    const found = messagesOf({ ...VALID, title: '', summary: 'ab', slug: 'No1', publishedAt: 'x', rating: 9, tags: ['aa', 'bb', 'cc'], flag: 'yes', seoURL: 'abc' })

    expect(found).toEqual({
      title: 'Title is required',
      summary: 'Summary needs at least 3 characters',
      slug: 'Slug is not in the expected form',
      publishedAt: 'Date de parution is not a valid date-time',
      rating: 'Rating must be at most 5',
      tags: 'Tags: at most 2 items',
      flag: 'Flag is not valid',
      seoURL: 'Seo URL needs at least 4 characters',
    })
  })

  it('words a number under its lower bound, a long text and too few items', () => {
    expect(messagesOf({ ...VALID, rating: 0, summary: 'abcdefg', tags: [] })).toEqual({
      rating: 'Rating must be at least 1',
      summary: 'Summary takes 5 characters at most',
      tags: 'Tags: at least 1 items',
    })
  })

  it('words a field the entry leaves out as required', () => {
    const without: Record<string, unknown> = { ...VALID }

    delete without.title

    expect(messagesOf(without)).toEqual({ title: 'Title is required' })
  })

  it('attaches the issue to the nested field, with the nested field\'s label', () => {
    expect(messagesOf({ ...VALID, networks: { youtube: 'nope', handle: 'xy' } })).toEqual({
      'networks.youtube': 'Youtube is not a valid uri',
    })
    // A nullable field wears the title of its inner type.
    expect(messagesOf({ ...VALID, networks: { youtube: 'https://a.b', handle: 3 } })).toEqual({ 'networks.handle': 'Pseudo is not valid' })
  })

  it('names an item of a list by its position', () => {
    expect(messagesOf({ ...VALID, tags: ['aa', 'b'] })).toEqual({ 'tags.1': 'Tags, item 2 needs at least 2 characters' })
  })

  it('reads in the request\'s locale, a key without a text keeping its English', () => {
    const found = runInLocale(FRENCH, () => messagesOf({ ...VALID, title: '', networks: { youtube: 'nope' }, tags: ['aa', 'b'], rating: 9 }))

    expect(found).toEqual({
      'title': 'Title est obligatoire',
      'networks.youtube': 'Youtube n\'est pas une adresse uri valide',
      'tags.1': 'Tags, élément 2 demande au moins 2 caractères',
      'rating': 'Rating must be at most 5',
    })
  })

  it('names the data itself when it is not an object, and a key with a slash or a tilde by its words', () => {
    expect(messagesOf('text')).toEqual({ '': 'The data is not valid' })

    const odd = t.Object({ 'a/b~c': t.String({ minLength: 1 }), '__proto__x': t.String() })

    expect(dataIssues(odd, { 'a/b~c': '', '__proto__x': 1 }).map(issue => issue.message)).toEqual(['A b c is required', 'Proto x is not valid'])
  })
})

describe('the entries a build reads', () => {
  const entry = (data: unknown, lines: Record<string, number>): never => ({ file: 'content/a.md', slug: 'a', data, lines, body: '' }) as never

  it('reports each nested field apart, on the line its top-level field starts at', () => {
    try {
      decodeEntries([entry({ ...VALID, title: '', networks: { youtube: 'nope' } }, { title: 2, networks: 7 })], schema, {})
      expect.unreachable()
    }
    catch (error) {
      expect(error).toBeInstanceOf(ContentError)
      expect((error as ContentError).problems.map(({ line, message }) => ({ line, message }))).toEqual([
        { line: 2, message: 'title: Title is required' },
        { line: 7, message: 'networks.youtube: Youtube is not a valid uri' },
      ])
    }
  })

  it('reports an entry that is not an object as the data', () => {
    try {
      decodeEntries([entry('text', {})], schema, {})
      expect.unreachable()
    }
    catch (error) {
      expect((error as ContentError).problems[0]?.message).toBe('The data is not valid')
    }
  })
})

describe('the labels', () => {
  it('are the CMS editor\'s: the same words for a key, a numeric key an object property rather than an item', () => {
    for (const key of ['publishedAt', 'seoURL', 'snake_case', 'kebab-case', 'a/b~c'])
      expect(dataIssues(t.Object({ [key]: t.String({ minLength: 9 }) }), { [key]: '' })[0]!.message).toStartWith(humanize(key))

    expect(dataIssues(t.Object({ 2024: t.String({ minLength: 2 }) }), { 2024: 'a' })[0]!.message).toBe('2024 needs at least 2 characters')
  })

  it('give the inner type\'s title before the nullable field\'s own, and a field\'s own error the last word', () => {
    const titled = t.Object({ handle: t.Union([t.String({ title: 'Inner', minLength: 2 }), t.Null()], { title: 'Outer' }), slug: t.String({ pattern: '^a$', error: 'Use a.' }) })

    expect(dataIssues(titled, { handle: 3, slug: 'b' }).map(issue => issue.message)).toEqual(['Inner is not valid', 'Use a.'])
  })

  it('give a line to a top-level key holding a dot', () => {
    const dotted = t.Object({ 'a.b': t.String({ minLength: 1 }) })

    try {
      decodeEntries([{ file: 'c/a.md', slug: 'a', data: { 'a.b': '' }, lines: { 'a.b': 5 }, body: '' } as never], dotted, {})
      expect.unreachable()
    }
    catch (error) {
      expect((error as ContentError).problems[0]?.line).toBe(5)
    }
  })

  it('give each refused field the line of its own top-level key, escaped or dotted', () => {
    const odd = t.Object({
      'a/b': t.String({ minLength: 1 }),
      'c~d': t.String({ minLength: 1 }),
      'a.b': t.String({ minLength: 1 }),
      'a': t.Object({ b: t.String({ minLength: 1 }) }),
    })
    const lines = { 'a/b': 2, 'c~d': 3, 'a.b': 4, 'a': 5 }

    try {
      decodeEntries([{ file: 'c/a.md', slug: 'a', data: { 'a/b': '', 'c~d': '', 'a.b': '', 'a': { b: '' } }, lines, body: '' } as never], odd, {})
      expect.unreachable()
    }
    catch (error) {
      expect((error as ContentError).problems.map(problem => [problem.line, problem.message.slice(0, problem.message.indexOf(':'))])).toEqual([[2, 'a/b'], [3, 'c~d'], [4, 'a.b'], [5, 'a.b']])
    }
  })
})

describe('kay build and kay check', () => {
  const CONFIG = 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ i18n: { locales: [\'fr\', \'en\'], defaultLocale: \'fr\' } })\n'
  const FRENCH_KEY = 'import { defineMessages } from \'kay/i18n\'\n\nexport default defineMessages({ kay: { entry: { type: \'{field} n\\\'est pas valide\' } } })\n'

  // The i18n-content fixture with a French default locale, and a French entry whose date is no date.
  async function site(messages: string): Promise<string> {
    const copy = await fixtureCopy('i18n-content')

    await Bun.write(join(copy, 'kay.config.ts'), CONFIG)
    await Bun.write(join(copy, 'src/messages/fr.ts'), messages)
    await Bun.write(join(copy, 'src/content/news/fr/broken.md'), '---\ntitle: Cassé\ndate: someday\n---\n')

    return copy
  }

  it('word an entry\'s refusal in the default locale\'s catalog, and in English where the site gives no key', async () => {
    const french = await site(FRENCH_KEY)
    const bare = await site('import { defineMessages } from \'kay/i18n\'\n\nexport default defineMessages({})\n')

    try {
      expect((await checkContent(french, undefined, true)).problems.map(problem => problem.message)).toEqual(['date: Date n\'est pas valide'])
      expect((await checkContent(bare, undefined, true)).problems.map(problem => problem.message)).toEqual(['date: Date is not valid'])

      await expect(writeContentManifests(resolve(french), join(french, 'out'), undefined)).rejects.toThrow('date: Date n\'est pas valide')
    }
    finally {
      await rm(french, { recursive: true, force: true })
      await rm(bare, { recursive: true, force: true })
    }
  }, 30_000)
})
