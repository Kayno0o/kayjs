import { api } from 'kay/server'

export default api({ cors: { origins: ['https://own.example'] } }).get('/', () => ({ own: true }))
