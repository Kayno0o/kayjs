import type { StoredEntry } from '../kay/contract'
import { s } from 'kay'
import { editSessionAdmitted } from 'kay/library'
import { api } from 'kay/server'
import { wording } from 'kay/words'
import { actors, authors } from '../authors'
import { SINGLE_SLUG } from '../listing'
import { withHold } from '../publishing'
import { readReview, viewOf } from '../review'
import { approveEntry, sendBackEntry, submitEntry } from '../reviewing'
import { deleteEntry, duplicateEntry, entryScreen, moveEntry, publishEntry, referenceChoices, renameEntry, saveEntry, shareLink, UnknownCollectionError, unpublishEntry } from '../store'

const locale = s.Object({ locale: s.Optional(s.String()) })
const nobody = { name: '', reviewers: [] }
const versioned = s.Object({ locale: s.Optional(s.String()), version: s.Optional(s.String()) })

export default api()
  .onError(({ error, status }) => error instanceof UnknownCollectionError ? status(404, error.message) : undefined)
  .get('/:collection', async ({ params }) => referenceChoices(params.collection))
  .get('/:collection/:slug', async ({ params, query, status, request }) => {
    const screen = await entryScreen({ collection: params.collection, slug: params.slug, locale: query.locale })

    if (!screen)
      throw new UnknownCollectionError(wording('cms.store.noCollection', 'No collection {name}', { name: params.collection }))

    if (screen.collection.problem !== undefined)
      return status(500, screen.collection.problem)

    // A single collection's seed is the entry the first save writes.
    if (!screen.entry && params.slug === SINGLE_SLUG && screen.collection.single && screen.collection.seed !== undefined) {
      const entry: StoredEntry = { slug: SINGLE_SLUG, data: screen.collection.seed, draft: false }

      return { collection: screen.collection, entry, seeded: true as const }
    }

    // The names and notes of a review are for the staff the guard admits, not for an edit link's holder.
    const review = screen.entry && !editSessionAdmitted(request) ? await readReview({ collection: params.collection, slug: params.slug, locale: query.locale }) : undefined

    return screen.entry ? { collection: screen.collection, entry: screen.entry, review: review && viewOf(review) } : status(404, wording('cms.store.noEntry', 'No entry {slug} in {collection}', { slug: params.slug, collection: params.collection }))
  }, { query: locale })
  .post('/:collection/:slug', async ({ params, body, request }) => saveEntry({ collection: params.collection, slug: params.slug, locale: body.locale, data: await withHold(request, params.collection, body.data), body: body.body }, { create: body.create, version: body.version, required: true, author: authors.get(request) }), {
    body: s.Object({
      locale: s.Optional(s.String()),
      data: s.Record(s.String(), s.Unknown()),
      body: s.Optional(s.String()),
      create: s.Optional(s.Boolean()),
      version: s.Optional(s.String()),
    }),
  })
  .post('/:collection/:slug/publish', async ({ params, query, request }) => publishEntry({ collection: params.collection, slug: params.slug, locale: query.locale }, authors.get(request)), { query: locale })
  .post('/:collection/:slug/unpublish', async ({ params, query, request }) => unpublishEntry({ collection: params.collection, slug: params.slug, locale: query.locale }, authors.get(request)), { query: locale })
  .post('/:collection/:slug/submit', async ({ params, query, request }) => submitEntry({ collection: params.collection, slug: params.slug, locale: query.locale }, actors.get(request) ?? nobody, authors.get(request)), { query: locale })
  .post('/:collection/:slug/approve', async ({ params, query, request }) => approveEntry({ collection: params.collection, slug: params.slug, locale: query.locale }, actors.get(request) ?? nobody, authors.get(request)), { query: locale })
  .post('/:collection/:slug/send-back', async ({ params, query, body, request }) => sendBackEntry({ collection: params.collection, slug: params.slug, locale: query.locale }, body.note, actors.get(request) ?? nobody, authors.get(request)), { query: locale, body: s.Object({ note: s.String() }) })
  .post('/:collection/:slug/share', async ({ params, query }) => shareLink({ collection: params.collection, slug: params.slug, locale: query.locale }), { query: locale })
  .post('/:collection/:slug/duplicate', async ({ params, query, request }) => duplicateEntry({ collection: params.collection, slug: params.slug, locale: query.locale }, authors.get(request)), { query: locale })
  .post('/:collection/:slug/rename', async ({ params, query, body, request }) => renameEntry({ collection: params.collection, slug: params.slug, locale: query.locale }, body.slug, { author: authors.get(request), version: query.version, required: true }), { query: versioned, body: s.Object({ slug: s.String() }) })
  .post('/:collection/:slug/move', async ({ params, query, request }) => moveEntry({ collection: params.collection, slug: params.slug, locale: query.locale }, query.direction, authors.get(request)), { query: s.Object({ locale: s.Optional(s.String()), direction: s.Union([s.Literal('up'), s.Literal('down')]) }) })
  .delete('/:collection/:slug', async ({ params, query, request }) => deleteEntry({ collection: params.collection, slug: params.slug, locale: query.locale }, authors.get(request), { version: query.version, required: true }), { query: versioned })
