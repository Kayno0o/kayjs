import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, setSystemTime } from 'bun:test'
import { t } from 'elysia'
import { check } from '../src/check'
import { collection, collectionInfo, contentKey, PUBLISH_TIMES } from '../src/content'
import { registerCollections } from '../src/content/edit'
import { clearContentMode, contentPlace, setContentMode, setContentPlace } from '../src/content/load'
import { refreshLocally } from '../src/runtime/cache'
import { inPreview } from '../src/server/preview'
import { delayUntil } from '../src/server/publishing'
import { fixtureCopy, scratchDir } from './scratch'

const NOW = new Date('2026-10-19T12:00:00Z')
const DEV = { dev: true, prebuilt: false }

interface Talk { slug: string, title?: string, at?: string | Date, ends?: string | Date, draft?: boolean }

// A collection of talks a loader gives, `at` being the date the option names.
function talks(items: Talk[], options: { draft?: 'draft' | ((entry: { data: { draft?: boolean | undefined } }) => boolean), localized?: boolean } = {}) {
  return collection({ name: `talks-${crypto.randomUUID()}`, load: () => items.map(({ slug, title = slug, at, ends, draft }) => ({ slug, data: { title, at, ends, draft } })) }, {
    schema: t.Object({ title: t.String(), at: t.Optional(t.Date()), ends: t.Optional(t.Date()), draft: t.Optional(t.Boolean()) }),
    publishAt: 'at',
    unpublishAt: 'ends',
    ...options,
  })
}

const slugs = async (talk: ReturnType<typeof talks>, locale?: string) => (await talk.all(locale)).map(entry => entry.slug)

afterEach(() => {
  setSystemTime()
  clearContentMode(DEV)
})

