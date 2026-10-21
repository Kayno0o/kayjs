import type { Field } from './fields'
import type { CollectionInfo, DraftEntry, Issue, SourceEntry } from './kay/contract'
import { wording } from 'kay/words'
import { fieldsOf, itemFields, itemOf } from './fields'
import { collections, entries } from './kay/content'
import { collectionTitle, entryTitle } from './listing'
import { log } from './log'
import { joinPath } from './paths'

// Collects into `found` the slugs of `slugs` that `value`, read through `field`, names in a reference to `target`, however deep in lists and groups.
function names(field: Field, value: unknown, target: string, slugs: Set<string>, found: Set<string>): void {
  if (field.kind === 'reference') {
    if (field.collection === target && typeof value === 'string' && slugs.has(value))
      found.add(value)
  }
  else if (field.kind === 'list') {
    if (Array.isArray(value)) {
      for (const item of value)
        names(itemOf(field, item), item, target, slugs, found)
    }
  }
  else if (field.kind === 'group' && typeof value === 'object' && value !== null) {
    for (const child of field.fields)
      names(child, (value as Record<string, unknown>)[child.key], target, slugs, found)
  }
}

function refersTo(fields: Field[], target: string): boolean {
  return fields.some((field) => {
    if (field.kind === 'reference')
      return field.collection === target

    if (field.kind === 'list')
      return refersTo(itemFields(field), target)

    return field.kind === 'group' && refersTo(field.fields, target)
  })
}

// An entry naming a slug in a reference field, with the label the screens give it.
export interface Referrer {
  collection: CollectionInfo
  entry: SourceEntry
  label: string
}

// The entries that name each slug of `target` in a reference field, as `Collection: title`, by slug. Reads the collections whose schema holds a reference to `target` and no other; one that fails to read is left out.
export async function referrersOf(target: string, slugs: Iterable<string>): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>()

  for (const [slug, found] of await referrersWith(target, slugs))
    result.set(slug, [...new Set(found.map(each => each.label))])

  return result
}

// The entries behind `referrersOf`, with their collection.
export async function referrersWith(target: string, slugs: Iterable<string>): Promise<Map<string, Referrer[]>> {
  const wanted = new Set(slugs)
  const result = new Map<string, Referrer[]>()

  if (wanted.size === 0)
    return result

  let referring: CollectionInfo[]

  try {
    referring = (await collections({ counts: false })).filter(collection => refersTo(fieldsOf(collection.schema), target))
  }
  catch (error) {
    log.error(`the collections failed to read for the references to ${target}`, error)

    return result
  }

  const read = await Promise.allSettled(referring.map(async collection => ({ collection, found: await entries(collection.name, {}) })))

  for (const [i, outcome] of read.entries()) {
    if (outcome.status === 'rejected') {
      log.error(`${referring[i]!.name}'s entries failed to read for the references to ${target}`, outcome.reason)

      continue
    }

    collect(outcome.value.collection, outcome.value.found, target, wanted, result)
  }

  return result
}

function collect(collection: CollectionInfo, found: SourceEntry[], target: string, wanted: Set<string>, result: Map<string, Referrer[]>): void {
  const fields = fieldsOf(collection.schema)

  for (const entry of found) {
    if (entry.data === undefined)
      continue

    const named = new Set<string>()

    for (const field of fields)
      names(field, entry.data[field.key], target, wanted, named)

    for (const slug of named) {
      // An entry referring to itself does not hold up its own delete.
      if (collection.name === target && entry.slug === slug)
        continue

      const label = `${collectionTitle(collection)}${entry.locale === undefined ? '' : ` (${entry.locale})`}: ${entryTitle(collection, entry)}`
      const listed = result.get(slug) ?? []

      if (!listed.some(each => each.collection.name === collection.name && each.entry.slug === entry.slug && each.entry.locale === entry.locale))
        result.set(slug, [...listed, { collection, entry, label }])
    }
  }
}

