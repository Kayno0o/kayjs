import { describe, expect, it } from 'bun:test'
import { log } from '../src/log'

const SINK = Symbol.for('kay.log')

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
})
