import { api } from 'kay/server'

export default api().get('/hello', () => 'hello')
