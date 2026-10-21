import { api } from 'kay/server'

export default api({ maxSize: '4mb' }).post('/', ({ body }) => String(body).length)
