import type { KayExtension } from 'kay/server'
import type { Mailer } from '../src'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { enqueue, mail, mailer, outbox, registeredMailer, send } from '../src'

const message = (subject: string) => ({ to: 'ada@example.com', subject, text: 'Hello' })

// Starts a site the way kay does: the extension's server is built, and the site listens.
async function start(extension: KayExtension<Mailer>): Promise<{ mailer: Mailer, stop: () => Promise<void> }> {
  const built = await (extension.server as () => Promise<Mailer>)()

  built.listen(0)

  return { mailer: built, stop: async () => void await built.stop() }
}

const stops: (() => Promise<void>)[] = []

async function running(extension: KayExtension<Mailer>): Promise<Mailer> {
  const site = await start(extension)

  stops.push(site.stop)

  return site.mailer
}

beforeEach(() => outbox.clear())

afterEach(async () => {
  for (const stop of stops.splice(0))
    await stop()
})

describe('mail() with no module', () => {
  it('builds the mailer from its own options as the site starts', async () => {
    const extension = mail({ from: 'Site <site@site.test>', locale: 'fr' })

    expect(extension.serverModule).toBeUndefined()
    await running(extension)
    await send(message('Hi'))
    expect(outbox.last()?.from).toBe('Site <site@site.test>')
  })

  it('takes no options at all', async () => {
    await running(mail())
    await send(message('Bare'))
    expect(outbox.last()?.subject).toBe('Bare')
  })

  it('has enqueue queue the mail on the running mailer', async () => {
    const own = await running(mail({ from: 'site@site.test', queue: { name: 'registered' } }))

    expect(await registeredMailer()).toBe(own)
    expect(await enqueue(message('Queued'))).toBeString()
    await own.drain()
    expect(outbox.mails.map(sent => sent.subject)).toEqual(['Queued'])
  })

  it('registers nothing at config evaluation, and nothing once the site stopped', async () => {
    const extension = mail({ from: 'later@site.test' })

    expect(await registeredMailer()).toBeUndefined()
    await expect(send(message('Nowhere'))).rejects.toThrow('no mailer is registered')

    const site = await start(extension)

    expect(await registeredMailer()).toBe(site.mailer)
    await site.stop()
    expect(await registeredMailer()).toBeUndefined()
  })

  it('keeps two sites of one process apart: each builds its own, the latest started sends, and stopping one leaves the other', async () => {
    const first = mail({ from: 'first@site.test', queue: { name: 'first' } })
    const second = mail({ from: 'second@site.test', queue: { name: 'second' } })
    const a = await start(first)
    const b = await start(second)

    expect(a.mailer).not.toBe(b.mailer)
    await send(message('Latest'))
    expect(outbox.last()?.from).toBe('second@site.test')

    await b.stop()
    await send(message('Back to the first'))
    expect(outbox.last()?.from).toBe('first@site.test')
    await a.stop()
  })

  it('builds a new mailer at each start of the same extension', async () => {
    const extension = mail({ from: 'again@site.test' })
    const one = await start(extension)
    const two = await start(extension)

    expect(one.mailer).not.toBe(two.mailer)
    await two.stop()
    expect(await registeredMailer()).toBe(one.mailer)
    await one.stop()
  })

  it('registers the mailer of a module when kay loads it', async () => {
    const own = mailer({ from: 'own@site.test' })
    const extension = mail({ module: './src/mail' })

    await extension.serverModule!.prepare!(own)
    own.listen(0)
    stops.push(async () => void await own.stop())
    await send(message('From the module'))
    expect(outbox.last()?.from).toBe('own@site.test')
  })

  it('registers a mailer a server function loads', async () => {
    const own = mailer({ from: 'loaded@site.test' })

    await running(mail({ server: async () => Promise.resolve(own) }))
    await send(message('One'))
    expect(outbox.last()?.from).toBe('loaded@site.test')
  })

  it('refuses mailer options next to a module or a server, but not undefined ones', () => {
    expect(() => mail({ module: './src/mail', from: 'a@b.test' })).toThrow('not both')
    expect(() => mail({ module: './src/mail', server: async () => mailer() })).toThrow('not both')
    expect(() => mail({ module: './src/mail', from: undefined })).not.toThrow()
  })
})

describe('mail() on real test sites', () => {
  it('gives each site of one process its own mailer, send reaching the latest started (a closed test site runs no onStop yet, kaynooo/kayjs#3053)', async () => {
    const root = join(import.meta.dir, 'fixture')
    const first = await testSite({ root, extensions: [mail({ from: 'first@site.test', queue: { name: 'site-first' } })], islands: false })
    const second = await testSite({ root, extensions: [mail({ from: 'second@site.test', queue: { name: 'site-second' } })], islands: false })

    try {
      await send(message('Latest'))
      expect(outbox.last()?.from).toBe('second@site.test')
      expect(await registeredMailer()).not.toBeUndefined()
    }
    finally {
      await second.close()
      await first.close()
    }
  }, 180_000)
})
