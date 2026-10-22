import { t } from 'elysia'
import { api, toolCall } from 'kay/server'

export default api()
  .get('/:id', ({ params, query }) => ({ id: params.id, fields: query.fields ?? null, tags: query.tags ?? [] }), {
    params: t.Object({ id: t.String() }),
    query: t.Object({ fields: t.Optional(t.String()), tags: t.Optional(t.Array(t.String())) }),
    detail: { summary: 'One note', description: 'Reads a note by its id.', tool: true },
  })
  .post('/', ({ body }) => ({ created: body.title, pinned: body.pinned ?? false }), { body: t.Object({ title: t.String(), pinned: t.Optional(t.Boolean()) }), detail: { operationId: 'create_note', tool: true } })
  .delete('/:id', ({ params }) => ({ deleted: params.id }), { params: t.Object({ id: t.String() }), detail: { tool: true } })
  .get('/hidden', () => 'secret', { detail: { hide: true } })
  .get('/both', () => 'both', { detail: { hide: true, tool: true } })
  .get('/internal', () => 'internal')
  .get('/tagged', () => 'tagged', { detail: { tool: { name: 'tagged_note', description: 'A note by its tag' } } })
  .get('/described', () => 'described', { detail: { summary: 'Summary', tool: 'What an agent reads' } })
  .post('/photo', () => 'stored', { body: t.Object({ photo: t.File() }), detail: { tool: true } })
  .get('/words', () => 'plain words', { detail: { tool: true } })
  .get('/binary', () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'application/octet-stream' } }), { detail: { tool: true } })
  .get('/paged', ({ query }) => ({ limit: query.limit }), { query: t.Object({ limit: t.Integer({ default: 20 }), after: t.Integer() }), detail: { tool: true } })
  .post('/draft', ({ body }) => body, { body: t.Object({ title: t.String(), copies: t.Integer({ default: 1 }) }), detail: { operationId: 'draft_note', tool: true } })
  .get('/search', ({ query }) => ({ count: query.limit }), { query: t.Object({ limit: t.Numeric() }), detail: { tool: true } })
  .get('/who', ({ request }) => ({ tool: toolCall(request)?.tool ?? null, leaked: [...request.headers.keys()].filter(name => name.startsWith('x-kay-')) }), { detail: { tool: true } })
