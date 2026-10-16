import { t } from 'elysia'
import { api } from 'kay/server'

export default api()
  .get('/:id', ({ params, query }) => ({ id: params.id, fields: query.fields ?? null, tags: query.tags ?? [] }), {
    params: t.Object({ id: t.String() }),
    query: t.Object({ fields: t.Optional(t.String()), tags: t.Optional(t.Array(t.String())) }),
    detail: { summary: 'One note', description: 'Reads a note by its id.' },
  })
  .post('/', ({ body }) => ({ created: body.title, pinned: body.pinned ?? false }), { body: t.Object({ title: t.String(), pinned: t.Optional(t.Boolean()) }), detail: { operationId: 'create_note' } })
  .delete('/:id', ({ params }) => ({ deleted: params.id }), { params: t.Object({ id: t.String() }) })
  .get('/hidden', () => 'secret', { detail: { hide: true } })
  .post('/photo', () => 'stored', { body: t.Object({ photo: t.File() }) })
  .get('/words', () => 'plain words')
  .get('/binary', () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'application/octet-stream' } }))
  .get('/search', ({ query }) => ({ count: query.limit }), { query: t.Object({ limit: t.Numeric() }) })
