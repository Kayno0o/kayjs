import { afterEach, describe, expect, it } from 'bun:test'
import { AiError, ask, fakeAi } from '../src'

afterEach(() => fakeAi.clear())

async function pieces(text: AsyncIterable<string>): Promise<string[]> {
  const seen: string[] = []

  for await (const piece of text)
    seen.push(piece)

  return seen
}

describe('the fake', () => {
  it('answers each ask with the next script and keeps what was asked', async () => {
    fakeAi.reply('First')
    fakeAi.reply(['Se', 'cond'])
    fakeAi.reply(asked => `You asked ${asked.messages.length} and ${asked.system}`)

    expect(await ask('a')).toBe('First')
    expect(await pieces(ask('b').deltas())).toEqual(['Se', 'cond'])
    expect(await ask([{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }, { role: 'user', content: 'z' }], { system: 'be nice' })).toBe('You asked 3 and be nice')
    expect(fakeAi.asked.map(asked => asked.messages.at(-1)!.content)).toEqual(['a', 'b', 'z'])
    expect(fakeAi.last()).toMatchObject({ system: 'be nice', model: 'fake', maxTokens: 4096 })
  })

  it('answers an unscripted ask with the last user message, word by word', async () => {
    expect(await pieces(ask('one two three').deltas())).toEqual(['Fake ', 'reply ', 'to: ', 'one ', 'two ', 'three'])
  })

  it('fails the next ask with the error it was given', async () => {
    fakeAi.fail(new AiError('rate-limited', 'slow down', { status: 429, retryAfter: 3 }))

    await expect(Promise.resolve(ask('a'))).rejects.toMatchObject({ kind: 'rate-limited', retryAfter: 3 })
    expect(await ask('b')).toBe('Fake reply to: b')
  })

  it('forgets everything on clear()', async () => {
    fakeAi.reply('never')
    await ask('a')
    fakeAi.clear()
    expect(fakeAi.asked).toEqual([])
    expect(await ask('b')).toBe('Fake reply to: b')
  })

  it('takes the model asked for, over the fake\'s own', async () => {
    await ask('a', { model: 'big' })
    expect(fakeAi.last()!.model).toBe('big')
  })
})
