import type { Provider } from '../src'
import { afterEach, describe, expect, it } from 'bun:test'
import { ai, AiError, ask, describeImage, embed, fakeAi } from '../src'
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

  it('keeps an explicit provider\'s own model against the default, and the entry\'s model for a named one', async () => {
    const sent: string[] = []
    const mine: Provider = { name: 'mine', model: 'own-1', async* stream(request) {
      sent.push(request.model)
      yield { text: 'ok' }
    } }

    ai({ models: { fast: 'small-1' }, default: 'fast' })
    await ask('a', { provider: mine })
    await ask('b', { provider: mine, model: 'fast' })

    expect(sent).toEqual(['own-1', 'small-1'])
  })

  it('resolves names in fallback and embed, and a call\'s own model beats the role', async () => {
    const sent: string[] = []
    const down: Provider = { name: 'down', async* stream(request) {
      sent.push(request.model)

      throw new AiError('unavailable', 'down')
    } }
    const up: Provider = { name: 'up', async* stream(request) {
      sent.push(request.model)
      yield { text: 'ok' }
    } }

    ai({ models: { backup: { model: 'backup-1', provider: up }, small: 'embed-small', imageAlt: 'alt-small' } })

    expect(await ask('a', { provider: down, model: 'x', retry: false, fallback: [{ model: 'backup' }] })).toBe('ok')
    expect(sent).toEqual(['x', 'backup-1'])

    await embed('t', { model: 'small' })

    expect(fakeAi.embedded.at(-1)?.model).toBe('embed-small')

    fakeAi.reply({ data: { alt: 'x' } })
    await describeImage(Uint8Array.fromBase64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='), { model: 'mine-1' })

    expect(fakeAi.last()?.model).toBe('mine-1')
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
