import { describe, expect, it } from 'bun:test'
import { testSite } from '../src/test'

describe('the OpenAPI document', () => {
  it('refuses to start when a module serves the path the document or its page is served at', async () => {
    await expect(testSite({ root: 'tests/fixtures/openapi-clash', openapi: { reference: true } })).rejects.toThrow('serves /api/reference, where `openapi` serves its reference page')
  })
})
