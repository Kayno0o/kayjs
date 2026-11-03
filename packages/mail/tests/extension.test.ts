import { beforeEach, describe, expect, it } from 'bun:test'
import { enqueue, mail, mailer, outbox, registeredMailer, send } from '../src'

const message = (subject: string) => ({ to: 'ada@example.com', subject, text: 'Hello' })

beforeEach(() => outbox.clear())

describe('mail() with no module', () => {
  it('builds the mailer from its own options, which the extension hands to pages()', async () => {
    const extension = mail({ from: 'Site <site@site.test>', locale: 'fr' })
    const server = extension.server as () => Promise<Awaited<ReturnType<typeof mailer>>> | ReturnType<typeof mailer>

    expect(extension.serverModule).toBeUndefined()
    expect(await server()).toBe(await server())

    await send(message('Hi'))
    expect(outbox.last()?.from).toBe('Site <site@site.test>')
  })

  it('takes no options at all', async () => {
    mail()
    await send(message('Bare'))
    expect(outbox.last()?.subject).toBe('Bare')
  })

  it('has send and enqueue resolve the registered mailer, enqueue leaving the mail to the queue', async () => {
    const registered = mail({ from: 'site@site.test', queue: { name: 'registered' } })

    expect(await registeredMailer()).toBe(await (registered.server as () => Awaited<ReturnType<typeof mailer>>)())

    await enqueue(message('Queued'))
    expect(outbox.mails).toEqual([])
    expect(await (await registeredMailer())!.drain()).toBe(1)
    expect(outbox.last()?.subject).toBe('Queued')
  })

  it('registers the mailer of a module when kay loads it', async () => {
    const own = mailer({ from: 'own@site.test' })
    const extension = mail({ module: './src/mail' })

    await extension.serverModule!.prepare!(own)
    await send(message('From the module'))
    expect(outbox.last()?.from).toBe('own@site.test')
  })

  it('registers a mailer a server function loads, once', async () => {
    let loaded = 0
    const own = mailer({ from: 'loaded@site.test' })

    mail({ server: async () => {
      loaded++

      return own
    } })
    await send(message('One'))
    await send(message('Two'))
    expect(loaded).toBe(1)
    expect(outbox.last()?.from).toBe('loaded@site.test')
  })

  it('refuses mailer options next to a module or a server, and both together', () => {
    expect(() => mail({ module: './src/mail', from: 'a@b.test' })).toThrow('not both')
    expect(() => mail({ module: './src/mail', server: async () => mailer() })).toThrow('not both')
  })
})
