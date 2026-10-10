import { afterAll, describe, expect, it } from 'bun:test'
import { testSite } from '../src/test'

const KEY = { 'x-key': 'open' }
const site = await testSite({ routes: 'tests/fixtures/openapi/src/routes', api: 'tests/fixtures/openapi/src/api', openapi: { title: 'Shop', version: '2.1.0', reference: true }, base: '/shop' })
const hidden = await testSite({ routes: 'tests/fixtures/openapi/src/routes', api: 'tests/fixtures/openapi/src/api', openapi: { dev: true } })

afterAll(async () => {
  await Promise.all([site.close(), hidden.close()])
})

async function documented(): Promise<{ info: unknown, servers: unknown, paths: Record<string, Record<string, Record<string, unknown>>> }> {
  const response = await site.fetch('/api/openapi.json', { headers: KEY })

  expect(response.headers.get('content-type')).toContain('application/json')

  return response.json() as never
}

describe('the OpenAPI document', () => {
  it('lists every route the modules serve, each path param in braces, under the site\'s base', async () => {
    const document = await documented()

    expect(document.info).toEqual({ title: 'Shop', version: '2.1.0' })
    expect(document.servers).toEqual([{ url: '/shop' }])
    expect(Object.keys(document.paths).sort()).toEqual(['/api/items', '/api/items/photo', '/api/items/{id}', '/api/private'])
    expect(Object.keys(document.paths['/api/items/{id}']!)).toEqual(['get'])
  })

  it('reads params, query, body and each status\'s answer from the schemas, a summary and tags from the route\'s detail', async () => {
    const one = (await documented()).paths['/api/items/{id}']!.get!

    expect(one.summary).toBe('One item')
    expect(one.tags).toEqual(['catalog'])
    expect(one.parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { anyOf: [{ format: 'numeric', default: 0, type: 'string' }, { type: 'number' }] } },
      { name: 'fields', in: 'query', required: false, schema: { type: 'string' } },
    ])
    expect(one.responses).toEqual({
      200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', required: ['id', 'name'], properties: { id: { type: 'number' }, name: { type: 'string' } } } } } },
      404: { description: 'Error', content: { 'application/json': { schema: { const: 'Not found', type: 'string' } } } },
    })
  })

  it('gives a body as JSON, a Date as its text, and a body holding a file as multipart', async () => {
    const { paths } = await documented()

    expect(paths['/api/items']!.post!.requestBody).toEqual({ required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'added'], properties: { name: { type: 'string' }, added: { anyOf: [{ format: 'date-time', type: 'string' }, { format: 'date', type: 'string' }, { type: 'number' }] } } } } } })
    expect(paths['/api/items']!.post!.tags).toEqual(['items'])
    expect(Object.keys((paths['/api/items/photo']!.post!.requestBody as { content: object }).content)).toEqual(['multipart/form-data'])
  })

  it('names the guards a route runs, by where they sit in the API directory', async () => {
    const { paths } = await documented()

    expect(paths['/api/private']!.get!['x-kay-guards']).toEqual(['_guard.ts', 'private/_guard.ts'])
  })

  it('is served behind the API directory\'s own guard, and nothing below it', async () => {
    expect((await site.fetch('/api/openapi.json')).status).toBe(401)
    expect((await site.fetch('/api/reference')).status).toBe(401)
  })

  it('renders a reference page listing the routes, with no script', async () => {
    const page = await site.fetch('/api/reference', { headers: KEY })
    const html = await page.text()

    expect(page.headers.get('content-type')).toContain('text/html')
    expect(html).toContain('<h2><code>GET /api/items/{id}</code></h2><p>One item</p>')
    expect(html).toContain('<p>Guarded by <code>_guard.ts</code>, <code>private/_guard.ts</code></p>')
    expect(html).not.toContain('<script')
  })

  it('kept to kay dev, is not served by a production server', async () => {
    expect((await hidden.fetch('/api/openapi.json', { headers: KEY })).status).toBe(404)
  })
})
