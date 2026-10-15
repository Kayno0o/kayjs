import { Elysia } from 'elysia'

const constant = new Response('constant', { headers: { 'content-type': 'text/plain' } })
const reused = new Response('reused', { headers: { 'content-type': 'text/plain' } })

export default new Elysia()
  .get('/', () => [{ id: 1 }])
  .get('/headed', ({ set }) => {
    set.headers['x-custom'] = 'yes'
    set.headers['cache-control'] = 'no-store'

    return { ok: true }
  })
  .get('/response', () => new Response('plain', { headers: { 'content-type': 'text/plain', 'x-own': 'mine' } }))
  .get('/constant', constant)
  .get('/reused', () => reused)
  .get('/cookied', ({ set }) => {
    set.headers['set-cookie'] = 'a=1; Path=/'

    return new Response('cookied', { headers: { 'content-type': 'text/plain' } })
  })
  .get('/created', ({ set }) => {
    set.status = 201

    return new Response('created', { headers: { 'content-type': 'text/plain' } })
  })
