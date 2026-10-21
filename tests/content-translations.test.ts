import { utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { t } from 'elysia'
import { collection, removeEntry, saveEntry, translations } from '../src/content'
import { registerCollections } from '../src/content/edit'
import { contentPlace, setContentMode, setContentPlace } from '../src/content/load'
import { scratchDir } from './scratch'

const schema = t.Object({ title: t.String(), translationKey: t.Optional(t.String()) })

interface Row { slug: string, data: { title: string, translationKey?: string } }

// A loader over rows it keeps, counting its loads.
function counted(name: string, rows: Row[], extra: { ttl?: '50ms' } = {}) {
  const counts = { loads: 0 }
  const loader = {
    name,
    ...extra,
    load: () => {
      counts.loads++

      return rows.map(row => structuredClone(row))
    },
    save: (entry: { slug: string, locale?: string | undefined, data: Row['data'] }) => {
      const slug = entry.locale === undefined ? entry.slug : `${entry.locale}/${entry.slug}`
      const at = rows.findIndex(row => row.slug === slug)

      if (at === -1)
        rows.push({ slug, data: entry.data })
      else
        rows[at] = { slug, data: entry.data }
    },
    remove: (entry: { slug: string, locale?: string | undefined }) => {
      const slug = entry.locale === undefined ? entry.slug : `${entry.locale}/${entry.slug}`

      rows.splice(rows.findIndex(row => row.slug === slug), 1)
    },
  }

  return { loader, counts }
}

const asObject = (index: Awaited<ReturnType<typeof translations>>) => Object.fromEntries([...index].map(([key, group]) => [key, Object.fromEntries(group)]))

afterEach(() => setContentMode({ dev: false, prebuilt: false }))

describe('translations', () => {
  it('pairs the entries by translation key or slug, reading a loader once for any number of calls', async () => {
    const { loader, counts } = counted('index-pairs', [
      { slug: 'fr/bonjour', data: { title: 'Bonjour', translationKey: 'hello' } },
      { slug: 'en/hi', data: { title: 'Hi', translationKey: 'hello' } },
      { slug: 'fr/seul', data: { title: 'Seul' } },
    ])
    const before = registerCollections([['pages', collection(loader, { schema, localized: true })]])

    try {
      expect(asObject(await translations('pages'))).toEqual({ hello: { fr: 'bonjour', en: 'hi' }, seul: { fr: 'seul' } })
      await translations('pages')
      await translations('pages')
      expect(counts.loads).toBe(1)
    }
    finally {
      registerCollections(before)
    }
  })

  it('is empty for a collection that is not localized', async () => {
    const { loader, counts } = counted('index-plain', [{ slug: 'a', data: { title: 'A' } }])
    const before = registerCollections([['plain', collection(loader, { schema })]])

    try {
      expect((await translations('plain')).size).toBe(0)
      expect(counts.loads).toBe(0)
    }
    finally {
      registerCollections(before)
    }
  })

  it('is built again after a save, a remove and an invalidate, and not before', async () => {
    const { loader, counts } = counted('index-saves', [{ slug: 'fr/a', data: { title: 'A' } }])
    const pages = collection(loader, { schema, localized: true })
    const before = registerCollections([['pages', pages]])

    try {
      expect(asObject(await translations('pages'))).toEqual({ a: { fr: 'a' } })

      expect(await saveEntry('pages', { slug: 'a', locale: 'en', data: { title: 'A en' } })).toEqual({})
      expect(asObject(await translations('pages'))).toEqual({ a: { fr: 'a', en: 'a' } })

      const loads = counts.loads

      await translations('pages')
      expect(counts.loads).toBe(loads)

      expect(await removeEntry('pages', 'a', 'en')).toEqual({})
      expect(asObject(await translations('pages'))).toEqual({ a: { fr: 'a' } })

      const afterRemove = counts.loads

      pages.invalidate()
      await translations('pages')
      expect(counts.loads).toBe(afterRemove + 1)
    }
    finally {
      registerCollections(before)
    }
  })

  it('is built again once the loader\'s ttl passed', async () => {
    const { loader, counts } = counted('index-ttl', [{ slug: 'fr/a', data: { title: 'A' } }], { ttl: '50ms' })
    const before = registerCollections([['pages', collection(loader, { schema, localized: true })]])

    try {
      await translations('pages')
      await translations('pages')
      expect(counts.loads).toBe(1)
      await Bun.sleep(80)
      await translations('pages')
      expect(counts.loads).toBe(2)
    }
    finally {
      registerCollections(before)
    }
  })

  it('follows the files of a folder collection once they changed', async () => {
    const root = await scratchDir('translations-folder')
    const place = contentPlace()
    const files = {
      fr: join(root, 'pages/fr/a.md'),
      en: join(root, 'pages/en/b.md'),
    }

    await Bun.write(files.fr, '---\ntitle: A\ntranslationKey: k\n---\nbody\n')
    await Bun.write(files.en, '---\ntitle: B\ntranslationKey: k\n---\nbody\n')

    const old = new Date(Date.now() - 60_000)

    await Promise.all(Object.values(files).map(async file => utimes(file, old, old)))
    setContentPlace(root, root)

    const before = registerCollections([['pages', collection('pages', { schema, localized: true })]])

    try {
      expect(asObject(await translations('pages'))).toEqual({ k: { fr: 'a', en: 'b' } })

      await Bun.write(files.en, '---\ntitle: B\n---\nbody\n')
      await utimes(files.en, old, new Date(Date.now() - 30_000))
      expect(asObject(await translations('pages'))).toEqual({ k: { fr: 'a' }, b: { en: 'b' } })
    }
    finally {
      registerCollections(before)
      setContentPlace(place.root, place.base)
    }
  })
})
