import type { LoadedEntry } from '../src/content'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { t } from 'elysia'
import { collection, convertField, entries, renameField, saveEntry, setField, unique } from '../src/content'
import { entryIssues, registerCollections } from '../src/content/edit'
import { contentPlace, setContentMode, setContentPlace } from '../src/content/load'
import { migrateData, migrateEntries } from '../src/content/migrate'
import { ContentError, dataIssues, decodeEntries, validEntries } from '../src/content/validate'
import { setLogSink } from '../src/runtime/log'
import { scratchDir } from './scratch'

type Row = LoadedEntry & { body?: string | undefined }

// A loader over rows it keeps, whose saves it records.
function store(name: string, rows: Row[], extra: { failSave?: boolean } = {}) {
  const saved: unknown[] = []
  const loader = {
    name,
    load: () => rows.map(row => structuredClone(row)),
    save: (entry: { slug: string, locale?: string | undefined, data: unknown, body?: string | undefined }) => {
      if (extra.failSave)
        throw new Error('database down')

      saved.push(entry)

      const place = entry.locale === undefined ? entry.slug : `${entry.locale}/${entry.slug}`
      const at = rows.findIndex(row => row.slug === place)
      const row = { slug: place, data: entry.data, ...entry.body !== undefined && { body: entry.body } }

      if (at === -1)
        rows.push(row)
      else
        rows[at] = row
    },
  }

  return { loader, saved, rows }
}

const logs: { level: string, message: string }[] = []

setLogSink((level, message) => void logs.push({ level, message }))

afterEach(() => {
  logs.length = 0
  setContentMode({ dev: false, prebuilt: false })
})

// What a promise rejected with, or undefined once it resolved.
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  }
  catch (error) {
    return error
  }

  return undefined
}

const MODES = [{ dev: false, prebuilt: false }, { dev: true, prebuilt: false }]

describe('a stored entry the schema refuses', () => {
  for (const mode of MODES) {
    it(`leaves out only itself and says so, in ${mode.dev ? 'development' : 'production'}`, async () => {
      setContentMode(mode)

      const { loader } = store(`bad-${mode.dev}`, [
        { slug: 'good', data: { title: 'Good', price: 3 } },
        { slug: 'stale', data: { title: 'Stale' } },
        { slug: 'worse', data: { title: 4, price: 'x' } },
      ])
      const packs = collection(loader, { schema: t.Object({ title: t.String(), price: t.Integer() }) })

      expect((await packs.all()).map(entry => entry.slug)).toEqual(['good'])
      expect(await packs.get('stale')).toBeUndefined()
      expect((await packs.get('good'))?.data.price).toBe(3)

      const warned = logs.filter(log => log.level === 'warn')

      expect(warned).toHaveLength(1)
      expect(warned[0]!.message).toContain('2 stored entries of bad-')
      expect(warned[0]!.message).toContain('stale price: Price is required')
      expect(warned[0]!.message).toContain('migrations')
    })
  }

  it('is left out of a localized collection as well, the others still paired', async () => {
    const { loader } = store('bad-localized', [
      { slug: 'fr/a', data: { title: 'A' } },
      { slug: 'en/a', data: {} },
      { slug: 'en/b', data: { title: 'B' } },
    ])
    const pages = collection(loader, { schema: t.Object({ title: t.String() }), localized: true })

    expect((await pages.all('en')).map(entry => `${entry.locale}/${entry.slug}`)).toEqual(['en/b'])
    expect((await pages.get('a', 'fr'))?.data.title).toBe('A')
  })

  it('names the whole path of a nested problem, once per type, on the line of its top-level field', () => {
    const schema = t.Object({ packs: t.Array(t.Object({ price: t.Integer(), label: t.String() })) })
    const entry = { slug: 'a', file: 'a.json', data: { packs: [{ price: '100 à 200 €', label: 'x' }, { price: 3 }] }, lines: { packs: 4 } }

    try {
      decodeEntries([entry], schema, {})
      expect.unreachable()
    }
    catch (error) {
      expect(error).toBeInstanceOf(ContentError)
      expect((error as ContentError).problems.map(problem => problem.line)).toEqual([4, 4])
      expect((error as ContentError).problems[0]!.message).not.toContain('\'integer\', \'integer\'')
      expect((error as ContentError).problems.map(problem => problem.message.slice(0, problem.message.indexOf(':')))).toEqual(['packs.0.price', 'packs.1.label'])
    }
  })

  it('is still reported whole by the validation a build and `kay check` run', () => {
    const schema = t.Object({ title: t.String() })
    const entries = [{ slug: 'a', file: 'a.json', data: {}, lines: {} }, { slug: 'b', file: 'b.json', data: { title: 'B' }, lines: {} }]

    expect(() => decodeEntries(entries, schema, {})).toThrow(ContentError)
    expect(validEntries(entries, schema, {}).entries.map(entry => entry.slug)).toEqual(['b'])
  })
})

