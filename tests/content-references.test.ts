import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { t } from 'elysia'
import { checkContent } from '../src/check/project'
import { blocks, collection, reference, resolve as resolveReference } from '../src/content'
import { entryIssues, registerCollections } from '../src/content/edit'
import { referencesIn } from '../src/content/references'
import { writeContentManifests } from '../src/content/server'
import { fixtureCopy } from './scratch'

const CONFIG = `import { t } from 'elysia'
import { blocks, collection, reference } from 'kay/content'

export const authors = collection('content/authors', { schema: t.Object({ name: t.String() }) })

export const news = collection('content/news', {
  schema: t.Object({
    title: t.String(),
    date: t.Date(),
    author: t.Optional(reference('authors')),
    editors: t.Optional(t.Array(reference('authors'))),
    parts: t.Optional(blocks({ quote: t.Object({ by: reference('authors') }), text: t.Object({ body: t.String() }) })),
  }),
  localized: true,
})
`

describe('referencesIn', () => {
  const schema = t.Object({
    author: t.Optional(reference('authors')),
    editors: t.Optional(t.Array(reference('authors'))),
    maybe: t.Union([reference('authors'), t.Null()]),
    parts: blocks({ quote: t.Object({ by: reference('people') }), text: t.Object({ by: t.String() }) }),
  })

  it('finds a slug however deep, skipping null, empty and other types', () => {
    const data = { author: 'ada', editors: ['bob', ''], maybe: null, parts: [{ type: 'quote', by: 'cy' }, { type: 'text', by: 'not-a-slug' }] }

    expect(referencesIn(schema, data).map(use => [use.path, use.field, use.collection, use.slug])).toEqual([
      ['author', 'author', 'authors', 'ada'],
      ['editors.0', 'editors', 'authors', 'bob'],
      ['parts.0.by', 'parts', 'people', 'cy'],
    ])
  })

  it('reads a union member holding a slug once', () => {
    expect(referencesIn(schema, { maybe: 'ada', parts: [] }).map(use => use.path)).toEqual(['maybe'])
  })
})

describe('resolve', () => {
  const authors = collection({ name: 'resolve-authors', load: () => [{ slug: 'ada', data: { name: 'Ada' } }, { slug: 'bob', data: { name: 'Bob' } }] }, { schema: t.Object({ name: t.String() }) })

  it('gives the entry, the entries found in order, or undefined', async () => {
    expect((await resolveReference('ada', authors))?.data.name).toBe('Ada')
    expect((await resolveReference(['bob', 'ghost', 'ada'], authors)).map(entry => entry.slug)).toEqual(['bob', 'ada'])
    expect(await resolveReference('ghost', authors)).toBeUndefined()
    expect(await resolveReference(undefined, authors)).toBeUndefined()
    expect(await resolveReference(null, authors)).toBeUndefined()
  })
})

