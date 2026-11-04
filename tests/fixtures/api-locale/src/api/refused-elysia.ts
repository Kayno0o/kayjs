import { api, s } from 'kay/server'

export default api({ errorShape: 'elysia' })
  .post('/', () => ({ ok: true }), { body: s.Object({ title: s.String() }) })
