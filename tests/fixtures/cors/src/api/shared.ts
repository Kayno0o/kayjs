import { t } from 'elysia'
import { api } from 'kay/server'

export default api({ cors: { origins: ['https://app.example.com', 'https://*.partner.example'], credentials: true, expose: ['x-total'] } })
  .get('/items', ({ set }) => {
    set.headers['x-total'] = '1'

    return [{ id: 1 }]
  })
  .post('/items', ({ body }) => ({ added: body.name }), { body: t.Object({ name: t.String() }) })
  .delete('/items/:id', ({ params }) => ({ removed: params.id }))
