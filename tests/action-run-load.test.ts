import { plugin } from 'bun'
import { expect, it } from 'bun:test'
import { decodeValue, serverWritten } from '../src/runtime/wire'

let loads = 0

// Counts the loads of the code that runs a call, which the first call of an action brings in.
plugin({
  name: 'action-run-counted',
  setup(build) {
    build.onLoad({ filter: /action-run\.ts$/ }, async ({ path }) => {
      loads++

      return { contents: await Bun.file(path).text(), loader: 'ts' }
    })
  },
})

type Stub = ((input: object) => Promise<unknown>) & { pending: () => boolean, data: () => unknown, status: () => string, failed: () => unknown, succeeded: () => unknown, progress: () => unknown }

it('reads its state at first paint without the code that runs a call, counts a call in flight at once and loads that code with the first call', async () => {
  const { reviveActions } = await import('../src/runtime/action-call')

  reviveActions()

  const { run } = decodeValue('[{"run":1},["Action",2],"/_kay/action/routes/index.kay/greet"]', serverWritten) as { run: Stub }

  expect([run.pending(), run.data(), run.status(), run.failed(), run.succeeded(), run.progress()]).toEqual([false, undefined, 'idle', undefined, undefined, undefined])
  expect(loads).toBe(0)

  const call = run({ name: 'Ann' })

  // The call counts itself in flight before the code that posts it is in.
  expect(run.pending()).toBe(true)
  expect(run.status()).toBe('loading')

  await call

  expect(loads).toBe(1)
  expect(run.pending()).toBe(false)
})
