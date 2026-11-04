import { api, s } from 'kay/server'

export default api()
  .post('/', () => ({ ok: true }), { body: s.Object({ title: s.String({ minLength: 3 }), tags: s.Optional(s.Array(s.String(), { maxItems: 1 })) }) })
  .get('/search', () => ({ ok: true }), { query: s.Object({ q: s.String({ minLength: 1 }) }) })
  .get('/items/:id', () => ({ ok: true }), { params: s.Object({ id: s.Numeric() }) })
  .post('/named', () => ({ ok: true }), { body: s.Object({ name: s.String({ error: 'Name it' }) }) })
