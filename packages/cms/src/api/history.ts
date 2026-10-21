import { s } from 'kay'
import { api } from 'kay/server'
import { authors } from '../authors'
import { isRestrained } from '../publishing'
import { restoreRevision } from '../restore'
import { UnknownCollection } from '../store'

export default api()
  .onError(({ error, status }) => error instanceof UnknownCollection ? status(404, error.message) : undefined)
  .post('/:collection/:slug/restore', async ({ params, body, request }) => restoreRevision({ collection: params.collection, slug: params.slug, locale: body.locale }, body.at, authors.get(request), { version: body.version, restrained: isRestrained(request) }), {
    body: s.Object({ at: s.Integer(), locale: s.Optional(s.String()), version: s.Optional(s.String()) }),
  })
