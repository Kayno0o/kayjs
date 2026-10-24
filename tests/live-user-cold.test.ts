import type { TestSite } from '../src/test'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { nameUser } from '../src/server/request-user'
import { testSite } from '../src/test'
import { pagesOf } from './live-helpers'

let asked = 0

// Counts how often kay asks who is signed in, as a session read would cost.
const signedIn = new Elysia().derive({ as: 'global' }, ({ request }) => {
  nameUser(request, () => {
    asked++

    return request.headers.get('x-user') ?? undefined
  })

  return {}
})

// Its own file, so no earlier request has taught kay which pages read a value of each user.
describe('who is signed in, asked for the pages that read a value of each user only', () => {
  let site: TestSite

  const visit = async (path: string) => (await site.visit(path, { headers: { 'x-user': 'alice' } })).html

  beforeAll(async () => {
    site = await testSite({ root: 'tests/fixtures/live-user', use: [signedIn] })
  })

  afterAll(async () => {
    await site.close()
  })

  it('never asks for a page reading none', async () => {
    await visit('/about')
    await visit('/about')
    expect(asked).toBe(0)
  })

  it('binds the first request of a page reading one to its user, rendering it again once, then asks before rendering', async () => {
    expect(pagesOf(await visit('/'))[0]!.sig).toMatch(/\|alice$/)
    expect(asked).toBe(1)
    expect(pagesOf(await visit('/'))[0]!.sig).toMatch(/\|alice$/)
    expect(asked).toBe(2)
  })

  it('goes on never asking for the page reading none', async () => {
    await visit('/about')
    expect(asked).toBe(2)
  })
})
