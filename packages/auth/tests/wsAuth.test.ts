import { describe, expect, test } from 'bun:test'
import { createWsAuthStore } from '../src/wsAuth'

describe('createWsAuthStore', () => {
  const ws = (id: string) => {
    const sent: string[] = []

    return { ws: { id, send: (m: string) => sent.push(m), close: () => undefined }, sent }
  }

  test('stores the verified value per connection and acks', async () => {
    const store = createWsAuthStore<{ userId: number }>(async token => token === 'good' ? { userId: 1 } : null)
    const a = ws('c1')

    await store.handleAuth(a.ws, 'good')

    expect(store.get(a.ws)).toEqual({ userId: 1 })
    expect(a.sent).toEqual([JSON.stringify({ type: 'authed' })])
  })

  test('a rejected token stores nothing and sends no ack', async () => {
    const store = createWsAuthStore<{ userId: number }>(async () => null)
    const a = ws('c2')

    await store.handleAuth(a.ws, 'bad')

    expect(store.get(a.ws)).toBeUndefined()
    expect(a.sent).toEqual([])
  })

  test('forget drops the stored value', async () => {
    const store = createWsAuthStore<number>(async () => 7)
    const a = ws('c3')

    await store.handleAuth(a.ws, 't')
    expect(store.get(a.ws)).toBe(7)

    store.forget(a.ws)
    expect(store.get(a.ws)).toBeUndefined()
  })
})
