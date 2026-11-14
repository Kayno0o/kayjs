import { s } from 'kay'
import { api } from 'kay/server'

export default api()
  .onError(({ code }) => code === 'VALIDATION' ? { mine: true } : undefined)
  .post('/', () => ({ ok: true }), { body: s.Object({ title: s.String() }) })
