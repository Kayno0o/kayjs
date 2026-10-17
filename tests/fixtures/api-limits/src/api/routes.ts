import { api } from 'kay/server'

const user = (ctx: { request: Request }) => ctx.request.headers.get('x-user') ?? undefined

export default api()
  .get('/open', () => ({ open: true }))
  .post('/upload', () => ({ uploaded: true }), { detail: { bodyLimit: '16b' } })
  .post('/items/:id', ({ params }) => ({ id: params.id }), { detail: { bodyLimit: 16, rateLimit: { max: 1, window: '1m' } } })
  .post('/items/plain', () => ({ plain: true }))
  .get('/mine', () => ({ mine: true }), { detail: { rateLimit: { max: 1, window: '1m', key: user } } })
  .get('/empty', () => ({ empty: true }), { detail: { rateLimit: { max: 1, window: '1m', key: () => '' } } })
  .get('/throws', () => ({ throws: true }), {
    detail: {
      rateLimit: {
        max: 1,
        window: '1m',
        key: () => {
          throw new Error('no user')
        },
      },
    },
  })
  .all('/any', () => 'any', { detail: { rateLimit: { max: 1, window: '1m' } } })
  .get('/wild/*', () => ({ wild: true }), { detail: { rateLimit: { max: 1, window: '1m' } } })
  .get('/maybe/:page?', () => ({ maybe: true }), { detail: { rateLimit: { max: 1, window: '1m' } } })
