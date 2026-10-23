import type { EntryRef, StoredEntry } from '../kay/contract'
import { s } from 'kay'
import { api } from 'kay/server'
import { wording } from 'kay/words'
import { authors } from '../authors'
import { settings } from '../settings'
import { collectionNamed, entryOf } from '../store'

class Refused extends Error {
  constructor(readonly code: 400 | 404 | 409, message: string) {
    super(message)
  }
}

const locale = s.Object({ locale: s.Optional(s.String()) })

// The entry versions already sent in this process, so a double click or a second editor cannot mail a list twice by accident.
const sent = new Map<string, string>()

async function loaded(ref: EntryRef) {
  const options = settings().newsletter.get(ref.collection)

  if (!options)
    throw new Refused(404, wording('cms.newsletter.none', 'The entries of {collection} are not sent to a list', { collection: ref.collection }))

  const entry = await entryOf(ref)

  if (!entry)
    throw new Refused(404, wording('cms.store.noEntry', 'No entry {slug} in {collection}', { slug: ref.slug, collection: ref.collection }))

  return { options, entry, message: await options.message(entry) }
}

async function isDraft(collection: string, entry: StoredEntry): Promise<boolean> {
  const { draftField } = await collectionNamed(collection)

  return draftField !== undefined && entry.data?.[draftField] === true
}

const keyOf = (ref: EntryRef) => `${ref.collection}/${ref.slug}/${ref.locale ?? ''}`

export default api()
  .onError(({ error, status }) => error instanceof Refused ? status(error.code, error.message) : undefined)
  .post('/:collection/:slug/preview', async ({ params, query }) => {
    const { options, message } = await loaded({ collection: params.collection, slug: params.slug, locale: query.locale })

    return { ...await options.list.preview(message as never), subscribers: await options.list.count() }
  }, { query: locale })
  .post('/:collection/:slug/test', async ({ params, query, request }) => {
    const to = authors.get(request)?.email

    if (to === undefined)
      throw new Refused(400, wording('cms.newsletter.noAddress', 'A test send goes to your own address, which needs cms({ author })'))

    const { options, message } = await loaded({ collection: params.collection, slug: params.slug, locale: query.locale })

    await options.list.test(message as never, to)

    return { to }
  }, { query: locale })
  .post('/:collection/:slug/send', async ({ params, query }) => {
    const ref = { collection: params.collection, slug: params.slug, locale: query.locale }
    const { options, entry, message } = await loaded(ref)

    if (await isDraft(ref.collection, entry))
      throw new Refused(409, wording('cms.newsletter.draft', 'Publish the entry before sending it to the list'))

    const version = entry.version ?? ''
    const key = keyOf(ref)

    if (sent.get(key) === version)
      throw new Refused(409, wording('cms.newsletter.again', 'This version of the entry was already sent to the list'))

    const result = await options.list.send(message as never)

    sent.set(key, version)

    return result
  }, { query: locale })
