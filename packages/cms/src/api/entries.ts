import { s } from 'kay'
import { api } from 'kay/server'
import { collectionNamed, deleteEntry, entryOf, publishEntry, saveEntry, UnknownCollection } from '../store'

const locale = s.Object({ locale: s.Optional(s.String()) })

export default api()
  .onError(({ error, status }) => error instanceof UnknownCollection ? status(404, error.message) : undefined)
  .get('/:collection/:slug', async ({ params, query, status }) => {
    const collection = await collectionNamed(params.collection)
    const entry = await entryOf({ collection: collection.name, slug: params.slug, locale: query.locale })

    return entry ? { collection, entry } : status(404, `No entry ${params.slug} in ${params.collection}`)
  }, { query: locale })
  .post('/:collection/:slug', async ({ params, body }) => saveEntry({ collection: params.collection, slug: params.slug, locale: body.locale, data: body.data, body: body.body }, { create: body.create }), {
    body: s.Object({
      locale: s.Optional(s.String()),
      data: s.Record(s.String(), s.Unknown()),
      body: s.Optional(s.String()),
      create: s.Optional(s.Boolean()),
    }),
  })
  .post('/:collection/:slug/publish', async ({ params, query }) => publishEntry({ collection: params.collection, slug: params.slug, locale: query.locale }), { query: locale })
  .delete('/:collection/:slug', async ({ params, query }) => deleteEntry({ collection: params.collection, slug: params.slug, locale: query.locale }), { query: locale })
