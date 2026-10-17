import { api } from 'kay/server'

export default api({ bodyLimit: '4mb' }).post('/', ({ body }) => String(body).length)
