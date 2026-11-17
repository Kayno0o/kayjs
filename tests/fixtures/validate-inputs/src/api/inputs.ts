import { s } from 'kay'
import { api } from 'kay/server'

export default api()
  .get('/query', ({ query }) => query, { query: s.object({ a: s.int() }) })
  .get('/headers', ({ headers }) => headers, { headers: s.object({ 'x-a': s.string() }) })
  .get('/cookie', () => 'ok', { cookie: s.Cookie({ token: s.string({ min: 3 }) }) })
  // Declares only a query, so the body is the handler's own to read.
  .post('/raw', async ({ request }) => request.json(), { query: s.object({ a: s.int({ optional: true }) }) })
  .post('/undeclared', async ({ request }) => request.json())
  .post('/form', ({ body }) => body, { body: s.object({ name: s.string() }) })
