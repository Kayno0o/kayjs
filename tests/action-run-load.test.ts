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

type Stub = ((input: object, options?: object) => Promise<unknown>) & { pending: () => boolean, data: () => unknown, status: () => string, form: { failed: () => unknown }, succeeded: () => unknown, progress: () => unknown }

interface Post {
  name: string
  aborted: () => boolean
  answer: () => void
}

// Stands in for the network: each post waits for `answer()`, or rejects when its signal aborts.
const posts: Post[] = []

globalThis.fetch = (async (_url: unknown, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
  const name = (/,"(\w+)"\]$/).exec(String(init?.body))?.[1] ?? '?'

  posts.push({ name, aborted: () => init?.signal?.aborted === true, answer: () => resolve(new Response('{}', { status: 500 })) })
  init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
})) as unknown as typeof fetch

const stub = (name: string): Stub => (decodeValue(`[{"run":1},["Action",2],"/_kay/action/routes/index.kay/${name}"]`, serverWritten) as { run: Stub }).run

it('reads its state at first paint without the code that runs a call, counts a call in flight at once and loads that code once, whatever the calls made before it', async () => {
  const { reviveActions } = await import('../src/runtime/action-call')

  reviveActions()

  const greet = stub('greet')
  const queued = stub('queued')
  const newest = stub('newest')

  expect([greet.pending(), greet.data(), greet.status(), greet.form.failed(), greet.progress()]).toEqual([false, undefined, 'idle', undefined, undefined])
  expect(loads).toBe(0)

  const started: string[] = []
  const onStart = ({ input }: { input: { name: string } }) => started.push(input.name)
  const calls = [
    greet({ name: 'ann' }),
    queued({ name: 'first' }, { queue: 'serial', onStart }),
    queued({ name: 'second' }, { queue: 'serial', onStart }),
    newest({ name: 'old' }, { queue: 'latest' }),
    newest({ name: 'new' }, { queue: 'latest' }),
  ]

  // A call counts itself in flight before the code that posts it is in.
  expect(greet.pending()).toBe(true)
  expect(greet.status()).toBe('loading')

  await Bun.sleep(10)

  for (let waited = 0; posts.length < 4 && waited < 200; waited++)
    await Bun.sleep(10)

  expect(loads).toBe(1)
  // The calls made before the load go on in the order they were made: each starts in turn, a serial call posts once the one before it is done, and a later `latest` call aborts the earlier one.
  expect(started).toEqual(['first', 'second'])
  expect(posts.map(post => post.name).sort()).toEqual(['ann', 'first', 'new', 'old'])
  expect(posts.find(post => post.name === 'old')!.aborted()).toBe(true)
  expect(posts.find(post => post.name === 'new')!.aborted()).toBe(false)

  for (const post of posts) {
    post.answer()
    await Bun.sleep(10)
  }

  const settled = await Promise.allSettled(calls)

  expect(settled.map(one => one.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'rejected', 'fulfilled'])
  expect(posts.map(post => post.name)).toContain('second')
  expect(posts.map(post => post.name).indexOf('second')).toBeGreaterThan(posts.map(post => post.name).indexOf('first'))
  expect(greet.pending()).toBe(false)
  expect(loads).toBe(1)
})
