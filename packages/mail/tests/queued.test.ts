import type { Mail } from '../src/types'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { memoryJobs } from 'kay/server'
import { scratchDir, testSite } from 'kay/test'
import { openLists } from '../src/list-store'
import { mailer } from '../src/mailer'
import { smtp } from '../src/smtp'
import { startSmtp } from './helpers/smtp'
import { untilHolds } from './until'

await testSite({ root: 'tests/fixture' })

const SINK = Symbol.for('kay.log')

afterEach(() => {
  ;(globalThis as { [SINK]?: unknown })[SINK] = undefined
})

function silenced(): void {
  ;(globalThis as { [SINK]?: unknown })[SINK] = () => undefined
}

async function refuse(): Promise<never> {
  throw new Error('550 mailbox unavailable')
}

let names = 0

// The options two mailers of one queue share.
function shared() {
  return { store: memoryJobs(), name: `shared${names++}`, attempts: 1 }
}

describe('a mail queued by one mailer and claimed by another', () => {
  it('is given up to the onFailed of the mailer that queued it', async () => {
    silenced()

    const queue = shared()
    const failed: string[] = []
    const queuing = mailer({ from: 'a@example.com', transport: { send: refuse }, queue: { ...queue, onFailed: ({ payload }) => void failed.push(`queuing:${payload.subject}`) } })
    const claiming = mailer({ from: 'b@example.com', transport: { send: refuse }, queue: { ...queue, onFailed: ({ payload }) => void failed.push(`claiming:${payload.subject}`) } })

    await queuing.enqueue({ to: 'ada@example.com', subject: 'Hi', text: 'Hello' })
    await claiming.drain()

    expect(failed).toEqual(['queuing:Hi'])
  })

  it('is kept as failed by the redact of the mailer that queued it', async () => {
    silenced()

    const queue = shared()
    const queuing = mailer({ from: 'a@example.com', transport: { send: refuse }, queue: { ...queue, redact: mail => ({ ...mail, text: 'redacted by the queuing mailer' }) } })
    const claiming = mailer({ from: 'b@example.com', transport: { send: refuse }, queue })

    await queuing.enqueue({ to: 'ada@example.com', subject: 'Hi', text: 'Hello' })
    await claiming.drain()

    expect((await queuing.failed()).map(job => job.payload.text)).toEqual(['redacted by the queuing mailer'])
  })

  it('runs a mailing list broadcast on the mailer that queued it', async () => {
    const file = join(await scratchDir('queued-'), 'list.sqlite')
    const lists = openLists(file)
    const { id: subscriber } = lists.ask('news', 'ada@example.com', 'news-ada', 'en', 1000)

    lists.confirm('news', subscriber, 2000)
    lists.close()

    const queue = shared()
    const sent: string[] = []
    const transport = (name: string) => ({
      send: async (mail: Mail) => {
        sent.push(`${name}:${mail.subject}`)

        return { messageId: name, accepted: ['ada@example.com'], rejected: [] }
      },
    })
    const queuing = mailer({ from: 'a@example.com', transport: transport('queuing'), queue })
    const claiming = mailer({ from: 'b@example.com', transport: transport('claiming'), queue })
    const { id } = await queuing.list('news', { file, pace: { batch: 2, every: '50ms' } }).send({ subject: 'News', text: 'Hello' })

    for (let round = 0; round < 20 && !(await queuing.list('news').status(id))?.done; round++) {
      await claiming.drain()
      await Bun.sleep(60)
    }

    expect(sent).toEqual(['queuing:News'])
  })
})

