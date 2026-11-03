import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { auth } from '../src/pages'
import { authTest } from '../src/test'

// A real test site whose admins must have two-factor: the admin page sends them to the security page, which sends them back once it is on.
const ROOT = join(import.meta.dir, 'own-fixture')

let site: Awaited<ReturnType<typeof testSite>>

beforeAll(async () => {
  site = await testSite({ root: ROOT, extensions: [auth({ admin: 'admin', roles: { admin: [] }, twoFactor: { require: ['admin'] } })], islands: false })
}, 180_000)

afterAll(async () => {
  await site?.close()
})

const manual = { redirect: 'manual' as const, headers: { accept: 'text/html' } }

it('sends an admin without two-factor to the security page and back once it is on', async () => {
  const as = authTest(site)
  const admin = await as.signInAs({ email: 'root@example.com', username: 'Root', roles: ['admin'] })
  const sent = await site.fetch('/auth/admin', manual)

  expect(sent.status).toBe(302)
  expect(sent.headers.get('location')).toBe('/auth/account/security?redirect=%2Fauth%2Fadmin')

  // The security page itself is reachable, with no loop.
  expect((await site.fetch('/auth/account/security?redirect=%2Fauth%2Fadmin', manual)).status).toBe(200)

  await as.enrollTotp(admin.id)

  const back = await site.fetch('/auth/account/security?redirect=%2Fauth%2Fadmin', manual)

  expect(back.status).toBe(302)
  expect(back.headers.get('location')).toBe('/auth/admin')
  expect((await site.fetch('/auth/admin', manual)).status).toBe(200)
})

it('ignores a redirect that leaves the site', async () => {
  const as = authTest(site)
  const other = await as.signInAs({ email: 'second@example.com', username: 'Second', roles: ['admin'] })

  await as.enrollTotp(other.id)
  expect((await site.fetch('/auth/account/security?redirect=https%3A%2F%2Fevil.test%2F', manual)).status).toBe(200)
})
