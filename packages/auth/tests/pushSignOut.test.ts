import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { forgetPushDevice, push, pushSubscriptions } from 'kay/server'
import { testSite } from 'kay/test'
import { generateVapidKeys } from '../../../src/server/push-crypto'
import { auth } from '../src/pages'
import { authTest } from '../src/test'

// A real test site with `auth()` and `push()`: the device is subscribed through the push route and left through the sign-out route.
const ROOT = join(import.meta.dir, 'bell-fixture')

let site: Awaited<ReturnType<typeof testSite>>

beforeAll(async () => {
  site = await testSite({ root: ROOT, extensions: [auth(), push()], islands: false })
}, 180_000)

afterAll(async () => {
  await site?.close()
})

async function subscribe(endpoint: string): Promise<Response> {
  const keys = await generateVapidKeys()

  return site.fetch('/_kay/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint, keys: { p256dh: keys.publicKey, auth: 'AAAAAAAAAAAAAAAAAAAAAA' } }) })
}

describe('signing out with push', () => {
  it('takes this browser\'s subscription from the person, and keeps their other devices', async () => {
    const ada = await authTest(site).signInAs({ email: 'ada@example.com', username: 'Ada' })

    expect((await subscribe('https://8.8.8.8/push/other')).status).toBe(204)
    // Another device of the same person, which a browser of its own would hold.
    const other = await pushSubscriptions.list(ada.id)

    expect(other).toHaveLength(1)
    await forgetPushDevice(new Request('http://localhost/'), ada.id)
    expect(await pushSubscriptions.list(ada.id)).toHaveLength(1)

    expect((await subscribe('https://8.8.8.8/push/this')).status).toBe(204)
    expect(await pushSubscriptions.list(ada.id)).toHaveLength(2)

    const out = await site.fetch('/auth/sign-out', { method: 'POST' })

    expect(out.status).toBeLessThan(400)
    expect((await pushSubscriptions.list(ada.id)).map(each => each.endpoint)).toEqual(['https://8.8.8.8/push/other'])
  })

  it('tells the browser to forget its local() mirrors, with a new value each time', async () => {
    await authTest(site).signInAs({ email: 'edith@example.com', username: 'Edith' })

    const first = (await site.fetch('/auth/sign-out', { method: 'POST' })).headers.getSetCookie().find(line => line.startsWith('kay_local_clear='))

    expect(first).toBeDefined()
    expect(first).toContain('Path=/')

    await authTest(site).signInAs({ email: 'edith@example.com', username: 'Edith' })

    const second = (await site.fetch('/auth/sign-out', { method: 'POST' })).headers.getSetCookie().find(line => line.startsWith('kay_local_clear='))

    expect(second).toBeDefined()
    expect(second!.slice(0, second!.indexOf(';'))).not.toBe(first!.slice(0, first!.indexOf(';')))
  })

  it('leaves everything alone for a browser that never subscribed', async () => {
    const grace = await authTest(site).signInAs({ email: 'grace@example.com', username: 'Grace' })

    await forgetPushDevice(new Request('http://localhost/', { headers: { cookie: 'kay_push_device=nothing' } }), grace.id)
    expect(await pushSubscriptions.list(grace.id)).toEqual([])
  })
})
