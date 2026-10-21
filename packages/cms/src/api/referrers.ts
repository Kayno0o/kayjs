import { s } from 'kay'
import { api } from 'kay/server'
import { referrersOf } from '../references'
import { collectionNamed, UnknownCollectionError } from '../store'

// The entries that name each asked entry in a reference field, as `Collection: title`, read when a delete confirmation opens so it is never older than the click. `slugs` is a JSON list, as a slug may hold any character a URL can.
export default api()
  .onError(({ error, status }) => error instanceof UnknownCollectionError ? status(404, error.message) : undefined)
  .get('/:collection', async ({ params, query }) => {
    const collection = await collectionNamed(params.collection)
    const slugs = parseSlugs(query.slugs)

    return Object.fromEntries(await referrersOf(collection.name, slugs))
  }, { query: s.Object({ slugs: s.String() }) })

function parseSlugs(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text)

    return Array.isArray(parsed) ? parsed.filter(each => typeof each === 'string') : []
  }
  catch {
    return []
  }
}
