import { api } from 'kay/server'

export default api().post('/', () => ({ posted: true }))
