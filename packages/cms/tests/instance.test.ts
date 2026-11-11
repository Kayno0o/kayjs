import { expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { shutdown } from 'kay/server'
import instanceApi from '../src/api/instance'

test('the instance stream sends the same id to every editor, stays open, and ends when the server stops', async () => {
  const app = new Elysia({ prefix: '/_kay/cms/instance' }).use(instanceApi).listen({ port: 0, hostname: '127.0.0.1' })
  const url = `http://127.0.0.1:${app.server!.port}/_kay/cms/instance`
  const decoder = new TextDecoder()
  const first = (await fetch(url)).body!.getReader()
  const second = (await fetch(url)).body!.getReader()
  const [one, other] = [decoder.decode((await first.read()).value), decoder.decode((await second.read()).value)]

  expect(one).toMatch(/^data: \["[0-9a-f-]{36}"\]\n\n$/)
  expect(other).toBe(one)

  const stopping = shutdown(app)

  expect((await first.read()).done).toBe(true)
  expect((await second.read()).done).toBe(true)
  await stopping
})
