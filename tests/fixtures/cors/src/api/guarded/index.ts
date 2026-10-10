import { api } from 'kay/server'

export default api({ cors: { origins: ['https://app.example.com'] } }).post('/', () => ({ posted: true }))
