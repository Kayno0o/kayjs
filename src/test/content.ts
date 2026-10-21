import type { Collection, ContentLoader, LoadedEntry } from '../content'
import { existsSync } from 'node:fs'
import { cp, mkdir, rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { KayError } from '../compiler/errors'
import { entrySource } from '../content'
import { contentPlace, redirectFolders } from '../content/load'
import { namedCollections } from '../content/server'
import { scratchDir } from './scratch'

// An entry a test puts in a collection: a loaded collection's `slug` is the one its loader gives (`fr/launch` in a localized collection), here split into `locale` and `slug`.
export interface SeedEntry {
  slug: string
  locale?: string | undefined
  data: Record<string, unknown>
  body?: string | undefined
}

export type ContentSeed = Record<string, SeedEntry[]>

export interface TestContent {
  // Puts the content back as the project holds it: each folder collection read from its own folder again, and each loaded collection back on its own loader. With `seed`, the collections it names hold exactly the entries it lists instead, a folder's written as files in the copy the test works on, a loaded one's kept in memory with its `save` and `remove` working on them.
  reset: (seed?: ContentSeed) => Promise<void>
  // Makes the collection exported as `name` hold exactly these entries, the others left as they are.
  seed: (name: string, entries: SeedEntry[]) => Promise<void>
  // Writes a file of a folder collection, `file` relative to its folder, as it is: for a test of an entry that does not parse, or of a file kay does not write. It goes in the copy, never in the project.
  write: (name: string, file: string, text: string) => Promise<void>
}

type Methods = Pick<ContentLoader, 'load' | 'get' | 'count' | 'save' | 'remove' | 'store'>

const METHODS = ['load', 'get', 'count', 'save', 'remove', 'store'] as const

// Keeps a test's saves apart from the project's content: a folder collection moves to a copy under `.kay/scratch` as the first save or delete reaches it, so a CMS's save never lands in the real `src/content`, and a loaded collection can hold entries the test gives it instead of its source's.
async function makeContent(root: string, config: string | undefined): Promise<{ content: TestContent, release: () => Promise<void> }> {
  const named = await namedCollections(root, config)
  const folders = named.filter((entry): entry is [string, Collection<unknown> & { dir: string }] => entry[1].dir !== undefined)
  const copies = new Map<string, string>()
  const originals = new Map<Collection<unknown>, Partial<Methods>>()
  const base = await scratchDir('content-', root)
  let released = false

  const indexOf = (real: string) => folders.findIndex(([, collection]) => resolve(contentPlace().base, collection.dir) === real)

  const isolating = new Map<string, Promise<void>>()

  // Moves a folder to a copy, which its collection is read from from then on; every caller waits for the one copy.
  const isolate = async (real: string) => {
    const index = indexOf(real)

    if (index === -1)
      return

    const pending = isolating.get(real) ?? (async () => {
      const target = join(base, String(index))

      await rm(target, { recursive: true, force: true })

      if (existsSync(real))
        await cp(real, target, { recursive: true })
      else
        await mkdir(target, { recursive: true })

      copies.set(real, target)
      folders[index]![1].invalidate()
    })()

    isolating.set(real, pending)
    await pending
  }

  const restoreLoader = (collection: Collection<unknown>) => {
    const loader = collection.loader as Partial<Methods> | undefined
    const kept = originals.get(collection)

    if (loader === undefined || kept === undefined)
      return

    for (const method of METHODS) {
      if (method in kept)
        (loader as Record<string, unknown>)[method] = kept[method]
      else
        delete loader[method]
    }

    originals.delete(collection)
  }

  const entriesOf = (name: string, collection: Collection<unknown>, seeded: SeedEntry[]) => {
    const localized = collection.options.localized === true

    return seeded.map((entry): LoadedEntry => {
      if (localized && entry.locale === undefined)
        throw new KayError('content-api-misuse', `kay: the seed of ${name} gives ${entry.slug} no locale, which each entry of a localized collection has`)

      return { slug: localized ? `${entry.locale}/${entry.slug}` : entry.slug, data: entry.data, ...entry.body !== undefined && { body: entry.body } }
    })
  }

  // Replaces a loader's methods by ones working on entries kept in memory, `save` and `remove` only where the loader declares them.
  const seedLoaded = (name: string, collection: Collection<unknown>, seeded: SeedEntry[]) => {
    const loader = collection.loader as (ContentLoader & Partial<Methods>) | undefined

    if (loader === undefined)
      return

    restoreLoader(collection)
    originals.set(collection, Object.fromEntries(METHODS.filter(method => method in loader).map(method => [method, loader[method]])))

    let held = entriesOf(name, collection, seeded)
    const placeOf = (entry: { slug: string, locale?: string | undefined }) => entry.locale === undefined ? entry.slug : `${entry.locale}/${entry.slug}`
    const without = (place: string) => held.filter(entry => entry.slug !== place)

    loader.load = () => held
    loader.store = undefined

    if (originals.get(collection)?.get !== undefined)
      loader.get = place => held.find(entry => entry.slug === place)

    if (originals.get(collection)?.count !== undefined)
      loader.count = () => held.length

    if (loader.save !== undefined) {
      loader.save = (entry) => {
        held = [...without(placeOf(entry)), { slug: placeOf(entry), data: entry.data, ...entry.body !== undefined && { body: entry.body } }]
      }
    }

    if (loader.remove !== undefined) {
      loader.remove = (entry) => {
        held = without(placeOf(entry))
      }
    }
  }

  // Gives a folder collection an empty copy, then writes the entries as the CMS would, each checked against the collection's schema.
  const seedFolder = async (name: string, dir: string, seeded: SeedEntry[]) => {
    const real = resolve(contentPlace().base, dir)
    const target = join(base, String(indexOf(real)))

    await rm(target, { recursive: true, force: true })
    await mkdir(target, { recursive: true })
    copies.set(real, target)
    isolating.set(real, Promise.resolve())

    for (const entry of seeded) {
      const source = await entrySource(name, entry.slug, entry.data, { locale: entry.locale, body: entry.body, create: true })

      if ('issues' in source)
        throw new KayError('content-api-misuse', `kay: the seed of ${name} gives ${entry.slug} ${source.issues.map(issue => issue.message).join(', ')}`)

      await Bun.write(source.file.absolute, source.file.text)
    }
  }

  const seed = async (name: string, entries: SeedEntry[]) => {
    const found = named.find(([exported]) => exported === name)

    if (found === undefined)
      throw new KayError('content-config-missing', `kay: no collection is exported from the content config as ${name}${named.length === 0 ? '' : `; it exports ${named.map(([exported]) => exported).join(', ')}`}`)

    const folder = folders.find(([exported]) => exported === name)

    if (folder === undefined)
      seedLoaded(name, found[1], entries)
    else
      await seedFolder(name, folder[1].dir, entries)

    found[1].invalidate()
  }

  const write = async (name: string, file: string, text: string) => {
    const folder = folders.find(([exported]) => exported === name)

    if (folder === undefined)
      throw new KayError('content-api-misuse', `kay: content.write() writes a file of a folder collection, and ${name} is ${named.some(([exported]) => exported === name) ? 'loaded: seed it instead' : `exported by no content config${named.length === 0 ? '' : `; it exports ${named.map(([exported]) => exported).join(', ')}`}`}`)

    const real = resolve(contentPlace().base, folder[1].dir)

    await isolate(real)

    const target = resolve(copies.get(real)!, file)

    if (relative(copies.get(real)!, target).startsWith('..'))
      throw new KayError('content-api-misuse', `kay: content.write() writes inside ${name}'s folder, and ${file} lies outside it`)

    await Bun.write(target, text)
    folder[1].invalidate()
  }

  const reset = async (given: ContentSeed = {}) => {
    for (const [, collection] of named)
      restoreLoader(collection)

    copies.clear()
    isolating.clear()
    await rm(base, { recursive: true, force: true })
    await mkdir(base, { recursive: true })

    for (const [, collection] of named)
      collection.invalidate()

    for (const [name, entries] of Object.entries(given))
      await seed(name, entries)
  }

  redirectFolders(copies, isolate)

  return {
    content: { reset, seed, write },
    release: async () => {
      if (released)
        return

      released = true

      for (const [, collection] of named)
        restoreLoader(collection)

      redirectFolders(new Map())

      for (const [, collection] of named)
        collection.invalidate()

      await rm(base, { recursive: true, force: true })
    },
  }
}

interface Held {
  key: string
  made: Promise<{ content: TestContent, release: () => Promise<void> }>
  users: number
}

let held: Held | undefined

// The process serves one project, so its sites share one copy of the content, which goes when the last of them closes.
export async function testContent(root: string, config: string | undefined): Promise<{ content: TestContent, release: () => Promise<void> }> {
  const key = `${root}\0${config ?? ''}`

  if (held?.key !== key) {
    const previous = held

    await (await previous?.made)?.release()
    held = { key, made: makeContent(root, config), users: 0 }
  }

  const mine = held

  mine.users++

  const { content, release } = await mine.made
  let done = false

  return {
    content,
    release: async () => {
      if (done)
        return

      done = true

      if (--mine.users === 0) {
        if (held === mine)
          held = undefined

        await release()
      }
    },
  }
}
