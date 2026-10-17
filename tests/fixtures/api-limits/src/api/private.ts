import { api } from 'kay/server'

export default api({ cors: false }).get('/', () => ({ private: true })).post('/', () => ({ posted: true }))
