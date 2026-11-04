import { api } from 'kay/server'
import { seen } from '../seen'

export default api().get('/', async ({ request }) => {
  seen.api = request.signal
  await Bun.sleep(600)

  return { late: true }
})