// The value with every reference to `target` that names `from` pointing at `to` instead, however deep in lists, blocks and groups; the value itself when it names none.
function pointed(field: Field, value: unknown, target: string, from: string, to: string): unknown {
  if (field.kind === 'reference')
    return field.collection === target && value === from ? to : value

  if (field.kind === 'list' && Array.isArray(value)) {
    const items = value.map(item => pointed(itemOf(field, item), item, target, from, to))

    return items.some((item, i) => item !== value[i]) ? items : value
  }

  if (field.kind === 'group' && typeof value === 'object' && value !== null) {
    const group = value as Record<string, unknown>
    const changes = field.fields.flatMap((child) => {
      const next = pointed(child, group[child.key], target, from, to)

      return next === group[child.key] ? [] : [[child.key, next] as const]
    })

    return changes.length === 0 ? value : { ...group, ...Object.fromEntries(changes) }
  }

  return value
}

// The entry's data with its references to `target` that name `from` pointing at `to`; undefined when it holds none.
export function pointReferences(collection: CollectionInfo, data: Record<string, unknown>, target: string, from: string, to: string): Record<string, unknown> | undefined {
  const changes = fieldsOf(collection.schema).flatMap((field) => {
    const next = pointed(field, data[field.key], target, from, to)

    return next === data[field.key] ? [] : [[String(field.key), next] as const]
  })

  return changes.length === 0 ? undefined : { ...data, ...Object.fromEntries(changes) }
}

interface Named {
  path: string
  target: string
  slug: string
}

// The references a value holds, with the path of each, however deep in lists and groups; an empty or non-text value names none, the schema judging it.
function named(field: Field, value: unknown, path: string, found: Named[]): void {
  if (field.kind === 'reference') {
    if (typeof value === 'string' && value !== '' && field.collection !== '')
      found.push({ path, target: field.collection, slug: value })
  }
  else if (field.kind === 'list') {
    if (Array.isArray(value)) {
      for (const [i, item] of value.entries()) {
        named(itemOf(field, item), item, joinPath(path, i), found)
      }
    }
  }
  else if (field.kind === 'group' && typeof value === 'object' && value !== null) {
    for (const child of field.fields)
      named(child, (value as Record<string, unknown>)[child.key], joinPath(path, child.key), found)
  }
}

function valueAt(data: Record<string, unknown> | undefined, path: string): unknown {
  let at: unknown = data

  for (const key of path.split('.')) {
    if (typeof at !== 'object' || at === null)
      return undefined

    at = (at as Record<string, unknown>)[key]
  }

  return at
}

// The references of an entry about to be saved that name an entry the target collection lacks, as the issues a save is refused for. A reference the stored entry already held is left alone without reading its target, so publishing, unpublishing or moving an entry never stops on an old one; a collection that cannot be read tells nothing, and its references pass.
export async function missingReferences(collection: CollectionInfo, entry: DraftEntry, stored: () => Promise<Record<string, unknown> | undefined>): Promise<Issue[]> {
  const found: Named[] = []

  for (const field of fieldsOf(collection.schema))
    named(field, entry.data[String(field.key)], String(field.key), found)

  if (found.length === 0)
    return []

  // References the stored entry holds already are left alone, so publishing, unpublishing or moving reads nothing of the targets.
  const before = await stored()
  const fresh = found.filter(each => valueAt(before, each.path) !== each.slug && !(each.target === collection.name && each.slug === entry.slug))

  if (fresh.length === 0)
    return []

  const exists = new Map<string, boolean | undefined>()

  for (const { target, slug } of fresh) {
    const key = JSON.stringify([target, slug])

    if (exists.has(key))
      continue

    try {
      exists.set(key, (await entries(target, { slug })).length > 0)
    }
    catch (error) {
      log.error(`${target}'s entries failed to read for the references of ${collection.name}/${entry.slug}`, error)
      exists.set(key, undefined)
    }
  }

  return fresh.filter(each => exists.get(JSON.stringify([each.target, each.slug])) === false).map(each => ({ collection: entry.collection, slug: entry.slug, locale: entry.locale, path: each.path, message: wording('cms.store.noEntry', 'No entry {slug} in {collection}', { slug: each.slug, collection: each.target }) }))
}
