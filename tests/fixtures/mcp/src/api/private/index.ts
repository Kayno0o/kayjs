import { api } from 'kay/server'

export default api().get('/', () => ({ secret: 42 }), { detail: { summary: 'The secret' } })
