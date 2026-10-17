import { api } from 'kay/server'

// Two requests a minute to the module, whichever route.
export default api({ rateLimit: { max: 2, window: '1m' } })
  .get('/', () => ({ limited: true }))
  .get('/:id', ({ params }) => ({ id: params.id }))
