import type { Static } from 'kay'
import type { TSchema } from 'kay/library'
import { expect, test } from 'bun:test'
import { s } from 'kay'
import { checkAnswer } from 'kay/library'
import { chatMessages, lastChatMessage } from '../src'

const accepts = (schema: TSchema, value: unknown) => 'value' in checkAnswer(s.Object({ messages: schema }), { messages: value })
const png = () => new File([new Uint8Array([0x89, 0x50, 0x4E, 0x47])], 'a.png', { type: 'image/png' })

test('accepts the history Chat posts, a role and a text per message, and refuses what is out of bounds', () => {
  const schema = chatMessages()

  expect(accepts(schema, [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '' }, { role: 'user', content: 'x'.repeat(4000) }])).toBe(true)
  expect(accepts(schema, [])).toBe(false)
  expect(accepts(schema, [{ role: 'system', content: 'hi' }])).toBe(false)
  expect(accepts(schema, [{ role: 'user', content: 'x'.repeat(4001) }])).toBe(false)
  expect(accepts(schema, Array.from({ length: 41 }, () => ({ role: 'user', content: 'hi' })))).toBe(false)
})

test('takes its bounds as options', () => {
  const schema = chatMessages({ maxItems: 2, maxLength: 5 })

  expect(accepts(schema, [{ role: 'user', content: 'hello' }, { role: 'user', content: 'hello' }])).toBe(true)
  expect(accepts(schema, [{ role: 'user', content: 'hello!' }])).toBe(false)
  expect(accepts(schema, Array.from({ length: 3 }, () => ({ role: 'user', content: 'hi' })))).toBe(false)
})

test('with attachments, a message may carry files of the types asked, up to the most asked', () => {
  const files = chatMessages({ attachments: { type: 'image/png', maxFiles: 2 } })

  expect(accepts(files, [{ role: 'user', content: '', attachments: [png(), png()] }])).toBe(true)
  expect(accepts(files, [{ role: 'user', content: '', attachments: [png(), png(), png()] }])).toBe(false)
  expect(accepts(files, [{ role: 'user', content: '', attachments: [new File(['x'], 'a.txt', { type: 'text/plain' })] }])).toBe(false)
  expect(accepts(chatMessages({ attachments: true }), [{ role: 'user', content: 'see', attachments: [png()] }])).toBe(true)
})

test('lastChatMessage gives the message just sent', () => {
  expect(lastChatMessage([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }])).toEqual({ role: 'user', content: 'c' })
})

test('types the files of a message when attachments is set', () => {
  const schema = chatMessages({ attachments: true })
  const read = (messages: Static<typeof schema>) => messages[0]?.attachments

  expect(read([{ role: 'user', content: 'a' }])).toBeUndefined()
  expect(accepts(schema, [{ role: 'user', content: 'a' }])).toBe(true)
})