describe('a dangling reference', () => {
  async function site(files: Record<string, string>): Promise<string> {
    const copy = await fixtureCopy('i18n-content')

    await rm(join(copy, 'src/content/news'), { recursive: true, force: true })
    await rm(join(copy, 'src/routes'), { recursive: true, force: true })
    await Bun.write(join(copy, 'src/content.config.ts'), CONFIG)

    for (const [path, text] of Object.entries(files))
      await Bun.write(join(copy, 'src/content', path), text)

    return copy
  }

  const AUTHOR = '---\nname: Ada\n---\n'
  const post = (extra: string): string => `---\ntitle: Hello\ndate: 2026-10-01\n${extra}---\n`

  it('fails kay check on the file and the line of the field, lists included, in a localized collection', async () => {
    const copy = await site({
      'authors/ada.md': AUTHOR,
      'news/fr/ok.md': post('author: ada\neditors:\n  - ada\n'),
      'news/fr/lost.md': post('author: ghost\n'),
      'news/en/lost.md': post('editors:\n  - ada\n  - nobody\n'),
      'news/en/block.md': post('parts:\n  - type: quote\n    by: ghost\n'),
    })

    try {
      const { problems } = await checkContent(copy, undefined, true)

      expect(problems.map(problem => `${problem.file.split('/src/').at(-1)}:${problem.line} ${problem.message}`).sort()).toEqual([
        'content/news/en/block.md:4 parts.0.by: references ghost, which authors has no entry for',
        'content/news/en/lost.md:4 editors.1: references nobody, which authors has no entry for',
        'content/news/fr/lost.md:4 author: references ghost, which authors has no entry for',
      ])
    }
    finally {
      await rm(copy, { recursive: true, force: true })
    }
  }, 30_000)

  it('notes a shown entry referencing one held back as a draft or by its date, and neither fails the build nor flags a held entry', async () => {
    const copy = await site({
      'authors/ada.md': '---\nname: Ada\ndraft: true\n---\n',
      'authors/soon.md': '---\nname: Soon\nat: 2999-01-01\n---\n',
      'authors/bob.md': AUTHOR,
      'news/fr/shown.md': post('author: ada\neditors:\n  - soon\n  - bob\n'),
      'news/fr/held.md': post('author: ada\n').replace('title: Hello', 'title: Held\ndraft: true'),
    })

    try {
      const config = join(copy, 'src/content.config.ts')

      await Bun.write(config, (await Bun.file(config).text()).replace('collection(\'content/authors\', { schema: t.Object({ name: t.String() }) })', 'collection(\'content/authors\', { schema: t.Object({ name: t.String(), draft: t.Optional(t.Boolean()), at: t.Optional(t.Date()) }), draft: \'draft\', publishAt: \'at\' })').replace('title: t.String(),', 'title: t.String(), draft: t.Optional(t.Boolean()),').replace('localized: true,', 'localized: true, draft: \'draft\','))

      const { problems } = await checkContent(copy, undefined, true)

      expect(problems.map(problem => `${problem.file.split('/src/').at(-1)}:${problem.line} ${problem.code}`).sort()).toEqual([
        'content/news/fr/shown.md:4 held-back-reference',
        'content/news/fr/shown.md:5 held-back-reference',
      ])
      expect(await writeContentManifests(resolve(copy), join(copy, 'out'), undefined)).toBeGreaterThan(0)
    }
    finally {
      await rm(copy, { recursive: true, force: true })
    }
  }, 30_000)

  it('still checks a collection with a date field when one of its entries does not decode', async () => {
    const copy = await site({
      'authors/ada.md': AUTHOR,
      'authors/broken.md': '---\nname: 3\nat: 2999-01-01\n---\n',
      'news/fr/lost.md': post('author: ghost\n'),
    })

    try {
      const config = join(copy, 'src/content.config.ts')

      await Bun.write(config, (await Bun.file(config).text()).replace('collection(\'content/authors\', { schema: t.Object({ name: t.String() }) })', 'collection(\'content/authors\', { schema: t.Object({ name: t.String(), at: t.Optional(t.Date()) }), publishAt: \'at\' })'))

      const { problems } = await checkContent(copy, undefined, true)

      expect(problems.map(problem => problem.message).some(message => message.includes('author: references ghost'))).toBe(true)
    }
    finally {
      await rm(copy, { recursive: true, force: true })
    }
  }, 30_000)

  it('passes when every slug exists, and fails kay build when one does not', async () => {
    const good = await site({ 'authors/ada.md': AUTHOR, 'news/fr/ok.md': post('author: ada\n') })
    const bad = await site({ 'authors/ada.md': AUTHOR, 'news/fr/lost.md': post('author: ghost\n') })

    try {
      expect((await checkContent(good, undefined, true)).problems).toEqual([])
      expect(await writeContentManifests(resolve(good), join(good, 'out'), undefined)).toBe(2)
      await expect(writeContentManifests(resolve(bad), join(bad, 'out'), undefined)).rejects.toThrow('author: references ghost, which authors has no entry for')
    }
    finally {
      await rm(good, { recursive: true, force: true })
      await rm(bad, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('a write through kay/content', () => {
  it('refuses a slug the referenced collection lacks, by path', async () => {
    const authors = collection({ name: 'write-authors', load: () => [{ slug: 'ada', data: { name: 'Ada' } }] }, { schema: t.Object({ name: t.String(), friend: t.Optional(reference('writeAuthors')) }) })
    const posts = collection({ name: 'write-posts', load: () => [] }, { schema: t.Object({ author: reference('writeAuthors'), more: t.Array(reference('writeAuthors')) }) })
    const before = registerCollections([['writeAuthors', authors], ['writePosts', posts]])

    try {
      const refused = await entryIssues('writePosts', posts, { slug: 'a', data: { author: 'ghost', more: ['ada', 'zed'] } })

      expect(refused.issues.map(issue => [issue.path, issue.message])).toEqual([
        ['author', 'references ghost, which writeAuthors has no entry for'],
        ['more.1', 'references zed, which writeAuthors has no entry for'],
      ])
      expect((await entryIssues('writePosts', posts, { slug: 'a', data: { author: 'ada', more: [] } })).issues).toEqual([])
      expect((await entryIssues('writeAuthors', authors, { slug: 'zed', data: { name: 'Zed', friend: 'zed' } })).issues.map(issue => issue.path)).toEqual([])
    }
    finally {
      registerCollections(before)
    }
  })
})
