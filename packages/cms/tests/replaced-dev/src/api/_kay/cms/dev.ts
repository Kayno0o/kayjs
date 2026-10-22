import { api } from 'kay/server'

export default api().get('/', () => ({ replaced: true }))
