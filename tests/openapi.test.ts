import { afterAll, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { testSite } from '../src/test'

const CLI = resolve('src/cli.ts')
const KEY = { 'x-key': 'open' }
const projects: string[] = []
const site = await testSite({ routes: 'tests/fixtures/openapi/src/routes', api: 'tests/fixtures/openapi/src/api', openapi: { title: 'Shop', version: '2.1.0', reference: true }, base: '/shop' })
const signedIn = await testSite({ routes: 'tests/fixtures/openapi/src/routes', api: 'tests/fixtures/openapi/src/api', openapi: true, locals: request => ({ key: request.headers.get('x-session-key') ?? undefined }) })
const hidden = await testSite({ routes: 'tests/fixtures/openapi/src/routes', api: 'tests/fixtures/openapi/src/api', openapi: { dev: true } })

afterAll(async () => {
  await Promise.all([site.close(), signedIn.close(), hidden.close(), ...projects.map(async dir => rm(dir, { recursive: true, force: true }))])
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
    expect(Object.keys(document.paths).sort()).toEqual(['/api/files', '/api/files/any', '/api/files/bytes', '/api/files/raw/{wildcard}', '/api/files/size', '/api/files/{name}', '/api/items', '/api/items/photo', '/api/items/{id}', '/api/private'])
    expect(Object.keys(document.paths['/api/items/{id}']!)).toEqual(['get'])
  })

  it('reads params, query, body and each status\'s answer from the schemas, a summary and tags from the route\'s detail', async () => {
    const one = (await documented()).paths['/api/items/{id}']!.get!

    expect(one.summary).toBe('One item')
    expect(one.tags).toEqual(['catalog'])
    expect(one.parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'number' } },
      { name: 'fields', in: 'query', required: false, schema: { type: 'string' } },
    ])
    expect(one.responses).toEqual({
      200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', required: ['id', 'name'], properties: { id: { type: 'number' }, name: { type: 'string' } } } } } },
      404: { description: 'Error', content: { 'text/plain': { schema: { const: 'Not found', type: 'string' } } } },
    })
  })

  it('gives a body as JSON, a Date as its text, and a body holding a file as multipart', async () => {
    const { paths } = await documented()

    expect(paths['/api/items']!.post!.requestBody).toEqual({ required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'added'], properties: { name: { type: 'string' }, added: { anyOf: [{ format: 'date-time', type: 'string' }, { format: 'date', type: 'string' }, { type: 'number' }] } } } } } })
    expect(paths['/api/items']!.post!.tags).toEqual(['items'])
    expect(Object.keys((paths['/api/items/photo']!.post!.requestBody as { content: object }).content)).toEqual(['multipart/form-data'])
  })

  it('lists a route with an optional param with and without it, names a wildcard, and keeps a method\'s own route over .all()', async () => {
    const { paths } = await documented()

    expect(paths['/api/files']!.get).toBeDefined()
    expect((paths['/api/files/{name}']!.get!.parameters as unknown[])[0]).toEqual({ name: 'name', in: 'path', required: true, schema: { type: 'string' } })
    expect((paths['/api/files/raw/{wildcard}']!.get!.parameters as unknown[])[0]).toMatchObject({ name: 'wildcard', in: 'path', required: true })
    expect(paths['/api/files/any']!.get!.summary).toBe('Specific')
    expect(Object.keys(paths['/api/files/any']!)).toEqual(['get', 'post', 'put', 'patch', 'delete'])
  })

  it('gives raw bytes as binary and a bigint as an integer', async () => {
    const { paths } = await documented()

    expect(paths['/api/files/bytes']!.post!.requestBody).toEqual({ required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } })
    expect(paths['/api/files/size']!.get!.responses).toEqual({ 200: { description: 'OK', content: { 'application/json': { schema: { type: 'integer', minimum: 0 } } } } })
  })

  it('refuses to start when a module serves the path the document or its page is served at', async () => {
    await expect(testSite({ routes: 'tests/fixtures/openapi-clash/src/routes', api: 'tests/fixtures/openapi-clash/src/api', openapi: { reference: true } })).rejects.toThrow('serves /api/reference, where `openapi` serves its reference page')
  })

  it('has kay check take a link to the document or its page', async () => {
    const base = join(import.meta.dir, '../node_modules/.cache')

    await mkdir(base, { recursive: true })

    const dir = await mkdtemp(join(base, 'openapi-'))

    projects.push(dir)
    await Promise.all(Object.entries({
      'package.json': JSON.stringify({ name: 'app' }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true }, include: ['src', '.kay/types'] }),
      'kay.config.ts': 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ openapi: { reference: true } })\n',
      'src/routes/index.kay': 'a(href="/api/reference") API\na(href="/api/openapi.json") Spec\n',
    }).map(async ([path, content]) => Bun.write(join(dir, path), content)))

    const child = Bun.spawn([process.execPath, CLI, 'check'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

    expect(`${stdout}${stderr}`).not.toContain('/api/reference')
    expect(code).toBe(0)
  })

  it('names the guards a route runs, by where they sit in the API directory', async () => {
    const { paths } = await documented()

    expect(paths['/api/private']!.get!['x-kay-guards']).toEqual(['_guard.ts', 'private/_guard.ts'])
  })

  it('is served behind the API directory\'s own guard, and nothing below it', async () => {
    expect((await site.fetch('/api/openapi.json')).status).toBe(401)
    expect((await site.fetch('/api/reference')).status).toBe(401)
  })

  it('gives that guard what an API route\'s gets, the app\'s session included', async () => {
    expect((await signedIn.fetch('/api/openapi.json', { headers: { 'x-session-key': 'open' } })).status).toBe(200)
    expect((await signedIn.fetch('/api/openapi.json')).status).toBe(401)
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
