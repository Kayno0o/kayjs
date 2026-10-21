import { describe, expect, it } from 'bun:test'
import { ask } from '../src/ask'
import { aiTest } from '../src/test'

const model = aiTest()

describe('aiTest', () => {
  it('scripts the next answer and reads what was asked', async () => {
    model.reply(['It ', 'works'])

    expect(await ask('Hi')).toBe('It works')
    expect(model.last()).toMatchObject({ messages: [{ role: 'user', content: 'Hi' }], model: 'fake' })
    expect(model.asked).toHaveLength(1)
  })

  it('starts the next test with nothing asked and nothing scripted, cleared by itself', async () => {
    expect(model.asked).toHaveLength(0)

    expect(await ask('Again')).toBe('Fake reply to: Again')
  })

  it('fails the next ask with the error it is given', async () => {
    model.fail(new Error('down'))

    await expect((async () => ask('Hi'))()).rejects.toThrow('down')
  })
})
