import { cached } from 'kay/cache'
import { api } from 'kay/server'
import { db } from '../data'

export default api()
  .get('/', async () => ({ orders: await cached('orders', '1m', () => db.orders, { live: true }) }))
  // Reads the live key through a helper and twice.
  .get('/twice', async () => ({ first: await cached('orders', '1m', () => db.orders, { live: true }), second: await cached('orders', '1m', () => db.orders, { live: true }) }))
  .get('/plain', async () => ({ orders: await cached('orders', '1m', () => db.orders) }))
  .get('/none', () => ({ none: true }))
  .get('/mine', async ({ request }) => request.headers.has('x-user') ? { secret: await cached('secret', '1m', () => db.secret, { live: true }) } : { secret: 'sign in' })
  .get('/missing', async ({ status }) => {
    await cached('orders', '1m', () => db.orders, { live: true })

    return status(404, 'gone')
  })
  .get('/throws', async () => {
    await cached('orders', '1m', () => db.orders, { live: true })

    throw new Error('boom')
  })
  .get('/long', async () => cached('x'.repeat(300), '1m', () => 1, { live: true }))
  .get('/many', async () => {
    for (let index = 0; index < 5; index++)
      await cached(`many-${index}-${'y'.repeat(500)}`, '1m', () => 1, { live: true })

    return 'many'
  })
  .post('/', async () => ({ orders: await cached('orders', '1m', () => db.orders, { live: true }) }))
