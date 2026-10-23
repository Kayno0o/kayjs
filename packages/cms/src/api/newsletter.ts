import type { EntryRef } from '../kay/contract'
import { s } from 'kay'
import { appStore } from 'kay/library'
import { api } from 'kay/server'
import { wording } from 'kay/words'
import { testAddresses } from '../authors'
import { log } from '../log'
import { settings } from '../settings'
import { entryOf } from '../store'

class Refused extends Error {
  constructor(readonly code: 400 | 404 | 409, message: string) {
    super(message)
  }
}

const locale = s.Object({ locale: s.Optional(s.String()) })

// The entry versions sent or being sent in this process, so a double click or a second editor cannot mail a list twice by accident. A folder entry outside a repository has no version, so its content stands for it.
const sent = new Map<string, string>()
// What the app's `store.cache` keeps of them, so a restart or a second process does not mail a list again; a send is remembered for a year.
const LEDGER = 'kayjs-cms:newsletter:'
const LEDGER_MS = 365 * 86_400_000

async function sentBefore(key: string, version: string): Promise<boolean> {
  const stored = await appStore()?.cache?.get(LEDGER + key)

  return stored !== undefined && stored.text === version && stored.freshUntil > Date.now()
}

async function remember(key: string, version: string): Promise<void> {
  try {
    await appStore()?.cache?.set(LEDGER + key, version, Date.now() + LEDGER_MS)
  }
  catch (error) {
    log.error(`the send of ${key} could not be written to the store, so a restart may mail it again`, error)
  }
}

async function loaded(ref: EntryRef) {
  const options = settings().newsletter.get(ref.collection)

  if (!options)
    throw new Refused(404, wording('cms.newsletter.none', 'The entries of {collection} are not sent to a list', { collection: ref.collection }))

  const entry = await entryOf(ref)

  if (!entry)
    throw new Refused(404, wording('cms.store.noEntry', 'No entry {slug} in {collection}', { slug: ref.slug, collection: ref.collection }))

  return { options, entry, message: await options.message(entry) }
}

const keyOf = (ref: EntryRef) => `${ref.collection}/${ref.slug}/${ref.locale ?? ''}`

export default api()
  .onError(({ error, status }) => error instanceof Refused ? status(error.code, error.message) : undefined)
  .post('/:collection/:slug/preview', async ({ params, query }) => {
    const { options, message } = await loaded({ collection: params.collection, slug: params.slug, locale: query.locale })

    return { ...await options.list.preview(message as never), subscribers: await options.list.count() }
  }, { query: locale })
  .post('/:collection/:slug/test', async ({ params, query, request }) => {
    const to = testAddresses.get(request)

    if (to === undefined)
      throw new Refused(400, wording('cms.newsletter.noAddress', 'A test send goes to your own address, which the sign-in does not give: set testTo on the collection'))

    const { options, message } = await loaded({ collection: params.collection, slug: params.slug, locale: query.locale })

    await options.list.test(message as never, to)

    return { to }
  }, { query: locale })
  .post('/:collection/:slug/send', async ({ params, query }) => {
    const ref = { collection: params.collection, slug: params.slug, locale: query.locale }
    const { options, entry, message } = await loaded(ref)

    if (entry.draft)
      throw new Refused(409, wording('cms.newsletter.draft', 'Publish the entry before sending it to the list'))

    const version = entry.version ?? Bun.hash(JSON.stringify([entry.data, entry.body])).toString()
    const key = keyOf(ref)

    if (sent.get(key) === version)
      throw new Refused(409, wording('cms.newsletter.again', 'This version of the entry was already sent to the list'))

    // Claimed before anything is awaited, so two requests at once cannot both pass.
    sent.set(key, version)

    try {
      if (await sentBefore(key, version))
        throw new Refused(409, wording('cms.newsletter.again', 'This version of the entry was already sent to the list'))

      const result = await options.list.send(message as never)

      await remember(key, version)

      return result
    }
    catch (error) {
      if (!(error instanceof Refused))
        sent.delete(key)

      throw error
    }
  }, { query: locale })
