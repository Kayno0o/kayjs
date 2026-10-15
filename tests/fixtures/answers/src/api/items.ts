import { Elysia } from 'elysia'

export default new Elysia()
  .get('/', () => [{ id: 1 }])
  .get('/headed', ({ set }) => {
    set.headers['x-custom'] = 'yes'
    set.headers['cache-control'] = 'no-store'

    return { ok: true }
  })
  .get('/response', () => new Response('plain', { headers: { 'content-type': 'text/plain', 'x-own': 'mine' } }))
