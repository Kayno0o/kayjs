import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { entries, entrySource, removeEntry, saveEntry } from '../src/content'
import { testSite } from '../src/test'
import { cms } from './fixtures/cms/src/cms'
import { notes } from './fixtures/cms/src/content.config'

const FIXTURE = 'tests/fixtures/cms/src'
const site = await testSite({ routes: `${FIXTURE}/routes`, content: `${FIXTURE}/content.config.ts`, islands: false })
const REAL = join(import.meta.dir, 'fixtures/cms/src/content/articles')

afterAll(async () => site.close())

beforeEach(async () => site.content.reset())

// Writes an article as a CMS would, to the file kay gives it.
async function write(slug: string, locale: string, title: string, create = false) {
  const source = await entrySource('articles', slug, { title }, { locale, create })

  if ('issues' in source)
    throw new Error(source.issues.map(issue => issue.message).join(', '))

  await Bun.write(source.file.absolute, source.file.text)

  return source.file
}

describe('the content of a test site', () => {
  it('writes a folder entry in a copy, never into the real src/content, and names the real file', async () => {
    const before = await Bun.file(join(REAL, 'fr/hello.md')).text()
    const file = await write('hello', 'fr', 'Changed')

    expect(file.absolute).toContain('.kay/scratch/')
    expect(file.path).toBe('tests/fixtures/cms/src/content/articles/fr/hello.md')
    expect(file.repoPath).toBe('tests/fixtures/cms/src/content/articles/fr/hello.md')
    expect((await entries('articles', { slug: 'hello', locale: 'fr' }))[0]!.path).toBe(file.repoPath)
    expect(await Bun.file(join(REAL, 'fr/hello.md')).text()).toBe(before)
    expect((await site.visit('/articles/hello')).text('h1')).toBe('Changed')
  })

  it('creates a new entry in the copy only', async () => {
    const files = await readdir(join(REAL, 'fr'))

    await write('fresh', 'fr', 'Fresh', true)
    expect(await readdir(join(REAL, 'fr'))).toEqual(files)
    expect((await site.visit('/articles/fresh')).text('h1')).toBe('Fresh')
  })

  it('puts the files back as the project holds them on reset', async () => {
    await write('hello', 'fr', 'Changed')
    await write('fresh', 'fr', 'Fresh', true)
    await site.content.reset()
    expect((await site.visit('/articles/hello')).text('h1')).not.toBe('Changed')
    expect((await site.visit('/articles/fresh')).status).toBe(404)
  })

  it('starts a folder collection from the entries a seed lists, the others left as they are', async () => {
    await site.content.reset({ articles: [{ slug: 'only', locale: 'fr', data: { title: 'Only' }, body: 'Just this.' }] })
    expect((await site.visit('/articles/only')).text('h1')).toBe('Only')
    expect((await site.visit('/articles/hello')).status).toBe(404)
    expect((await site.visit('/news/launch')).status).toBe(200)
  })

  it('refuses a seed entry its schema refuses, and one with no locale in a localized collection', async () => {
    await expect(site.content.seed('articles', [{ slug: 'bad', locale: 'fr', data: { title: 3 } }])).rejects.toThrow('bad')
    await expect(site.content.seed('notes', [{ slug: 'hello', data: { title: 'Hello' } }])).rejects.toThrow('no locale')
    await expect(site.content.seed('missing', [])).rejects.toThrow('no collection is exported from the content config as missing; it exports')
  })

  it('writes a raw file in the copy, refusing a path out of the folder and a collection that is loaded', async () => {
    await site.content.write('pages', 'raw.json', '{ "title": ')
    expect(await Bun.file(join(import.meta.dir, 'fixtures/cms/src/content/pages/raw.json')).exists()).toBe(false)
    await expect(site.content.write('pages', '../escape.json', '{}')).rejects.toThrow('lies outside')
    await expect(site.content.write('news', 'a.json', '{}')).rejects.toThrow('loaded: seed it instead')
  })

  it('seeds a loaded collection in memory, its save and remove working on the seed, never on its source', async () => {
    const source = structuredClone(cms.entries)

    await site.content.seed('news', [{ slug: 'seeded', data: { title: 'Seeded', published: true, tags: [] }, body: 'Hi' }])
    expect((await site.visit('/news')).text('ul.news')).toBe('Seeded')
    expect((await saveEntry('news', { slug: 'other', data: { title: 'Other', published: true, tags: [] } })).issues).toBeUndefined()
    expect((await site.visit('/news')).text('ul.news')).toContain('Other')
    expect((await removeEntry('news', 'seeded')).issues).toBeUndefined()
    expect((await site.visit('/news')).text('ul.news')).toBe('Other')
    expect(cms.entries).toEqual(source)
  })

  it('ignores a file written straight into the project\'s folder once the content is used, saved to or not', async () => {
    const direct = join(REAL, 'fr/direct.md')

    await site.content.seed('news', [{ slug: 'seeded', data: { title: 'Seeded', published: true, tags: [] } }])

    try {
      await Bun.write(direct, '---\ntitle: Direct\n---\n')
      expect((await site.visit('/articles/direct')).status).toBe(404)
    }
    finally {
      await rm(direct, { force: true })
    }
  })

  it('seeds the html of a loaded entry', async () => {
    await site.content.seed('notes', [{ slug: 'hello', locale: 'en', data: { title: 'Hello' }, html: '<p>Seeded html</p>' }])
    expect(await notes.loader?.load({ preview: false })).toEqual([{ slug: 'en/hello', data: { title: 'Hello' }, html: '<p>Seeded html</p>' }])
  })

  it('lets a reset end a copy under way without the copy landing in the next test', async () => {
    const direct = join(REAL, 'fr/raced.md')

    await Bun.write(direct, '---\ntitle: Raced\n---\n')

    try {
      const writing = site.content.write('pages', 'raw.json', '{}')

      await site.content.reset()
      await Promise.allSettled([writing])
      expect((await site.visit('/articles/raced')).status).toBe(200)
    }
    finally {
      await rm(direct, { force: true })
    }
  })

  it('gives a loaded collection back its own loader on reset', async () => {
    await site.content.seed('news', [{ slug: 'seeded', data: { title: 'Seeded', published: true, tags: [] } }])
    await site.content.reset()
    expect((await site.visit('/news')).text('ul.news')).toBe('Launch day')
  })
})