describe('defaults', () => {
  const schema = t.Object({
    title: t.String({ default: 'Untitled' }),
    seo: t.Object({ robots: t.String({ default: 'index' }), title: t.Optional(t.String()) }),
    packs: t.Array(t.Object({ name: t.String(), size: t.Integer({ default: 1 }) })),
    extra: t.Object({ on: t.Boolean({ default: false }) }, { default: { on: true } }),
  })

  it('fill nested objects and list items, a default object as it is', () => {
    const entry = { slug: 'a', file: 'a.json', data: { seo: {}, packs: [{ name: 'x' }, { name: 'y', size: 5 }] }, lines: {} }

    expect(decodeEntries([entry], schema, {})[0]!.data).toEqual({ title: 'Untitled', seo: { robots: 'index' }, packs: [{ name: 'x', size: 1 }, { name: 'y', size: 5 }], extra: { on: true } })
    expect(entry.data).toEqual({ seo: {}, packs: [{ name: 'x' }, { name: 'y', size: 5 }] })
  })

  it('count for the problems a draft is checked against, with the full path of the rest', () => {
    expect(dataIssues(schema, { seo: {}, packs: [{ size: 2 }] })).toEqual([{ path: 'packs.0.name', message: expect.any(String) }])
  })
})

describe('migrations', () => {
  const schema = t.Object({ title: t.String(), price: t.Integer(), visible: t.Boolean() })
  const steps = [renameField('name', 'title'), convertField('price', value => typeof value === 'string' ? Number.parseInt(value, 10) : value), setField('visible', true)]

  it('carry a stored entry over, stop once the schema accepts it and leave an accepted one alone', () => {
    expect(migrateData(schema, steps, { name: 'A', price: '100 à 200 €' })).toEqual({ data: { title: 'A', price: 100, visible: true }, changed: true })

    const fine = { title: 'A', price: 1, visible: false }

    expect(migrateData(schema, steps, fine)).toEqual({ data: fine, changed: false })
    expect(migrateData(schema, [() => ({ nothing: 1 })], { title: 'A' }).changed).toBe(false)
    expect(migrateData(schema, [], { title: 'A' }).changed).toBe(false)
  })

  it('give the step a copy, and report one that throws without changing the data', () => {
    const stored = { name: 'A', price: 1 }

    migrateData(schema, [(data) => {
      data.name = 'changed'

      return data
    }], stored)
    expect(stored).toEqual({ name: 'A', price: 1 })

    const boom = new Error('boom')

    expect(migrateData(schema, [() => {
      throw boom
    }], stored)).toEqual({ data: stored, changed: false, error: boom })
  })

  for (const mode of MODES) {
    it(`rewrite a loader's entry once through its save and read plain after, in ${mode.dev ? 'development' : 'production'}`, async () => {
      setContentMode(mode)

      const { loader, saved } = store(`migrated-${mode.dev}`, [
        { slug: 'old', data: { name: 'Old', price: '100 à 200 €' }, body: 'Hello **world**' },
        { slug: 'new', data: { title: 'New', price: 5, visible: false } },
      ])
      const packs = collection(loader, { schema, migrations: steps })

      expect((await packs.all()).map(entry => entry.data)).toEqual([{ title: 'New', price: 5, visible: false }, { title: 'Old', price: 100, visible: true }])
      expect(saved).toEqual([{ slug: 'old', data: { title: 'Old', price: 100, visible: true }, body: 'Hello **world**' }])
      expect(logs.filter(log => log.level === 'warn')).toEqual([])

      packs.invalidate()
      expect((await packs.get('old'))?.data.price).toBe(100)
      expect(saved).toHaveLength(1)
    })
  }

  it('write a localized entry back with its locale split from its slug', async () => {
    const { loader, saved } = store('migrated-localized', [{ slug: 'fr/old', data: { name: 'Old', price: 1 } }])
    const packs = collection(loader, { schema, migrations: steps, localized: true })

    expect((await packs.get('old', 'fr'))?.data.title).toBe('Old')
    expect(saved).toEqual([{ slug: 'old', locale: 'fr', data: { title: 'Old', price: 1, visible: true } }])
  })

  it('write back only the entries that proved valid, and leave one an editor changed meanwhile', async () => {
    const { loader, saved, rows } = store('migrated-guarded', [
      { slug: 'old', data: { name: 'Old', price: 1 } },
      { slug: 'dup', data: { name: 'One', price: 1 } },
      { slug: 'dup', data: { name: 'Two', price: 1 } },
      { data: { name: 'No slug', price: 1 } } as Row,
    ])

    expect(await rejection(collection(loader, { schema, migrations: steps }).all())).toBeInstanceOf(ContentError)
    expect(saved).toEqual([])

    rows.splice(1, 3)

    const edited = store('migrated-edited', rows)
    const packs = collection({ ...edited.loader, load: () => {
      const given = rows.map(row => structuredClone(row))

      // An editor saves the entry between the load and the write-back.
      rows[0] = { slug: 'old', data: { title: 'Fixed by hand', price: 2, visible: true } }

      return given
    } }, { schema, migrations: steps })

    expect((await packs.all()).map(entry => entry.data.title)).toEqual(['Old'])
    expect(edited.saved).toEqual([])
    expect(rows[0]!.data).toEqual({ title: 'Fixed by hand', price: 2, visible: true })
  })

  it('read a loader without get once for all the entries it carries over', async () => {
    const { loader, saved, rows } = store('migrated-many', Array.from({ length: 5 }, (_, index) => ({ slug: `old-${index}`, data: { name: `Old ${index}`, price: index } })))
    let loads = 0
    const counted = { ...loader, load: () => {
      loads++

      return rows.map(row => structuredClone(row))
    } }

    expect((await collection(counted, { schema, migrations: steps }).all()).length).toBe(5)
    expect(saved).toHaveLength(5)
    expect(loads).toBe(2)
  })

  it('write back in the collection\'s turn, behind an editor\'s save already under way and without deadlocking a save that loads it', async () => {
    const { loader } = store('migrated-turn', [{ slug: 'old', data: { name: 'Old', price: 1 } }])
    const order: string[] = []
    const release = Promise.withResolvers<void>()
    const slow = { ...loader, save: async (entry: Parameters<typeof loader.save>[0]) => {
      order.push(`save ${entry.slug}`)

      if (entry.slug === 'editor') {
        await release.promise
        order.push('done editor')
      }

      loader.save(entry)
    } }
    const packs = collection(slow, { schema, migrations: steps })
    const before = registerCollections([['turns', packs]])

    try {
      const editing = saveEntry('turns', { slug: 'editor', data: { title: 'Editor', price: 2, visible: true } })

      await Bun.sleep(20)

      const reading = packs.all()

      await Bun.sleep(20)
      expect(order).toEqual(['save editor'])
      release.resolve()
      expect(await editing).toEqual({})
      expect((await reading).map(entry => entry.slug)).toEqual(['old'])
      expect(order).toEqual(['save editor', 'done editor', 'save old'])
    }
    finally {
      registerCollections(before)
    }
  })

  it('reports a localized entry without a slug as the collection does, not as a crash', async () => {
    const { loader, saved } = store('migrated-slugless', [{ data: { name: 'No slug', price: 1 } } as Row])

    expect(await rejection(collection(loader, { schema, migrations: steps, localized: true }).all())).toBeInstanceOf(ContentError)
    expect(saved).toEqual([])
  })

  it('keep a read going when the save fails or a step throws, the entry that cannot be carried over left out', async () => {
    const failing = store('migrated-failing', [{ slug: 'old', data: { name: 'Old', price: 1 } }, { slug: 'odd', data: { name: 'Odd', price: 2 } }], { failSave: true })
    const packs = collection(failing.loader, { schema, migrations: steps })

    expect((await packs.all()).map(entry => entry.slug)).toEqual(['odd', 'old'])
    expect(logs.filter(log => log.level === 'warn').map(log => log.message)).toEqual([expect.stringContaining('could not write the migrated entry old'), expect.stringContaining('could not write the migrated entry odd')])

    logs.length = 0

    const throwing = store('migrated-throwing', [{ slug: 'old', data: { name: 'Old' } }, { slug: 'fine', data: { title: 'Fine', price: 1, visible: true } }])
    const guarded = collection(throwing.loader, { schema, migrations: [() => {
      throw new Error('boom')
    }] })

    expect((await guarded.all()).map(entry => entry.slug)).toEqual(['fine'])
    expect(logs.some(log => log.message.includes('a migration of migrated-throwing threw on old'))).toBe(true)
    expect(logs.find(log => log.message.includes('do not match') || log.message.includes('does not match'))?.message).not.toContain('or with `migrations`')
  })

  it('migrate a folder\'s entries as read, the files untouched, in every mode', async () => {
    const root = await scratchDir('migrations-')
    const before = contentPlace()

    try {
      await Bun.write(join(root, 'packs/old.json'), JSON.stringify({ name: 'Old', price: '7 €' }))
      await Bun.write(join(root, 'packs/new.json'), JSON.stringify({ title: 'New', price: 7, visible: false }))
      setContentPlace(root, root)

      for (const mode of MODES) {
        setContentMode(mode)

        const packs = collection('packs', { schema, migrations: steps })

        expect((await packs.all()).map(entry => entry.data.title)).toEqual(['New', 'Old'])
        packs.invalidate()
      }

      expect(await Bun.file(join(root, 'packs/old.json')).json()).toEqual({ name: 'Old', price: '7 €' })

      const raw = [{ slug: 'old', file: 'packs/old.json', data: { name: 'Old', price: '7' }, lines: {} }]

      expect(migrateEntries('packs', raw, schema, steps)[0]!.data).toEqual({ title: 'Old', price: 7, visible: true })
      expect(migrateEntries('packs', raw, schema, undefined)).toBe(raw)
    }
    finally {
      setContentPlace(before.root, before.base)
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('a CMS editing a collection with stored entries the schema refuses', () => {
  it('lists the refused entry and opens it migrated, and a save fixes it for the pages', async () => {
    const { loader, rows } = store('editing', [
      { slug: 'stale', data: { title: 'Stale' } },
      { slug: 'old', data: { name: 'Old', price: 4 } },
      { slug: 'good', data: { title: 'Good', price: 3, visible: true } },
    ])
    const schema = t.Object({ title: t.String(), price: t.Integer(), visible: t.Boolean() })
    const packs = collection(loader, { schema, migrations: [renameField('name', 'title'), setField('visible', true)] })
    const before = registerCollections([['packs', packs]])

    try {
      const listed = await entries('packs')

      expect(listed.map(entry => entry.slug)).toEqual(['stale', 'old', 'good'])
      expect(listed.find(entry => entry.slug === 'old')?.data).toEqual({ title: 'Old', price: 4, visible: true })
      expect(listed.find(entry => entry.slug === 'stale')?.data).toEqual({ title: 'Stale' })
      expect((await packs.all()).map(entry => entry.slug)).toEqual(['good', 'old'])
      expect(await saveEntry('packs', { slug: 'stale', data: { title: 'Stale', price: 9, visible: false } })).toEqual({})
      expect((await packs.all()).map(entry => entry.slug)).toEqual(['good', 'old', 'stale'])
      expect(rows.find(row => row.slug === 'old')?.data).toEqual({ title: 'Old', price: 4, visible: true })
    }
    finally {
      registerCollections(before)
    }
  })
})

describe('a unique field', () => {
  it('holds for two saves of one value made at once, the second refused in its turn', async () => {
    const schema = t.Object({ code: unique(t.String()) })
    const { loader } = store('uniques-race', [])
    const packs = collection(loader, { schema })
    const before = registerCollections([['uniquesRace', packs]])

    try {
      const results = await Promise.all([saveEntry('uniquesRace', { slug: 'a', data: { code: 'X' } }), saveEntry('uniquesRace', { slug: 'b', data: { code: 'X' } })])

      expect(results.filter(result => result.issues !== undefined)).toHaveLength(1)
      expect((await packs.all()).map(entry => entry.slug)).toEqual(['a'])
    }
    finally {
      registerCollections(before)
    }
  })

  it('refuses a save that repeats another entry\'s value, the entry itself and other locales excepted', async () => {
    const schema = t.Object({ code: unique(t.String()), name: t.String() })
    const { loader } = store('uniques', [
      { slug: 'fr/a', data: { code: 'A', name: 'A' } },
      { slug: 'en/a', data: { code: 'A', name: 'A' } },
      { slug: 'fr/b', data: { code: 'B', name: 'B' } },
    ])
    const packs = collection(loader, { schema, localized: true })
    const before = registerCollections([['uniques', packs]])

    try {
      const at = { collection: 'uniques', slug: 'c', locale: 'fr' }

      expect((await entryIssues('uniques', packs, { slug: 'c', locale: 'fr', data: { code: 'A', name: 'C' } })).issues).toEqual([{ ...at, path: 'code', message: 'is already the code of a' }])
      expect((await entryIssues('uniques', packs, { slug: 'a', locale: 'fr', data: { code: 'A', name: 'A2' } })).issues).toEqual([])
      expect((await entryIssues('uniques', packs, { slug: 'c', locale: 'fr', data: { code: 'C', name: 'C' } })).issues).toEqual([])
      expect(await saveEntry('uniques', { slug: 'c', locale: 'fr', data: { code: 'B', name: 'C' } })).toMatchObject({ issues: [{ path: 'code' }] })
    }
    finally {
      registerCollections(before)
    }
  })

  it('hands a loader\'s save the data with its defaults filled in and a date as its text', async () => {
    const seen: string[] = []
    const events = collection({
      name: 'events',
      load: () => [],
      save: ({ data }) => {
        // A date arrives as the JSON a CMS sends holds it, so it is text, never a `Date`.
        seen.push(`${data.at.slice(0, 10)}:${data.seats}`)
      },
    }, { schema: t.Object({ at: t.Date(), seats: t.Integer({ default: 10 }) }) })
    const before = registerCollections([['events', events]])

    try {
      expect(await saveEntry('events', { slug: 'launch', data: { at: '2026-10-21T10:00:00.000Z' } })).toEqual({})
      expect(seen).toEqual(['2026-10-21:10'])
    }
    finally {
      registerCollections(before)
    }
  })
})
