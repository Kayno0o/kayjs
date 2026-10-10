import { t } from 'elysia'
import { api } from 'kay/server'

export default api()
  .get('/:id', ({ params }) => ({ id: params.id, name: 'Pen' }), {
    params: t.Object({ id: t.Numeric() }),
    query: t.Object({ fields: t.Optional(t.String()) }),
    response: { 200: t.Object({ id: t.Number(), name: t.String() }), 404: t.Literal('Not found') },
    detail: { summary: 'One item', tags: ['catalog'] },
  })
  .post('/', ({ body }) => ({ id: 2, name: body.name, added: body.added }), { body: t.Object({ name: t.String(), added: t.Date() }) })
  .post('/photo', () => 'stored', { body: t.Object({ photo: t.File() }) })
  .get('/hidden', () => 'secret', { detail: { hide: true } })
  .ws('/live', { message: (ws, message) => ws.send(message) })
