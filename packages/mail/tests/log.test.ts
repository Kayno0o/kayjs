import { describe, expect, it } from 'bun:test'
import { log } from '../src/log'
import { mailer, wasLogged } from '../src/mailer'

const SINK = Symbol.for('kay.log')

// A transport rejecting with a text is what the test needs, which the lint rightly forbids.
async function refuse(): Promise<never> {
  // eslint-disable-next-line no-throw-literal
  throw 'refused'
}

describe('the log', () => {
  it('reaches the app\'s log setting through kay, from kayjs-mail, with the error as thrown', () => {
    const calls: unknown[][] = []
    const global = globalThis as { [SINK]?: unknown }
    const sink = global[SINK]
    const thrown = new Error('550 mailbox unavailable')

    global[SINK] = (...args: unknown[]) => calls.push(args)

    try {
      log.error('"Hi" was not sent', thrown)
    }
    finally {
      global[SINK] = sink
    }

    expect(calls).toEqual([['error', '"Hi" was not sent', thrown, undefined, 'kayjs-mail']])
  })

  it('throws a primitive a transport rejects with wrapped, so the caller sees it was logged', async () => {
    const mail = mailer({ from: 'dev@example.com', transport: { send: refuse } })
    const global = globalThis as { [SINK]?: unknown }
    const sink = global[SINK]

    global[SINK] = () => undefined

    try {
      let thrown: unknown

      try {
        await mail.send({ to: 'ada@example.com', subject: 'Hi', text: 'Hello' })
      }
      catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).cause).toBe('refused')
      expect(wasLogged(thrown)).toBe(true)
    }
    finally {
      global[SINK] = sink
    }
  })
})
