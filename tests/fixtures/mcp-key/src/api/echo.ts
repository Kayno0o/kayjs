import { t } from 'elysia'
import { api, toolCall } from 'kay/server'

export default api()
  .get('/seen', ({ request }) => ({ authorization: request.headers.get('authorization'), tool: toolCall(request)?.tool ?? null }), { detail: { operationId: 'seen', tool: true } })
  .post('/add', ({ body }) => ({ added: body.name }), { body: t.Object({ name: t.String() }), detail: { operationId: 'add', tool: true } })
