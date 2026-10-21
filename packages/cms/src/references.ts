import type { Field } from './fields'
import type { CollectionInfo, SourceEntry } from './kay/contract'
import { fieldsOf } from './fields'
import { collections, entries } from './kay/content'
import { collectionTitle, entryTitle } from './listing'
import { log } from './log'

// Collects into `found` the slugs of `slugs` that `value`, read through `field`, names in a reference to `target`, however deep in lists and groups.
function names(field: Field, value: unknown, target: string, slugs: Set<string>, found: Set<string>): void {
  if (field.kind === 'reference') {
    if (field.collection === target && typeof value === 'string' && slugs.has(value))
      found.add(value)
  }
  else if (field.kind === 'list') {
    if (Array.isArray(value)) {
      for (const item of value)
        names(field.item, item, target, slugs, found)
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
      return refersTo([field.item], target)

    return field.kind === 'group' && refersTo(field.fields, target)
  })
}

// The entries that name each slug of `target` in a reference field, as `Collection: title`, by slug. Reads the collections whose schema holds a reference to `target` and no other; one that fails to read is left out.
export async function referrersOf(target: string, slugs: Iterable<string>): Promise<Map<string, string[]>> {
  const wanted = new Set(slugs)
  const result = new Map<string, string[]>()

  if (wanted.size === 0)
    return result

  const referring = (await collections({ counts: false })).filter(collection => refersTo(fieldsOf(collection.schema), target))
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

function collect(collection: CollectionInfo, found: SourceEntry[], target: string, wanted: Set<string>, result: Map<string, string[]>): void {
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

      const label = `${collectionTitle(collection)}: ${entryTitle(collection, entry)}`
      const listed = result.get(slug) ?? []

      if (!listed.includes(label))
        result.set(slug, [...listed, label])
    }
  }
}
