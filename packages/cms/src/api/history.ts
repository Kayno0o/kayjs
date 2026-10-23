import { s } from 'kay'
import { api } from 'kay/server'
import { authors } from '../authors'
import { isRestrained } from '../publishing'
import { restoreRevision } from '../restore'
import { eraseHistory, forgetEditor } from '../retention'
import { UnknownCollectionError } from '../store'

export default api()
  .onError(({ error, status }) => error instanceof UnknownCollectionError ? status(404, error.message) : undefined)
  .post('/:collection/:slug/restore', async ({ params, body, request }) => restoreRevision({ collection: params.collection, slug: params.slug, locale: body.locale }, body.at, authors.get(request), { version: body.version, restrained: isRestrained(request) }), {
    body: s.Object({ at: s.Integer(), locale: s.Optional(s.String()), version: s.Optional(s.String()) }),
  })
  // Removes an entry from the trash, its revisions and the activity log for good; behind the `delete` role.
  .post('/:collection/:slug/erase', async ({ params, body }) => ({ erased: await eraseHistory({ collection: params.collection, slug: params.slug, locale: body.locale }) }), {
    body: s.Object({ locale: s.Optional(s.String()) }),
  })
  // Rewrites an editor's name in the trash, the revisions and the activity log; behind the `delete` role.
  .post('/forget-editor', async ({ body }) => ({ changed: await forgetEditor(body.name) }), {
    body: s.Object({ name: s.String({ minLength: 1, maxLength: 200 }) }),
  })
