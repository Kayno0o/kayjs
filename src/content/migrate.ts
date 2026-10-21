import type { TSchema } from 'elysia'
import type { ContentLoader, LoadedEntry } from './index'
import type { RawEntry } from './load'
import { kayLog } from '../runtime/log'
import { compiledCheck } from '../server/schema-check'
import { withDefaults } from './validate'

// One step carrying a stored entry's data from the shape it had to a newer one; it gets a copy to change or replace.
export type Migration = (data: Record<string, unknown>) => Record<string, unknown>

// A step renaming a field, leaving the data as it is when it lacks the old one or already has the new one.
export function renameField(from: string, to: string): Migration {
  return (data) => {
    if (!(from in data) || to in data)
      return data

    const { [from]: value, ...rest } = data

    return { ...rest, [to]: value }
  }
}

// A step giving a field a value when it has none, for a field the schema newly requires.
export function setField(name: string, value: unknown | ((data: Record<string, unknown>) => unknown)): Migration {
  return (data) => {
    if (data[name] !== undefined)
      return data

    return { ...data, [name]: typeof value === 'function' ? (value as (data: Record<string, unknown>) => unknown)(data) : structuredClone(value) }
  }
}

// A step turning a field's value into another, such as a text into a number; the data without the field is left as it is.
export function convertField(name: string, convert: (value: unknown, data: Record<string, unknown>) => unknown): Migration {
  return (data) => {
    return data[name] === undefined ? data : { ...data, [name]: convert(data[name], data) }
  }
}

// Whether the collection declares any migration.
export function hasSteps(migrations: readonly Migration[] | undefined): migrations is readonly Migration[] {
  return migrations !== undefined && migrations.length > 0
}

function isFields(data: unknown): data is Record<string, unknown> {
  return typeof data === 'object' && data !== null && !Array.isArray(data)
}

// The data an entry the schema refuses migrates to: each step in turn on the result of the last, stopping once the schema accepts it. Data the schema accepts, and data no step brings to it, come back as they were, `changed` false.
export function migrateData(schema: TSchema, migrations: readonly Migration[] | undefined, data: unknown): { data: unknown, changed: boolean, error?: unknown } {
  const unchanged = { data, changed: false }

  if (!hasSteps(migrations) || !isFields(data))
    return unchanged

  const check = compiledCheck(schema)

  if (check.Check(withDefaults(data, schema)))
    return unchanged

  try {
    let current: Record<string, unknown> = structuredClone(data)

    for (const step of migrations) {
      current = step(current)

      if (check.Check(withDefaults(current, schema)))
        return { data: current, changed: true }
    }
  }
  catch (error) {
    return { ...unchanged, error }
  }

  return unchanged
}

// The file entries with their data migrated, in memory; the files keep what they hold until a CMS saves them.
export function migrateEntries(name: string, entries: RawEntry[], schema: TSchema, migrations: readonly Migration[] | undefined): RawEntry[] {
  if (!hasSteps(migrations))
    return entries

  return entries.map((entry) => {
    const { data, changed, error } = migrateData(schema, migrations, entry.data)

    if (error !== undefined)
      kayLog('warn', `kay: a migration of ${name} threw on ${entry.file}`, error)

    return changed ? { ...entry, data } : entry
  })
}

// An entry of a loader whose data migrated: what it held, to write back only while the loader still holds that.
export interface Carried {
  entry: LoadedEntry
  was: unknown
}

// What a loader gave with its stored data migrated, and the entries that changed, which `writeBack` hands to the loader's `save` once they proved valid.
export function migrateLoaded(name: string, given: unknown[], schema: TSchema, migrations: readonly Migration[] | undefined): { items: unknown[], carried: Carried[] } {
  if (!hasSteps(migrations))
    return { items: given, carried: [] }

  const items: unknown[] = []
  const carried: Carried[] = []

  for (const item of given) {
    const entry = (typeof item === 'object' && item !== null ? item : {}) as Partial<LoadedEntry>
    const { data, changed, error } = migrateData(schema, migrations, entry.data)

    if (error !== undefined)
      kayLog('warn', `kay: a migration of ${name} threw on ${String(entry.slug)}`, error)

    if (changed) {
      const migrated = { ...entry, data } as LoadedEntry

      items.push(migrated)
      carried.push({ entry: migrated, was: entry.data })
    }
    else {
      items.push(item)
    }
  }

  return { items, carried }
}

// Hands the migrated entries to the loader's `save` once, so the next read finds them in the new shape. An entry the loader no longer holds as it was read, because an editor saved it meanwhile, is left to that save. A save that fails is logged, the entry staying migrated for this read and tried again at the next.
export async function writeBack(loader: ContentLoader, carried: Carried[], localized: boolean, preview: boolean): Promise<void> {
  const { save } = loader

  if (save === undefined || carried.length === 0)
    return

  let written = 0

  for (const { entry, was } of carried) {
    const split = localized ? entry.slug.indexOf('/') : -1

    try {
      const current = await currentOf(loader, entry.slug, preview)

      if (JSON.stringify(current?.data) !== JSON.stringify(was))
        continue

      await save({ slug: split === -1 ? entry.slug : entry.slug.slice(split + 1), ...split !== -1 && { locale: entry.slug.slice(0, split) }, data: entry.data, ...entry.body !== undefined && { body: entry.body } })
      written++
    }
    catch (error) {
      kayLog('warn', `kay: ${loader.name}'s save could not write the migrated entry ${entry.slug} back`, error)
    }
  }

  if (written > 0)
    kayLog('info', `kay: ${written === 1 ? 'an entry' : `${written} entries`} of ${loader.name} carried over by its migrations`)
}

// The entry as the loader holds it now: from its `get` when it has one, else from `load`.
async function currentOf(loader: ContentLoader, slug: string, preview: boolean): Promise<LoadedEntry | undefined> {
  return loader.get ? loader.get(slug, { preview }) : (await loader.load({ preview })).find(each => each.slug === slug)
}
