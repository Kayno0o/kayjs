import { plugin } from 'bun'
import { expect, it } from 'bun:test'
import { decodeValue, serverWritten } from '../src/runtime/wire'

let loads = 0

// The chunk that posts a call fails to load, as on a lost connection.
plugin({
  name: 'action-post-unreachable',
  setup(build) {
    build.onLoad({ filter: /action-post\.ts$/ }, () => {
      loads++

      throw new TypeError('Failed to fetch dynamically imported module')
    })
  },
})

it('rejects a call whose posting code never loads, after trying it again twice, with nothing left pending', async () => {
  const { reviveActions } = await import('../src/runtime/action-call')

  reviveActions()
  const { run } = decodeValue('[{"run":1},["Action",2],"/_kay/action/routes/index.kay/greet"]', serverWritten) as { run: ((input: object) => Promise<unknown>) & { pending?: () => boolean } }
  const started = Date.now()

  await expect(run({ name: 'Ann' })).rejects.toThrow('Failed to fetch dynamically imported module')
  expect(Date.now() - started).toBeGreaterThanOrEqual(3900)
  expect(loads).toBe(3)
  expect(run.pending?.() ?? false).toBe(false)
}, 20_000)
