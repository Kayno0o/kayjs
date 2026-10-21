import type { Action } from 'kay'
import { join } from 'node:path'
import { afterAll, afterEach, expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { fakeAi } from '../src'

const site = await testSite({ root: join(import.meta.dir, 'fixture') })
const { loaded, guarded } = await import(join(import.meta.dir, 'fixture/src/routes/cases.kay')) as { loaded: Action<{ messages: { role: 'user', content: string }[] }, string[]>, guarded: Action<{ messages: { role: 'user', content: string }[] }, string[]> }

afterAll(async () => site.close())
afterEach(() => fakeAi.clear())

it('streams an async action that awaits first and returns ask().stream() as a plain arrow streams', async () => {
  fakeAi.reply('one two three')

  const messages = [{ role: 'user' as const, content: 'go' }]
  const plain = await site.call(guarded, { messages })

  fakeAi.reply('one two three')

  const awaited = await site.call(loaded, { messages })

  expect(plain.length).toBeGreaterThan(1)
  expect(awaited).toEqual(plain)
})
