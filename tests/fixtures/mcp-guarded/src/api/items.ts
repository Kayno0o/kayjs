import { t } from 'elysia'
import { api } from 'kay/server'

export default api()
  .get('/', () => ({ items: [] }), { detail: { operationId: 'users.list', tool: true } })
  .post('/', ({ body }) => ({ created: body.name }), { body: t.Object({ name: t.String() }), detail: { operationId: 'users_list', tool: true } })
  .all('/echo', ({ request }) => ({ method: request.method }), { detail: { operationId: 'echo.any', tool: true } })
  .get('/dup-a', () => 'a', { detail: { operationId: 'same', tool: true } })
  .get('/dup-b', () => 'b', { detail: { operationId: 'same', tool: true } })
  .get('/cookie', ({ cookie }) => ({ seen: cookie.session?.value ?? null }), { detail: { tool: true } })
  .get('/own-401', ({ status }) => status(401, 'Not yours'), { detail: { tool: true } })
  .get('/internal', () => 'internal')
