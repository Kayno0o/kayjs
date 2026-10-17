import { api } from 'kay/server'

export default api({ rateLimit: { max: 1, window: '1m' } }).get('/', () => ({ guarded: true }))
