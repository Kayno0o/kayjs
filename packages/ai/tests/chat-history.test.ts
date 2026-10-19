import type { Message } from '../src/types'
import { expect, test } from 'bun:test'
import { posted, restored, shrunk, stored } from '../src/chat-history'

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

// A session storage of a map, as the tests run outside a browser.
function memoryStorage(failing = false) {
  const map = new Map<string, string>()

  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failing)
        throw new Error('full')

      map.set(key, value)
    },
    removeItem: (key: string) => map.delete(key),
  } })

  return map
}

test('a conversation kept comes back with its text and stopped marks, and turns without text are left out', () => {
  memoryStorage()
  stored('k', [{ role: 'user', content: 'a' }, { role: 'assistant', content: '', stopped: false }, { role: 'assistant', content: 'b', stopped: true }])

  expect(restored('k')).toEqual([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b', stopped: true }])
})

test('what storage holds that is not a conversation restores as none', () => {
  const map = memoryStorage()

  for (const value of ['not json', '{"a":1}', '[1,null,{"role":"system","content":"x"},{"role":"user","content":3}]']) {
    map.set('k', value)

    expect(restored('k')).toEqual([])
  }

  expect(restored('missing')).toEqual([])
})

test('the oldest turns go when the conversation outgrows the cap, and a refusing storage drops the old value', () => {
  memoryStorage()
  stored('k', [{ role: 'user', content: 'x'.repeat(150_000) }, { role: 'assistant', content: 'y'.repeat(150_000) }])
  expect(restored('k').map(turn => turn.role)).toEqual(['assistant'])

  const refusing = memoryStorage(true)

  refusing.set('old', '[{"role":"user","content":"stale"}]')
  stored('old', [{ role: 'user', content: 'new' }])
  expect(restored('old')).toEqual([])
})

test('long turns drop the oldest first so a send stays under what ask takes, keeping the last message and an opening user turn', () => {
  const long = 'x'.repeat(15_000)
  const turns = [user(long), assistant(long), user(long), assistant(long), user('last')]

  expect(roles(posted(turns, 20)).map(turn => turn.slice(0, 2))).toEqual(['u:', 'a:', 'u:'])
  expect(posted(turns, 20).reduce((sum, { content }) => sum + content.length, 0)).toBeLessThanOrEqual(40_000)
  expect(posted([user('x'.repeat(60_000))], 20)).toHaveLength(1)
})

test('maxChars trims the oldest turns to an app cap below the default, and the last message stays whatever its size', () => {
  const turns = [user('a'.repeat(300)), assistant('b'.repeat(300)), user('c'.repeat(300)), assistant('d'.repeat(300)), user('e'.repeat(300))]

  expect(posted(turns, 20, 1000).map(({ content }) => content[0])).toEqual(['c', 'd', 'e'])
  expect(posted(turns, 20, 400).map(({ content }) => content[0])).toEqual(['e'])
  expect(posted(turns, 20, 10).map(({ content }) => content[0])).toEqual(['e'])
  expect(posted(turns, 20, 39_999)).toHaveLength(5)
})

test('shrunk lowers the cap a quarter below what a refused send held, so repeated refusals reach any cap', () => {
  const sent = [user('a'.repeat(40)), assistant('b'.repeat(40)), user('c'.repeat(20))]

  expect(shrunk(sent)).toBe(75)
  expect(posted(sent, 20, shrunk(sent)).map(({ content }) => content[0])).toEqual(['c'])
  expect(shrunk([user('')])).toBe(1)
})
