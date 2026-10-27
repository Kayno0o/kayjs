import type { Action } from 'kay'
import { join } from 'node:path'
import { afterAll, afterEach, expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { fakeAi } from '../src'
import { filesOf, posted, shrunk } from '../src/chat-history'

const site = await testSite({ root: join(import.meta.dir, 'fixture') })
const { reply } = await import(join(import.meta.dir, 'fixture/src/routes/attaching.kay')) as { reply: Action<{ messages: { role: 'user' | 'assistant', content: string, attachments?: File[] }[] }, string[]> }

afterAll(async () => site.close())
afterEach(() => fakeAi.clear())

const PNG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
const photo = (name: string) => new File([PNG], name, { type: 'image/png' })

it('hands the model the files posted with the messages of a chat, only those of the latest turns', async () => {
  const messages = [{ role: 'user' as const, content: 'What is this?', attachments: [photo('a.png')] }, { role: 'assistant' as const, content: 'A cat' }, { role: 'user' as const, content: 'And this?', attachments: [photo('b.png'), photo('c.png')] }]

  await site.call(reply, { messages })

  expect(fakeAi.last()!.messages.map(message => message.attachments?.map(media => media.name))).toEqual([['a.png'], undefined, ['b.png', 'c.png']])
})

it('refuses a file whose bytes are no image, whatever its declared type', async () => {
  const refused = await site.refusal(reply, { messages: [{ role: 'user', content: 'x', attachments: [new File(['not a png'], 'a.png', { type: 'image/png' })] }] })

  expect(refused.status).toBe(415)
  expect(fakeAi.asked).toHaveLength(0)
})

it('posts the files of a turn with the history, counting each as an image against the cap', () => {
  const sent = [photo('a.png')]
  const turns = [{ role: 'user' as const, content: 'one', attachments: sent }, { role: 'assistant' as const, content: 'two' }, { role: 'user' as const, content: '', attachments: [photo('b.png')] }]

  expect(posted(turns, 20)).toEqual([{ role: 'user', content: 'one', attachments: sent }, { role: 'assistant', content: 'two' }, { role: 'user', content: '', attachments: [turns[2]!.attachments![0]!] }])
  // A message of files alone is a message; the oldest leave first when files push past the cap.
  expect(posted(turns, 20, 5000).map(turn => turn.content)).toEqual([''])
  expect(shrunk(posted(turns, 20))).toBe(4003)
})

it('keeps only the files this page holds, not what a stored turn or a hostile list carries', () => {
  expect(filesOf({ attachments: [photo('a.png'), new Blob(['x']), PNG] })).toHaveLength(1)
  expect(filesOf({})).toEqual([])
})
