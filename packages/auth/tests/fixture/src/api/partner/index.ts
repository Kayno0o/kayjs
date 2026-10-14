import { api } from 'kay/server'

export default api({ cors: { origins: ['https://partner.example'], credentials: true } })
  .post('/', async ({ auth }) => ({ email: (await auth.user())?.email ?? null }))
