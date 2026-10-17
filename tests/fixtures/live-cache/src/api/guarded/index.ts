import { cached } from 'kay/cache'
import { api } from 'kay/server'
import { db } from '../../data'

export default api().get('/', async () => ({ secret: await cached('secret', '1m', () => db.secret, { live: true }) }))
