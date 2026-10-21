import { s } from 'kay'
import { api } from 'kay/server'
import { wording } from 'kay/words'
import { authors } from '../authors'
import { withHold } from '../publishing'
import { deleteEntry, duplicateEntry, entryScreen, moveEntry, publishEntry, referenceChoices, renameEntry, saveEntry, UnknownCollection, unpublishEntry } from '../store'

const locale = s.Object({ locale: s.Optional(s.String()) })
const versioned = s.Object({ locale: s.Optional(s.String()), version: s.Optional(s.String()) })

export default api()
  .onError(({ error, status }) => error instanceof UnknownCollection ? status(404, error.message) : undefined)
  .get('/:collection', async ({ params }) => referenceChoices(params.collection))
  .get('/:collection/:slug', async ({ params, query, status }) => {
    const screen = await entryScreen({ collection: params.collection, slug: params.slug, locale: query.locale })

    if (!screen)
      throw new UnknownCollection(wording('cms.store.noCollection', 'No collection {name}', { name: params.collection }))

    if (screen.collection.problem !== undefined)
      return status(500, screen.collection.problem)

    return screen.entry ? { collection: screen.collection, entry: screen.entry } : status(404, wording('cms.store.noEntry', 'No entry {slug} in {collection}', { slug: params.slug, collection: params.collection }))
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
  .post('/:collection/:slug/duplicate', async ({ params, query, request }) => duplicateEntry({ collection: params.collection, slug: params.slug, locale: query.locale }, authors.get(request)), { query: locale })
  .post('/:collection/:slug/rename', async ({ params, query, body, request }) => renameEntry({ collection: params.collection, slug: params.slug, locale: query.locale }, body.slug, { author: authors.get(request), version: query.version, required: true }), { query: versioned, body: s.Object({ slug: s.String() }) })
  .post('/:collection/:slug/move', async ({ params, query, request }) => moveEntry({ collection: params.collection, slug: params.slug, locale: query.locale }, query.direction, authors.get(request)), { query: s.Object({ locale: s.Optional(s.String()), direction: s.Union([s.Literal('up'), s.Literal('down')]) }) })
  .delete('/:collection/:slug', async ({ params, query, request }) => deleteEntry({ collection: params.collection, slug: params.slug, locale: query.locale }, authors.get(request), { version: query.version, required: true }), { query: versioned })
