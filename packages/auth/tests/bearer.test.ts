import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { Elysia } from 'elysia'
import { browser as browserOf, testApp } from './helpers/app'

const PASSWORD = 'correct horse battery'

afterEach(() => {
  setSystemTime()
})

async function withToken() {
  const app = testApp()
  const ada = app.browser()

  await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
  const minted = await ada.call('createToken', { password: PASSWORD }, 'Phone')

  return { ...app, ada, minted, bearer: { authorization: `Bearer ${minted.token}` } }
}

describe('bearer tokens', () => {
  test('a device sending one reads as its user, without a session', async () => {
    const { browser, bearer } = await withToken()
    const device = browser()

    expect(await device.json('/me', { headers: bearer })).toMatchObject({ email: 'ada@example.com' })
    expect(device.cookies.size).toBe(0)
    expect(await device.json('/me')).toBe('anonymous')
  })

  test('are listed without the token, and stop working once revoked', async () => {
    const { ada, browser, bearer, minted } = await withToken()
    const tokens = await ada.call('tokens')

    expect(tokens).toEqual([{ id: minted.id, label: 'Phone', createdAt: expect.any(String), lastUsedAt: null }])
    expect(JSON.stringify(tokens)).not.toContain(minted.token)

    expect(await ada.call('revokeToken', minted.id)).toBe(true)
    expect(await browser().json('/me', { headers: bearer })).toBe('anonymous')
  })

  test('record their last use, at most every five minutes', async () => {
    const { ada, browser, bearer, store } = await withToken()
    const { id } = await ada.json('/me') as { id: string }
    const lastUsed = async () => (await store.bearerTokens.listByUser(id))[0]!.lastUsedAt

    await browser().json('/me', { headers: bearer })
    const first = await lastUsed()

    expect(first).toBeInstanceOf(Date)

    setSystemTime(Date.now() + 60 * 1000)
    await browser().json('/me', { headers: bearer })
    expect(await lastUsed()).toEqual(first)

    setSystemTime(Date.now() + 6 * 60 * 1000)
    await browser().json('/me', { headers: bearer })
    expect(await lastUsed()).not.toEqual(first)
  })

  test('cannot mint more tokens, nor revoke another user\'s', async () => {
    const { browser, bearer, minted } = await withToken()
    const device = browser()
    const bob = browser()

    expect(await device.json('/call/createToken', { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify([{ password: PASSWORD }, 'Another']) })).toEqual({ ok: false, error: 'signed-out' })

    await bob.call('register', { email: 'bob@example.com', password: PASSWORD })

    expect(await bob.call('revokeToken', minted.id)).toBe(false)
  })

  test('minting needs the password and a label', async () => {
    const { ada } = await withToken()

    expect(await ada.call('createToken', { password: 'wrong password!' }, 'Laptop')).toEqual({ ok: false, error: 'proof' })
    expect(await ada.call('createToken', { password: PASSWORD }, '  ')).toEqual({ ok: false, error: 'label' })
  })

  test('pass a gate, and a websocket handshake can check one', async () => {
    const { auth, app, minted, bearer } = await withToken()
    const gated = new Elysia().use(app).use(new Elysia().use(auth.gate()).get('/private', () => 'ok'))

    expect((await browserOf(gated).fetch('/private', { headers: bearer })).status).toBe(200)
    expect(await auth.userFromToken(minted.token)).toMatchObject({ email: 'ada@example.com' })
    expect(await auth.userFromToken('forged')).toBeNull()
  })

  test('die with their user', async () => {
    const { ada, browser, bearer } = await withToken()

    await ada.call('deleteAccount', { password: PASSWORD })

    expect(await browser().json('/me', { headers: bearer })).toBe('anonymous')
  })
})
