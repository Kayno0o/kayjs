import type { TestSite } from '../src/test'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { nameUser } from '../src/server/request-user'
import { testSite } from '../src/test'

let asked = 0

const signedIn = new Elysia().derive({ as: 'global' }, ({ request }) => {
  nameUser(request, () => {
    asked++

    return 'alice'
  })

  return {}
})

// Its own file, as an app declaring a value of each user anywhere in the process makes streamed pages ask.
describe('an app declaring no value of each user', () => {
  let site: TestSite

  beforeAll(async () => {
    site = await testSite({ root: 'tests/fixtures/live-plain', use: [signedIn] })
  })

  afterAll(async () => {
    await site.close()
  })

  it('never asks who is signed in, for a plain page or a streamed one, first request or later', async () => {
    for (const path of ['/', '/', '/streamed', '/streamed'])
      expect((await site.visit(path)).html).toContain('visitors')

    expect(asked).toBe(0)
  })
})
