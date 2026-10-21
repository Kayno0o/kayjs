import type { TSchema } from 'elysia'
import type { LoadedEntry } from './index'
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

// What a loader gave with its stored data migrated; every entry that changed is handed back to the loader's `save` once, so the next read finds it in its new shape. A save that fails leaves the entry migrated for this read, and is tried again at the next.
export async function migrateLoaded(name: string, given: unknown[], schema: TSchema, migrations: readonly Migration[] | undefined, localized: boolean, save: ((entry: { slug: string, locale?: string | undefined, data: unknown, body?: string | undefined }) => void | Promise<void>) | undefined): Promise<unknown[]> {
  if (!hasSteps(migrations))
    return given

  const result: unknown[] = []
  const written: LoadedEntry[] = []

  for (const item of given) {
    const entry = (typeof item === 'object' && item !== null ? item : {}) as Partial<LoadedEntry>
    const { data, changed, error } = migrateData(schema, migrations, entry.data)

    if (error !== undefined)
      kayLog('warn', `kay: a migration of ${name} threw on ${String(entry.slug)}`, error)

    if (changed) {
      const migrated = { ...entry, data } as LoadedEntry

      result.push(migrated)
      written.push(migrated)
    }
    else {
      result.push(item)
    }
  }

  if (save === undefined || written.length === 0)
    return result

  for (const entry of written) {
    const split = localized ? entry.slug.indexOf('/') : -1

    try {
      await save({ slug: split === -1 ? entry.slug : entry.slug.slice(split + 1), ...split !== -1 && { locale: entry.slug.slice(0, split) }, data: entry.data, ...entry.body !== undefined && { body: entry.body } })
    }
    catch (error) {
      kayLog('warn', `kay: ${name}'s save could not write the migrated entry ${entry.slug} back`, error)
    }
  }

  kayLog('info', `kay: ${written.length === 1 ? 'an entry' : `${written.length} entries`} of ${name} carried over by its migrations`)

  return result
}
