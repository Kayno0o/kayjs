import { api } from 'kay/server'

// Sorted before every other module, so its rule is the first one any request meets.
export default api({ cors: { origins: ['https://first.example'], credentials: true } }).get('/', () => ({ first: true })).all('/any', () => 'any')