describe('mailers sharing a queue', () => {
  it('refuse retry and keep options that differ, as a queue has one set of them', () => {
    const queue = shared()

    mailer({ from: 'a@example.com', queue: { ...queue, keepFailed: '7d' } })

    expect(() => mailer({ from: 'b@example.com', queue: { ...queue, attempts: 3 } })).toThrow(/attempts/)
    expect(() => mailer({ from: 'b@example.com', queue: { ...queue, keepFailed: '30d' } })).toThrow(/keepFailed/)
  })

  it('skip an option one of them leaves unset', () => {
    const queue = shared()

    mailer({ from: 'a@example.com', queue })
    expect(() => mailer({ from: 'b@example.com', queue: { ...queue, keepFailed: '30d' } })).not.toThrow()
    expect(() => mailer({ from: 'c@example.com', queue })).not.toThrow()
  })

  it('compare each option with the last mailer that set it, whatever one between them left unset', () => {
    const queue = shared()
    const first = mailer({ from: 'a@example.com', queue: { ...queue, keepFailed: '7d' } })
    const middle = mailer({ from: 'b@example.com', queue })

    expect(() => mailer({ from: 'c@example.com', queue: { ...queue, keepFailed: '30d' } })).toThrow(/keepFailed/)
    expect([first, middle]).toHaveLength(2)
  })

  it('keep an earlier mailer in mind once a later one that agrees is gone', async () => {
    const queue = shared()
    const first = mailer({ from: 'a@example.com', queue: { ...queue, keepFailed: '7d' } })
    let second: unknown = mailer({ from: 'b@example.com', queue: { ...queue, keepFailed: '7d' } })

    second = undefined
    Bun.gc(true)
    // Lets the collector's finalizers run, which is when a gone mailer would be forgotten.
    await Bun.sleep(10)

    expect(() => mailer({ from: 'c@example.com', queue: { ...queue, keepFailed: '30d' } })).toThrow(/keepFailed/)
    expect(first).toBeDefined()
    expect(second).toBeUndefined()
  })

  it('without a store skip the check, as each uses the app\'s', () => {
    const name = `shared${names++}`

    mailer({ from: 'a@example.com', queue: { name, attempts: 1 } })
    expect(() => mailer({ from: 'b@example.com', queue: { name, attempts: 3 } })).not.toThrow()
  })

  it('may differ in everything a job carries along', () => {
    const queue = shared()

    mailer({ from: 'a@example.com', queue })
    expect(() => mailer({ from: 'b@example.com', queue: { ...queue, onFailed: () => undefined, redact: mail => mail } })).not.toThrow()
  })

  it('do not clash across queues or stores', () => {
    const queue = shared()

    mailer({ from: 'a@example.com', queue })
    expect(() => mailer({ from: 'b@example.com', queue: { ...queue, name: `${queue.name}-other`, attempts: 3 } })).not.toThrow()
    expect(() => mailer({ from: 'b@example.com', queue: { ...queue, store: memoryJobs(), attempts: 3 } })).not.toThrow()
  })
})

describe('a queued delivery the queue aborts', () => {
  it('hands the queue\'s signal to the transport, which stops its send', async () => {
    silenced()

    let signal: AbortSignal | undefined
    let stopped = false
    const hanging = {
      send: async (_mail: Mail, aborted?: AbortSignal) => new Promise<never>((_, reject) => {
        signal = aborted
        aborted?.addEventListener('abort', () => {
          stopped = true
          reject(new Error('aborted'))
        })
      }),
    }
    const app = mailer({ from: 'a@example.com', transport: hanging, queue: { ...shared(), lostAfter: '1s' } })

    await app.enqueue({ to: 'ada@example.com', subject: 'Hi', text: 'Hello' })
    await app.drain()

    expect(signal).toBeDefined()
    expect(stopped).toBe(true)
  })

  it('stops an SMTP send waiting for the server', async () => {
    const server = startSmtp(0, { stall: true })
    const transport = smtp({ host: '127.0.0.1', port: server.port, insecure: true })
    const mail: Mail = { from: 'a@example.com', to: ['ada@example.com'], cc: [], bcc: [], subject: 'Hi', text: 'Hello', html: undefined, headers: {}, attachments: [] }
    const controller = new AbortController()

    try {
      const settled = (async () => {
        try {
          await transport.send(mail, controller.signal)

          return 'sent'
        }
        catch (error) {
          return (error as Error).name
        }
      })()

      // The message is with the server once the end of its data is read.
      await untilHolds(() => server.received.length > 0, 2000)

      expect(server.received).toHaveLength(1)
      controller.abort()
      expect(await Promise.race([settled, new Promise<string>(resolve => setTimeout(resolve, 2000, 'still waiting'))])).toBe('AbortError')
    }
    finally {
      server.stop()
    }
  })

  it('reaches the SMTP transport built from the environment', async () => {
    silenced()

    const server = startSmtp(0, { stall: true })
    const saved = { NODE_ENV: process.env.NODE_ENV, MAIL_URL: process.env.MAIL_URL, MAIL_INSECURE: process.env.MAIL_INSECURE }

    process.env.NODE_ENV = 'production'
    Object.assign(process.env, { MAIL_URL: `smtp://127.0.0.1:${server.port}`, MAIL_INSECURE: 'true' })

    try {
      const app = mailer({ from: 'a@example.com', queue: { ...shared(), lostAfter: '3s' } })

      await app.enqueue({ to: 'ada@example.com', subject: 'Hi', text: 'Hello' })
      await app.drain()

      expect(server.received).toHaveLength(1)

      // The abort dropped the pool, so its connection closes as the server answers, well before the one second a pool left idle waits.
      server.release()

      await untilHolds(() => server.connections.closed > 0, 500)

      expect(server.connections.closed).toBe(1)
    }
    finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined)
          delete process.env[name]
        else
          process.env[name] = value
      }

      server.stop()
    }
  })

  it('sends nothing for a signal already aborted', async () => {
    const server = startSmtp()
    const transport = smtp({ host: '127.0.0.1', port: server.port, insecure: true })
    const mail = { from: 'a@example.com', to: ['ada@example.com'], cc: [], bcc: [], subject: 'Hi', text: 'Hello', headers: {}, attachments: [] } as never

    try {
      await expect(transport.send(mail, AbortSignal.abort())).rejects.toThrow()
      expect(server.connections.opened).toBe(0)
    }
    finally {
      server.stop()
    }
  })
})
