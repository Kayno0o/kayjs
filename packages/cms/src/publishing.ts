import type { CollectionInfo } from './kay/contract'
import { collectionNamed, entryScreen, heldDate } from './store'

const SAVE = /^\/entries\/([^/]+)\/([^/]+)$/

// The saves of a new entry in a collection with a publish date and no draft flag, which a role that may not publish makes: the entry would go live at once, so it is written held back by a far date a publisher then changes.
const held = new WeakSet<Request>()

// The data a save is written with: held back when the guard asked.
export async function withHold(request: Request, collectionName: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!held.has(request))
    return data

  const collection = await collectionNamed(collectionName)

  return collection.publishField === undefined ? data : { ...data, [collection.publishField]: heldDate(collection) }
}

// The restores of a role that may not publish: what they restore leaves the draft flag and the dates as they are.
const restrained = new WeakSet<Request>()

export function restrain(request: Request): void {
  restrained.add(request)
}

export function isRestrained(request: Request): boolean {
  return restrained.has(request)
}

// `data` with the draft flag and the publish and unpublish dates of the entry it replaces, so restoring an older version publishes or withdraws nothing; without an entry, a draft, or held back by a far date in a collection with no draft flag.
export function keepingPublication(collection: Pick<CollectionInfo, 'draftField' | 'publishField' | 'unpublishField' | 'schema'>, data: Record<string, unknown>, current: Record<string, unknown> | undefined): Record<string, unknown> {
  const kept = { ...data }

  for (const field of [collection.draftField, collection.publishField, collection.unpublishField]) {
    if (field === undefined)
      continue

    if (current !== undefined && current[field] !== undefined)
      kept[field] = current[field]
    else
      delete kept[field]
  }

  if (current === undefined) {
    if (collection.draftField !== undefined)
      kept[collection.draftField] = true
    else if (collection.publishField !== undefined)
      kept[collection.publishField] = heldDate(collection)
  }

  return kept
}

// `data` with the order field of the entry it replaces.
export function keepingOrder(field: string, data: Record<string, unknown>, current: Record<string, unknown> | undefined): Record<string, unknown> {
  const rest = { ...data }

  delete rest[field]

  return current?.[field] === undefined ? rest : { ...rest, [field]: current[field] }
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

// Whether the save a request carries leaves what the site shows alone: the draft flag and the publish and unpublish dates of an existing entry as they are, a new entry a draft with neither date set, or held back by the server when the collection has no draft flag. A save is a way to publish as much as `/publish` is, so a role that may not publish is held to it.
// A body that is not a JSON object holding an object `data` is refused: the route would take a multipart form too, and the guard cannot read the publishing fields of one.
export async function leavesPublication(request: Request, path: string): Promise<boolean> {
  const [, collectionName, slug] = SAVE.exec(path) ?? []

  if (collectionName === undefined || slug === undefined)
    return true

  let sent: { data?: unknown, locale?: unknown, create?: unknown }

  try {
    sent = await request.clone().json() as typeof sent
  }
  catch {
    return false
  }

  if (typeof sent !== 'object' || sent === null || typeof sent.data !== 'object' || sent.data === null)
    return false

  try {
    const name = decodeURIComponent(collectionName)
    const collection = await collectionNamed(name)
    const fields = [collection.draftField, collection.publishField, collection.unpublishField].filter(field => field !== undefined)

    if (fields.length === 0)
      return true

    const data = sent.data as Record<string, unknown>
    const screen = await entryScreen({ collection: name, slug: decodeURIComponent(slug), locale: typeof sent.locale === 'string' ? sent.locale : undefined })
    const saved = screen?.entry?.data

    // A new entry starts as a draft, with nothing scheduled.
    if (!saved) {
      const unset = (field: string) => data[field] === undefined || data[field] === null || data[field] === ''
      const fine = fields.every(field => field === collection.draftField ? data[field] === true : unset(field))

      if (fine && collection.draftField === undefined && collection.publishField !== undefined)
        held.add(request)

      return fine
    }

    return fields.every(field => sameValue(data[field], saved[field]) || (data[field] === undefined && saved[field] === undefined))
  }
  catch {
    return false
  }
}
