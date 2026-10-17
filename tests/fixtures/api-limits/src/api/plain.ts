import { api } from 'kay/server'

export default api().get('/', () => ({ plain: true })).post('/', () => ({ posted: true }))
