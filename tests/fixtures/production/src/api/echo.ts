import { api } from 'kay/server'

export default api().post('/', ({ body }) => String(body).length)
