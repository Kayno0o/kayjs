// Calls an action and an API route in a process of its own where the upload's chunk fails to load, as one a deploy replaced does, and prints what each did.
import type { Action } from '../../../src/runtime'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

let loads = 0

Bun.plugin({
  name: 'stale upload',
  setup(build) {
    build.onLoad({ filter: /[/\\]runtime[/\\]upload\.ts$/ }, () => {
      loads++

      throw new Error('stale chunk')
    })
  },
})

GlobalRegistrator.register()
globalThis.fetch = (async () => Promise.reject(new TypeError('offline'))) as unknown as typeof fetch

const { signal } = await import('../../../src/runtime')
const { actionStub } = await import('../../../src/runtime/action')
const { API_MOUNT, call } = await import('../../../src/runtime/live')

async function settled(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise

    return 'resolved'
  }
  catch (error) {
    return { name: (error as Error).name, message: (error as Error).message, status: (error as { status?: number }).status }
  }
}

const save = actionStub('/_kay/action/test/save') as unknown as Action<object, null>
const json = await settled(save({ title: 'Milk' }))
const loadsAfterJson = loads
const count = signal(0)
const filed = await settled(save({ cover: new File(['x'], 'cover.png') }, { optimistic: () => count.set(1) }))
const form = new FormData()
const progress: number[] = []

form.set('cover', new File(['x'], 'cover.png'))

const called = await settled(call({ [API_MOUNT]: '/api/covers' } as never, '/' as never, { method: 'post', body: form, progress: (done: number) => progress.push(done) } as never))

console.log(JSON.stringify({ json, loadsAfterJson, filed, pending: save.pending(), count: count(), called, progress, loaded: loads > 0 }))
await GlobalRegistrator.unregister()
