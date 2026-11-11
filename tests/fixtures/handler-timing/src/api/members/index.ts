import { api } from 'kay/server'

export default api().get('/', () => ({ members: true }))
