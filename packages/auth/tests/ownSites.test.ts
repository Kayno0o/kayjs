import { join } from 'node:path'
import { expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { authTest } from '../src/test'

// Two real test sites of an app with `auth()` and no module, in one process: each signs in through the auth built for it.
const ROOT = join(import.meta.dir, 'own-fixture')

const who = async (site: Awaited<ReturnType<typeof testSite>>) => (await site.visit('/')).find('#who')[0]?.text

it('signs each real test site in through its own auth()', async () => {
  const first = await testSite({ root: ROOT })
  const second = await testSite({ root: ROOT, base: '/b' })

  const ada = await authTest(first).signInAs({ email: 'ada@example.com', username: 'Ada' })

  expect(await who(first)).toBe('Signed in as ada@example.com')

  const cookie = await authTest(first).sessionCookie(ada.id)

  await authTest(second).signInAs({ email: 'bob@example.com', username: 'Bob' })

  expect((await second.visit('/b/')).find('#who')[0]?.text).toBe('Signed in as bob@example.com')
  expect(await who(first)).toBe('Signed in as ada@example.com')

  // A session of the first site's store means nothing to the second.
  expect((await second.as(cookie).visit('/b/')).find('#who')[0]?.text).toBe('Anonymous')
})
