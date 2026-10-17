import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { actionStub, reviveActions } from '../src/runtime/action'
import { decodeValue, serverWritten } from '../src/runtime/wire'

const original = globalThis.fetch
let requested = ''

beforeAll(() => {
  reviveActions()
  GlobalRegistrator.register({ url: 'http://localhost/blog/' })

  const meta = document.createElement('meta')

  meta.name = 'kay-base'
  meta.content = '/blog'
  document.head.append(meta)
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested = String(input)

    return new Response('["Hello Ann"]', { status: 200, headers: { 'content-type': 'text/plain' } })
  }) as typeof fetch
})

afterAll(async () => {
  globalThis.fetch = original
  await GlobalRegistrator.unregister()
})

it('posts an action an island was passed under the base, the URL it was sent with being the server\'s own', async () => {
  const { run } = decodeValue('[{"run":1},["Action",2],"/_kay/action/routes/index.kay/greet"]', serverWritten) as { run: (input: object) => Promise<unknown> }

  await run({ name: 'Ann' })
  expect(new URL(requested, 'http://localhost').pathname).toBe('/blog/_kay/action/routes/index.kay/greet')
  expect(actionStub('/_kay/action/a/b').url).toBe('/_kay/action/a/b')
})
