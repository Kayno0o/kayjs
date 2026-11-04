import { api } from 'kay/server'

export default api({ timeout: '30ms' })
  .get('/', async () => {
    await Bun.sleep(400)

    return { late: true }
  })
  .get('/long', async () => {
    await Bun.sleep(250)

    return { allowed: true }
  }, { detail: { timeout: '1s' } })
