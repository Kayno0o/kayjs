import { api } from 'kay/server'
import { authors } from '../authors'
import { isRestrained } from '../publishing'
import { restoreTrashed } from '../restore'
import { UnknownCollection } from '../store'

export default api()
  .onError(({ error, status }) => error instanceof UnknownCollection ? status(404, error.message) : undefined)
  .post('/:collection/:id/restore', async ({ params, request }) => restoreTrashed(params.collection, params.id, authors.get(request), { restrained: isRestrained(request) }))
