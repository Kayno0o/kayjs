import { t } from 'elysia'
import { api } from 'kay/server'

export default api()
  .get('/', () => ({ ok: true }), { detail: { tool: true } })
  .post('/', ({ body }) => ({ got: body.title }), { body: t.Object({ title: t.String() }) })
  .get('/broken', () => {
    throw new Error('broken')
  })
