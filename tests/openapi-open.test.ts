import { afterAll, describe, expect, it } from 'bun:test'
import { testSite } from '../src/test'

// An API directory with no _guard.ts of its own: the document is open to anyone, so a route behind a guard of its own stays out of it.
const site = await testSite({ root: 'tests/fixtures/openapi-open', openapi: { reference: true } })

afterAll(async () => {
  await site.close()
})

describe('an OpenAPI document that no guard protects', () => {
  it('leaves the guarded routes out of the document and the reference page', async () => {
    const document = await (await site.fetch('/api/openapi.json')).json() as { paths: Record<string, unknown> }
    const reference = await (await site.fetch('/api/reference')).text()

    expect(Object.keys(document.paths)).toEqual(['/api/open'])
    expect(reference).toContain('/api/open')
    expect(reference).not.toContain('/api/secret')
    expect(reference).not.toContain('_guard')
  })

  it('still runs the guard of a route it leaves out', async () => {
    expect((await site.fetch('/api/secret')).status).toBe(403)
    expect((await site.fetch('/api/open')).status).toBe(200)
  })
})
