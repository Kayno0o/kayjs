import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { apiPathOf, apiStubs, openApiPaths, scanApi } from '../src/server/api-modules'
import { testSite } from '../src/test'
import { scratchDir } from './scratch'

const KEY = { 'x-key': 'open' }
const moved = await testSite({ root: 'tests/fixtures/openapi', apiPath: '/v1', openapi: { reference: true }, mcp: true, base: '/shop' })

afterAll(async () => {
  await moved.close()
})

describe('apiPath', () => {
  it('serves every module, the document and the reference page under it, and nothing under /api', async () => {
    expect((await moved.fetch('/v1/items/1', { headers: KEY })).status).toBe(200)
    expect((await moved.fetch('/api/items/1', { headers: KEY })).status).toBe(404)

    const document = await (await moved.fetch('/v1/openapi.json', { headers: KEY })).json() as { paths: Record<string, Record<string, { tags: string[], operationId: string }>> }

    expect(Object.keys(document.paths).filter(path => !path.startsWith('/v1/'))).toEqual([])
    expect(document.paths['/v1/items/{id}']!.get!.operationId).toBe('get_items_id')
    expect(document.paths['/v1/files']!.get!.tags).toEqual(['files'])
    expect((await moved.fetch('/v1/reference', { headers: KEY })).status).toBe(200)
    expect((await moved.fetch('/api/openapi.json', { headers: KEY })).status).toBe(404)
  })

  it('tells the browser where the API is, and keeps pages from being prefetched under it', async () => {
    const page = await (await moved.fetch('/')).text()

    expect(page).toContain('<meta name="kay-api" content="/v1">')
    expect(page).toContain('/shop/v1/*')
    expect(page).not.toContain('/shop/api/')
  })

  it('hashes the prefetch rules the page carries into its content security policy', async () => {
    const response = await moved.fetch('/')
    const script = (/<script type="speculationrules">(.*?)<\/script>/).exec(await response.text())?.[1]
    const hash = `'sha256-${new Bun.CryptoHasher('sha256').update(script ?? '').digest('base64')}'`

    expect(script).toContain('/shop/v1/*')
    expect(response.headers.get('content-security-policy')).toContain(hash)
  })

  it('keeps /api and sets no meta when left out', async () => {
    const plain = await testSite({ root: 'tests/fixtures/openapi' })

    try {
      expect((await plain.fetch('/api/items/1', { headers: KEY })).status).toBe(200)
      expect(await (await plain.fetch('/')).text()).not.toContain('kay-api')
    }
    finally {
      await plain.close()
    }
  })

  it('refuses a path that is not plain segments or sits under /_kay', () => {
    for (const bad of ['v1', '/v1/', '/', '/a//b', '/a/../b', '/_kay', '/_kay/api', '/a:b', '/a*'])
      expect(() => apiPathOf(bad)).toThrow('apiPath')

    expect(apiPathOf('/v1/public')).toBe('/v1/public')
    expect(apiPathOf(undefined)).toBe('/api')
  })

  it('gives an island the moved mount in the browser build', async () => {
    const dir = resolve('tests/fixtures/openapi/src/api')
    const built = await Bun.build({ entrypoints: [join(dir, 'items.ts')], target: 'browser', plugins: [apiStubs([{ dir, prefix: '', apiPath: '/v1' }])] })

    expect(await built.outputs[0]!.text()).toContain('"/v1/items"')
  })

  it('mounts library trees and the paths of the document under it', async () => {
    const modules = await scanApi('tests/fixtures/openapi/src/api', [], '/v1')

    expect(modules.every(module => module.mount.startsWith('/v1'))).toBe(true)
    expect(openApiPaths(undefined, '/v1')).toEqual({ document: '/v1/openapi.json', reference: '/v1/reference' })
    expect(openApiPaths({ path: '/spec.json' }, '/v1').document).toBe('/spec.json')
  })
})

describe('apiUrl in a handler', () => {
  it('names the route of the module the handler runs in from its request, under apiPath', async () => {
    const root = await scratchDir('api-own-url-')

    try {
      await Bun.write(join(root, 'api/where.ts'), 'import { apiUrl } from \'kay\'\nimport { api } from \'kay/server\'\n\nexport default api({ guards: false }).get(\'/\', ({ request }) => ({ here: apiUrl(request, \'/\'), item: apiUrl(request, \'/items/:id\', { params: { id: 7 }, query: { q: \'a b\' } }) }))\n')

      const site = await testSite({ routes: 'tests/fixtures/openapi/src/routes', api: join(root, 'api'), apiPath: '/v1', base: '/shop' })

      try {
        expect(await (await site.fetch('/v1/where')).json()).toEqual({ here: '/v1/where', item: '/v1/where/items/7?q=a+b' })
      }
      finally {
        await site.close()
      }
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a request no module of src/api received', async () => {
    const { apiUrl } = await import('../src/runtime/live')

    expect(() => apiUrl(new Request('http://localhost/'), '/')).toThrow('under src/api')
  })
})
