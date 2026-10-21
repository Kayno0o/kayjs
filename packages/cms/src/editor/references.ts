import { call } from 'kay'
import entriesApi from '../api/entries'

export interface Choice {
  value: string
  label: string
}

// The reads on their way or just done, so the reference fields of a form naming one collection share a request; one is dropped after a few seconds, so an entry added since shows the next time a form opens.
const reads = new Map<string, Promise<Choice[]>>()
const KEPT_MS = 5000

// The entries of a collection a reference field can pick, by title. A failed read rejects, and the field falls back to typing the slug.
export async function referenceChoices(collection: string): Promise<Choice[]> {
  const known = reads.get(collection)

  if (known)
    return known

  const read = (async () => (await call(entriesApi, '/:collection', { params: { collection } })).map(({ slug, title }) => ({ value: slug, label: title === slug ? slug : `${title} (${slug})` })))()

  reads.set(collection, read)
  setTimeout(() => reads.delete(collection), KEPT_MS)

  try {
    return await read
  }
  catch (error) {
    reads.delete(collection)

    throw error
  }
}
