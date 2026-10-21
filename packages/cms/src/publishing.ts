import { collectionNamed, entryScreen } from './store'

const SAVE = /\/api\/cms\/entries\/([^/]+)\/([^/]+)$/

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

// Whether the save a request carries leaves what the site shows alone: the draft flag and the publish and unpublish dates of an existing entry as they are, a new entry a draft with neither date set. A save is a way to publish as much as `/publish` is, so a role that may not publish is held to it.
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
    if (!saved)
      return fields.every(field => field === collection.draftField ? data[field] === true : data[field] === undefined || data[field] === null || data[field] === '')

    return fields.every(field => sameValue(data[field], saved[field]) || (data[field] === undefined && saved[field] === undefined))
  }
  catch {
    return false
  }
}
