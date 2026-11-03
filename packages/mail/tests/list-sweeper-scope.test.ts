import { describe, expect, it } from 'bun:test'
import { currentServerScope } from '../../../src/runtime/reactive'
import { inServerScope } from '../../../src/server/scope'
import { listSweeper } from '../src/list-sweeper'

describe('the list sweeper', () => {
  it('sweeps outside the request that started it', async () => {
    let seen: unknown = 'unset'
    const store = { closed: false, sweep: () => {
      seen = currentServerScope()
    } }
    const sweeper = listSweeper(() => [store as never], { after: 1, every: 3_600_000 })
    const request = new Request('http://localhost/')

    await inServerScope(request, () => undefined, async () => {
      sweeper.start()
      await Bun.sleep(30)
    })
    sweeper.stop()

    expect(seen).toBeUndefined()
  })
})
