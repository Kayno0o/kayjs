import { t } from 'elysia'
import { api } from 'kay/server'

export default api()
  .get('/', () => ({ items: [] }), { detail: { operationId: 'users.list' } })
  .post('/', ({ body }) => ({ created: body.name }), { body: t.Object({ name: t.String() }), detail: { operationId: 'users_list' } })
  .all('/echo', ({ request }) => ({ method: request.method }), { detail: { operationId: 'echo.any' } })
  .get('/cookie', ({ cookie }) => ({ seen: cookie.session?.value ?? null }))
  .get('/own-401', ({ status }) => status(401, 'Not yours'))
