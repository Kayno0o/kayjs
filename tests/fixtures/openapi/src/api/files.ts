import { t } from 'elysia'
import { api } from 'kay/server'

export default api()
  .get('/:name?', ({ params }) => params.name ?? 'all')
  .get('/raw/*', ({ params }) => params['*'])
  .get('/any', () => 'specific', { detail: { summary: 'Specific' } })
  .all('/any', () => 'any')
  .post('/bytes', () => 'stored', { body: t.Uint8Array() })
  .get('/size', () => 1n, { response: t.BigInt({ minimum: 0n }) })
