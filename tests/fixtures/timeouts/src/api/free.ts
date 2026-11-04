import { api } from 'kay/server'

export default api({ timeout: false }).get('/', async () => {
  await Bun.sleep(250)

  return { patient: true }
})
