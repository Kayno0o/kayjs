import type { TestSite } from '../src/test'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { nameUser } from '../src/server/request-user'
import { testSite } from '../src/test'
import { pagesOf } from './live-helpers'

const signedIn = new Elysia().derive({ as: 'global' }, ({ request }) => {
  nameUser(request, () => request.headers.get('x-user') ?? undefined)

  return {}
})

// Its own file, so no earlier test has imported the module declaring the value: the first render is the one that does.
describe('the first render of an app declaring a value of each user', () => {
  let site: TestSite

  beforeAll(async () => {
    site = await testSite({ root: 'tests/fixtures/live-user', use: [signedIn] })
  })

  afterAll(async () => {
    await site.close()
  })

  it('binds its page to the user, though that render imported the declaration', async () => {
    const { html } = await site.visit('/', { headers: { 'x-user': 'alice' } })
    const [page] = pagesOf(html)

    expect(page!.sig).toMatch(/\|alice$/)
  })
})