describe('publishAt', () => {
  it('holds back an entry whose date is ahead, and shows one whose date is past or absent', async () => {
    setSystemTime(NOW)

    const talk = talks([{ slug: 'later', at: '2026-10-20T08:00:00Z' }, { slug: 'earlier', at: '2026-10-18T08:00:00Z' }, { slug: 'none' }])

    expect(await slugs(talk)).toEqual(['earlier', 'none'])
    expect(await talk.get('later')).toBeUndefined()
    expect((await talk.get('earlier'))?.slug).toBe('earlier')
    expect((await talk.get('none'))?.slug).toBe('none')
  })

  it('shows the entry by itself once its date passes, on the very next read', async () => {
    setSystemTime(NOW)

    const talk = talks([{ slug: 'later', at: '2026-10-19T12:00:01Z' }])

    expect(await slugs(talk)).toEqual([])
    setSystemTime(new Date('2026-10-19T12:00:01Z'))
    expect(await slugs(talk)).toEqual(['later'])
    expect((await talk.get('later'))?.slug).toBe('later')
  })

  it('reads a date alone as 00:00 UTC, and a date with an offset as that instant, whatever the time zone of the server', async () => {
    const zone = process.env.TZ

    try {
      process.env.TZ = 'Pacific/Auckland'
      setSystemTime(new Date('2026-10-19T23:59:59Z'))

      const talk = talks([{ slug: 'day', at: '2026-10-20' }, { slug: 'paris', at: '2026-10-20T08:00:00+02:00' }])

      expect(await slugs(talk)).toEqual([])
      setSystemTime(new Date('2026-10-20T00:00:00Z'))
      expect(await slugs(talk)).toEqual(['day'])
      setSystemTime(new Date('2026-10-20T06:00:00Z'))
      expect(await slugs(talk)).toEqual(['day', 'paris'])
    }
    finally {
      if (zone === undefined)
        delete process.env.TZ
      else
        process.env.TZ = zone
    }
  })

  it('leaves a draft a draft whatever its date, as a field or a function says', async () => {
    setSystemTime(NOW)

    const items = [{ slug: 'held', at: '2026-10-01', draft: true }, { slug: 'free', at: '2026-10-01' }, { slug: 'later', at: '2026-11-01', draft: false }]

    expect(await slugs(talks(items, { draft: 'draft' }))).toEqual(['free'])
    expect(await slugs(talks(items, { draft: entry => entry.data.draft === true }))).toEqual(['free'])
  })

  it('shows a scheduled entry in development and to a visitor in preview mode, as it shows a draft', async () => {
    setSystemTime(NOW)

    const talk = talks([{ slug: 'later', at: '2026-12-01' }])

    expect(await slugs(talk)).toEqual([])
    expect(await inPreview(async () => slugs(talk))).toEqual(['later'])
    expect((await inPreview(async () => talk.get('later')))?.slug).toBe('later')
    setContentMode(DEV)
    expect(await slugs(talk)).toEqual(['later'])
  })

  it('leaves a scheduled translation out as a missing one, and shows it once its date passes', async () => {
    setSystemTime(NOW)

    const talk = collection({ name: `talks-${crypto.randomUUID()}`, load: () => [{ slug: 'en/hello', data: { title: 'Hello' } }, { slug: 'fr/hello', data: { title: 'Bonjour', at: '2026-12-01' } }, { slug: 'fr/other', data: { title: 'Autre' } }] }, {
      schema: t.Object({ title: t.String(), at: t.Optional(t.Date()) }),
      localized: true,
      publishAt: 'at',
    })

    expect((await talk.all('fr')).map(entry => `${entry.locale}/${entry.slug}`)).toEqual(['fr/other'])
    expect(await talk.get('hello', 'fr')).toBeUndefined()
    expect((await talk.get('hello', 'en'))?.data.title).toBe('Hello')
    expect(await talk.translation({ slug: 'hello', data: {} }, 'fr')).toBeUndefined()
    setSystemTime(new Date('2026-12-01T00:00:00Z'))
    expect((await talk.get('hello', 'fr'))?.data.title).toBe('Bonjour')
    expect((await talk.translation({ slug: 'hello', data: {} }, 'fr'))?.data.title).toBe('Bonjour')
  })

  it('schedules the Markdown files of a folder, which a refresh for the date does not read again', async () => {
    const dir = await scratchDir('publish-at-')
    const before = contentPlace()

    try {
      setContentPlace(dir, dir)
      setSystemTime(NOW)
      await Bun.write(join(dir, 'talks/now.md'), '---\ntitle: Now\n---\nNow\n')
      await Bun.write(join(dir, 'talks/later.md'), '---\ntitle: Later\nat: 2026-10-20T08:00:00Z\n---\nLater\n')

      const talk = collection('talks', { schema: t.Object({ title: t.String(), at: t.Optional(t.Date()) }), publishAt: 'at' })
      const first = await talk.all()

      expect(first.map(entry => entry.slug)).toEqual(['now'])
      refreshLocally(contentKey('talks'))
      expect(await talk.all()).toEqual(first)
      expect((await talk.all())[0]).toBe(first[0])
      setSystemTime(new Date('2026-10-20T08:00:00Z'))
      expect((await talk.all()).map(entry => entry.slug)).toEqual(['later', 'now'])
    }
    finally {
      setContentPlace(before.root, before.base)
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('takes an entry down at its unpublishAt date, on the very next read', async () => {
    setSystemTime(NOW)

    const talk = talks([{ slug: 'over', ends: '2026-10-19T11:59:59Z' }, { slug: 'ending', ends: '2026-10-19T12:00:01Z' }, { slug: 'open' }, { slug: 'window', at: '2026-10-19T11:00:00Z', ends: '2026-10-19T13:00:00Z' }, { slug: 'inverted', at: '2026-10-19T11:00:00Z', ends: '2026-10-19T10:00:00Z' }])

    expect(await slugs(talk)).toEqual(['ending', 'open', 'window'])
    expect(await talk.get('over')).toBeUndefined()
    setSystemTime(new Date('2026-10-19T12:00:01Z'))
    expect(await slugs(talk)).toEqual(['open', 'window'])
    expect(await talk.get('ending')).toBeUndefined()
    setSystemTime(new Date('2026-10-19T13:00:00Z'))
    expect(await slugs(talk)).toEqual(['open'])
  })

  it('reads an unpublishAt date alone as 00:00 UTC, and keeps the entry in development and in preview mode', async () => {
    setSystemTime(new Date('2026-10-20T00:00:00Z'))

    const talk = talks([{ slug: 'day', ends: '2026-10-20' }, { slug: 'next', ends: '2026-10-21' }])

    expect(await slugs(talk)).toEqual(['next'])
    expect(await inPreview(async () => slugs(talk))).toEqual(['day', 'next'])
    setContentMode(DEV)
    expect(await slugs(talk)).toEqual(['day', 'next'])
  })

  it('leaves a translation out once it ends, the default locale standing in as for a missing one', async () => {
    setSystemTime(NOW)

    const talk = collection({ name: `talks-${crypto.randomUUID()}`, load: () => [{ slug: 'en/hello', data: { title: 'Hello' } }, { slug: 'fr/hello', data: { title: 'Bonjour', ends: '2026-10-20' } }] }, {
      schema: t.Object({ title: t.String(), ends: t.Optional(t.Date()) }),
      localized: true,
      unpublishAt: 'ends',
    })

    expect((await talk.get('hello', 'fr'))?.data.title).toBe('Bonjour')
    setSystemTime(new Date('2026-10-20T00:00:00Z'))
    expect(await talk.get('hello', 'fr')).toBeUndefined()
    expect(await talk.translation({ slug: 'hello', data: {} }, 'fr')).toBeUndefined()
  })

  it('refuses an unpublishAt that is not a date, at the collection', () => {
    expect(() => collection({ name: 'bad', load: () => [] }, { schema: t.Object({ title: t.String() }), unpublishAt: 'title' as never })).toThrow('unpublishAt names title, which is not an s.Date() field')
    expect(() => collection({ name: 'bad', load: () => [] }, { schema: t.Object({ title: t.String() }), unpublishAt: 'missing' as never })).toThrow('unpublishAt names missing, which is not an s.Date() field')
  })

  it('refuses a field that is not a date, at the collection', () => {
    expect(() => collection({ name: 'bad', load: () => [] }, { schema: t.Object({ title: t.String() }), publishAt: 'title' as never })).toThrow('publishAt names title, which is not an s.Date() field')
    expect(() => collection({ name: 'bad', load: () => [] }, { schema: t.Object({ title: t.String() }), publishAt: 'missing' as never })).toThrow('publishAt names missing, which is not an s.Date() field')
    expect(() => collection({ name: 'ok', load: () => [] }, { schema: t.Object({ at: t.Optional(t.Date()) }), publishAt: 'at' })).not.toThrow()
  })

  it('is a type error for a field that holds no date', () => {
    const schema = t.Object({ title: t.String(), at: t.Date() })

    // @ts-expect-error `title` holds a string
    expect(() => collection({ name: 'bad', load: () => [] }, { schema, publishAt: 'title' })).toThrow()
  })
})

describe('the CMS', () => {
  it('is told the fields, and reads every entry whether it is held back or not', async () => {
    const talk = talks([{ slug: 'later', at: '2999-01-01' }])
    const before = registerCollections([['talks', talk]])

    try {
      expect(await collectionInfo('talks', { counts: false })).toMatchObject({ publishField: 'at', unpublishField: 'ends' })
    }
    finally {
      registerCollections(before)
    }
  })
})

describe('the dates a collection holds', () => {
  it('lists the dates of every entry that has one, once each and in order, held back or not', async () => {
    const talk = talks([{ slug: 'a', at: '2026-10-18T00:00:00Z' }, { slug: 'b', at: '2026-10-20T00:00:00Z' }, { slug: 'c', at: '2026-10-22T00:00:00Z' }, { slug: 'd', at: '2026-10-20T00:00:00Z' }, { slug: 'e' }])

    expect(await talk[PUBLISH_TIMES]()).toEqual([Date.parse('2026-10-18T00:00:00Z'), Date.parse('2026-10-20T00:00:00Z'), Date.parse('2026-10-22T00:00:00Z')])
  })

  it('lists the unpublishAt dates among them', async () => {
    const talk = talks([{ slug: 'a', at: '2026-10-18T00:00:00Z', ends: '2026-10-21T00:00:00Z' }, { slug: 'b', ends: '2026-10-19T00:00:00Z' }])

    expect(await talk[PUBLISH_TIMES]()).toEqual([Date.parse('2026-10-18T00:00:00Z'), Date.parse('2026-10-19T00:00:00Z'), Date.parse('2026-10-21T00:00:00Z')])
  })

  it('is empty for a collection with no publishAt', async () => {
    expect(await collection({ name: 'plain', load: () => [{ slug: 'a', data: {} }] }, { schema: t.Object({}) })[PUBLISH_TIMES]()).toEqual([])
  })
})

describe('delayUntil', () => {
  it('waits until the date, at once for a date past, and no longer than a timer holds', () => {
    expect(delayUntil(1000, 400)).toBe(600)
    expect(delayUntil(400, 1000)).toBe(0)
    expect(delayUntil(Date.parse('2999-01-01'), Date.now())).toBe(2 ** 31 - 1)
  })
})

describe('kay check', () => {
  it('reports a publishAt naming a field that is not an s.Date(), at the option', async () => {
    const copy = await fixtureCopy('content')
    const config = join(copy, 'src/content.config.ts')

    try {
      await Bun.write(config, (await Bun.file(config).text()).replace('  draft: post => post.data.draft === true,', '  draft: post => post.data.draft === true,\n  publishAt: \'title\','))

      const diagnostics = await check(copy, { site: 'https://blog.example', lints: { seo: 'allow' } })
      const found = diagnostics.filter(diagnostic => diagnostic.file.endsWith('src/content.config.ts'))

      expect(found).toContainEqual(expect.objectContaining({ line: 17, message: 'Type \'"title"\' is not assignable to type \'"date"\'.' }))
      expect(found.some(diagnostic => diagnostic.message.includes('publishAt names title, which is not an s.Date() field'))).toBe(true)
    }
    finally {
      await rm(copy, { recursive: true, force: true })
    }
  }, 30_000)
})
