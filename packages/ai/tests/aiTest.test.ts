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

  describe('a script for one ask', () => {
    async function pass(system: string) {
      return ask('x', { system })
    }

    it('answers the ask it accepts, whatever was read before it, and leaves the rest in order', async () => {
      model.reply('last', asked => asked.system === 'pronunciation')
      model.reply('first')

      expect(await pass('grouping')).toBe('first')
      expect(await pass('script')).toBe('Fake reply to: x')
      expect(await pass('pronunciation')).toBe('last')
      expect(model.asked).toHaveLength(3)
    })

    it('stays unused by an ask it does not accept, and is used once', async () => {
      model.reply('only', asked => asked.system === 'b')

      expect(await pass('a')).toBe('Fake reply to: x')
      expect(await pass('b')).toBe('only')
      expect(await pass('b')).toBe('Fake reply to: x')
    })

    it('fails the ask it accepts alone', async () => {
      model.fail(new Error('down'), asked => asked.system === 'b')

      expect(await pass('a')).toBe('Fake reply to: x')
      await expect(pass('b')).rejects.toThrow('down')
    })

    it('is dropped by clear', async () => {
      model.reply('late')
      model.reply('later', () => true)
      model.clear()

      expect(await pass('a')).toBe('Fake reply to: x')
    })
  })
})
