import { api } from 'kay/server'

export default api()
  .get('/', () => ({ items: [] }), { detail: { tool: true } })
