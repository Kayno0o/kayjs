import { expect, it } from 'bun:test'
import { withKeepalive } from '../src/runtime/keepalive'

async function sentOf(wanted: boolean, body: unknown, release: Promise<void>): Promise<unknown> {
  return withKeepalive(wanted, body, async (extra) => {
    await release

    return extra?.keepalive
  })
}

it('shares the browser cap between the calls in flight, whoever sends them', async () => {
  let open!: () => void
  const release = new Promise<void>((resolve) => {
    open = resolve
  })
  const body = 'x'.repeat(40 * 1024)
  const first = sentOf(true, body, release)
  const second = sentOf(true, body, release)

  open()

  expect(await first).toBe(true)
  expect(await second).toBeUndefined()
  // Once the first finished, its share is back.
  expect(await sentOf(true, body, Promise.resolve())).toBe(true)
})

it('sends a body of another kind, or a call that did not ask, as a plain call', async () => {
  expect(await sentOf(true, new FormData(), Promise.resolve())).toBeUndefined()
  expect(await sentOf(false, 'a', Promise.resolve())).toBeUndefined()
})
