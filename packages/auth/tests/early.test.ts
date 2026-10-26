import { join } from 'node:path'
import { expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { auth, store } from './early-fixture/src/auth'
import { userRecord } from './helpers/app'

// A cookie minted before the first `testSite()`, which is what an app's test helper does at import time: the site's store did not exist yet.
it('signs in a request with a cookie minted before the first test site', async () => {
  await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com' }))

  const cookie = await auth.sessionCookie('u1')
  const site = await testSite({ root: join(import.meta.dir, 'early-fixture') })

  try {
    expect((await site.fetch('/', { headers: { cookie }, redirect: 'manual' })).status).toBe(200)
  }
  finally {
    await site.close()
  }
})
