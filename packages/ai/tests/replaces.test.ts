import type { Action } from 'kay'
import { join } from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { replacesOf } from '../src/resume'

const site = await testSite({ root: join(import.meta.dir, 'fixture') })
const { reply } = await import(join(import.meta.dir, 'fixture/src/routes/replacing.kay')) as { reply: Action<{ messages: { role: 'user' | 'assistant', content: string }[] }, AsyncIterable<string>> }

afterAll(async () => site.close())

async function asked(header?: string) {
  const stream = await site.call(reply, { messages: [{ role: 'user', content: 'hi' }] }, header === undefined ? {} : { headers: { 'x-kai-replaces': header } })
  let text = ''

  for await (const piece of stream)
    text += piece

  return text.slice(0, text.indexOf(' '))
}

it('tells an action a regenerate or an edit from a fresh send, and how many turns it replaces', async () => {
  expect(await asked()).toBe('fresh')
  expect(await asked('regenerate:2')).toBe('regenerate:2')
  expect(await asked('edit:7')).toBe('edit:7')
})

it('takes a header that is no count of turns for a fresh send', () => {
  for (const header of ['', 'edit', 'edit:0', 'edit:-1', 'edit:1.5', 'edit:1000000', 'delete:2', 'edit:2,edit:3', 'regenerate:0x2'])
    expect(replacesOf(new Request('http://localhost/', { headers: { 'x-kai-replaces': header } }))).toBeUndefined()

  expect(replacesOf(undefined)).toBeUndefined()
  expect(replacesOf(new Request('http://localhost/'))).toBeUndefined()
})
