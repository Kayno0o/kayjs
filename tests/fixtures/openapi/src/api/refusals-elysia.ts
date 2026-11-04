import { t } from 'elysia'
import { api } from 'kay/server'

export default api({ errorShape: 'elysia' })
  .post('/', () => ({ ok: true }), { body: t.Object({ a: t.String() }) })
