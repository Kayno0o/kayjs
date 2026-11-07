import type { Provider } from '../src'
import { afterEach, describe, expect, it } from 'bun:test'
import { ai, ask, describeImage, fakeAi } from '../src'
import { configureModels } from '../src/models'
import { translateUnits } from '../src/translation'

afterEach(() => {
  fakeAi.clear()
  configureModels({})
})

describe('ai({ models })', () => {
  it('asks the model a name stands for, and a name it does not list as a model id', async () => {
    ai({ models: { fast: 'small-1', smart: 'big-1' } })

    await ask('a', { model: 'fast' })
    await ask('b', { model: 'smart' })
    await ask('c', { model: 'other-id' })

    expect(fakeAi.asked.map(asked => asked.model)).toEqual(['small-1', 'big-1', 'other-id'])
  })

  it('asks the default one when an ask names none', async () => {
    ai({ models: { fast: 'small-1' }, default: 'fast' })
    await ask('a')

    expect(fakeAi.last()?.model).toBe('small-1')
  })

  it('goes to the provider of a named model', async () => {
    const sent: string[] = []
    const mine: Provider = { name: 'mine', async* stream(request) {
      sent.push(request.model)
      yield { text: 'ok' }
    } }

    ai({ models: { local: { model: 'llama', provider: mine } } })

    expect(await ask('a', { model: 'local' })).toBe('ok')
    expect(sent).toEqual(['llama'])
  })

  it('refuses a default it does not list and an entry without a model', () => {
    expect(() => ai({ default: 'nope' })).toThrow('does not list')
    expect(() => ai({ models: { x: { model: '' } } })).toThrow('ai({ models }).x')
  })

  it('leaves the environment path alone with no models', async () => {
    ai({})
    await ask('a')

    expect(fakeAi.last()?.model).toBe('fake')
  })

  it('gives alt text and translation the model named for them', async () => {
    ai({ models: { imageAlt: 'alt-small', translate: 'tr-small' } })
    fakeAi.reply({ data: { alt: 'x' } })
    await describeImage(Uint8Array.fromBase64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='))

    expect(fakeAi.last()?.model).toBe('alt-small')

    fakeAi.reply('{"1":"Bonjour"}')
    await translateUnits([{ id: '1', text: 'Hello' }] as never, { from: 'en', into: 'fr' })

    expect(fakeAi.last()?.model).toBe('tr-small')
  })
})
