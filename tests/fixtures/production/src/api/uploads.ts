import { api } from 'kay/server'

export default api({ bodyLimit: 4 * 1024 * 1024 }).post('/', ({ body }) => String(body).length)
