import type { Message } from '../src/types'
import { expect, test } from 'bun:test'
import { posted } from '../src/chat-history'

const user = (content: string): Message => ({ role: 'user', content })
const assistant = (content: string): Message => ({ role: 'assistant', content })
const roles = (turns: Message[]) => turns.map(({ role, content }) => `${role[0]}:${content}`)

test('the history posted never starts on an assistant message, whatever keep is', () => {
  const turns = [assistant('hi'), user('a'), assistant('b'), user('c'), assistant('d'), user('e')]

  for (const keep of [1, 2, 3, 4, 5, 6, 7, 20]) {
    const sent = posted(turns, keep)

    expect(sent[0]?.role).toBe('user')
    expect(sent.at(-1)?.content).toBe('e')
    expect(sent.length).toBeLessThanOrEqual(keep)
  }

  expect(roles(posted(turns, 2))).toEqual(['u:e'])
  expect(roles(posted(turns, 3))).toEqual(['u:c', 'a:d', 'u:e'])
  expect(roles(posted(turns, 4))).toEqual(['u:c', 'a:d', 'u:e'])
  expect(roles(posted(turns, 6))).toEqual(['u:a', 'a:b', 'u:c', 'a:d', 'u:e'])
})

test('an assistant greeting in initial is not posted, and keep larger than the history posts it all from the first user message', () => {
  expect(roles(posted([assistant('Welcome'), user('q')], 20))).toEqual(['u:q'])
  expect(roles(posted([user('q')], 20))).toEqual(['u:q'])
})

test('a turn without text is left out before the count, so keep counts messages a provider takes', () => {
  expect(roles(posted([user('a'), assistant(''), user('b'), assistant('c'), user('d')], 3))).toEqual(['u:b', 'a:c', 'u:d'])
})

test('a keep below one still posts the last message', () => {
  expect(roles(posted([user('a'), assistant('b'), user('c')], 0))).toEqual(['u:c'])
  expect(roles(posted([user('a'), assistant('b'), user('c')], -3))).toEqual(['u:c'])
})

test('a history with no user message posts nothing', () => {
  expect(posted([assistant('a')], 5)).toEqual([])
})

test('the messages posted are copies carrying only a role and a content', () => {
  const turn = { role: 'user' as const, content: 'q', id: 4, stopped: true }

  expect(Object.keys(posted([turn], 5)[0]!)).toEqual(['role', 'content'])
})
