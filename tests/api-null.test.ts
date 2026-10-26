import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { pages } from './shared-pages'

const ROUTES = 'tests/fixtures/bare/src/routes'
const NOTHING = `import { api } from 'kay/server'

export default api()
  .get('/null', () => null)
  .get('/undefined', () => undefined)
  .get('/created', ({ set }) => {
    set.status = 201

    return null
  })
  .get('/no-content', ({ status }) => status(204, null))
  .get('/headers', ({ set }) => {
    set.headers['x-seen'] = 'yes'

    return null
  })
`

let dir = ''

async function app(options: { dev?: boolean, base?: string, trailingSlash?: 'always' | 'never' } = {}) {
  return pages({ routes: ROUTES, api: join(dir, 'api'), prebuilt: true, ...options })
}

beforeAll(async () => {
  dir = await mkdtemp(join(process.cwd(), '.kay/api-null-'))
  await Bun.write(join(dir, 'api/nothing.ts'), NOTHING)
})

afterAll(async () => rm(dir, { recursive: true, force: true }))

describe('a handler returning null', () => {
  it.each([
    ['production', {}],
    ['dev', { dev: true }],
    ['a base and trailing slash', { base: '/app', trailingSlash: 'always' as const }],
  ])('answers the JSON null in %s, which response.json() reads', async (_name, options) => {
    const served = await app(options)
    const response = await served.handle(new Request('http://localhost/api/nothing/null'))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toBeNull()
  })

  it('keeps its status and headers, and a bodyless status stays empty', async () => {
    const served = await app()
    const created = await served.handle(new Request('http://localhost/api/nothing/created'))
    const headers = await served.handle(new Request('http://localhost/api/nothing/headers'))
    const none = await served.handle(new Request('http://localhost/api/nothing/no-content'))

    expect(created.status).toBe(201)
    expect(await created.json()).toBeNull()
    expect(headers.headers.get('x-seen')).toBe('yes')
    expect(await headers.json()).toBeNull()
    expect(none.status).toBe(204)
    expect(await none.text()).toBe('')
  })

  it('leaves undefined an empty body', async () => {
    const response = await (await app()).handle(new Request('http://localhost/api/nothing/undefined'))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
  })
})
