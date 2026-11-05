import { t } from 'elysia'
import { api } from 'kay/server'

export default api()
  .post('/own', () => ({ ok: true }), { body: t.Object({ a: t.String() }), response: { 200: t.Object({ ok: t.Boolean() }), 422: t.Object({ mine: t.Boolean() }) } })
  .get('/bare', () => ({ ok: true }))
  .get('/cookie', () => ({ ok: true }), { cookie: t.Cookie({ token: t.String() }) })
