import type { Log } from '../src/log'
import { describe, expect, it, spyOn } from 'bun:test'
import * as kay from 'kay'
import { libraryLog, log } from '../src/log'

const SINK = Symbol.for('kay.log')
const hasLogFrom = typeof Reflect.get(kay, 'logFrom') === 'function'

describe('the log', () => {
  it('goes through kay\'s logFrom when kay has one, named kayjs-mail, handed what was thrown', () => {
    const calls: unknown[][] = []
    const logFrom = (from: string): Log => ({
      info: (...args) => calls.push([from, 'info', ...args]),
      warn: (...args) => calls.push([from, 'warn', ...args]),
      error: (...args) => calls.push([from, 'error', ...args]),
    })
    const thrown = new Error('550 mailbox unavailable')

    libraryLog(logFrom).info('"Hi" sent')
    libraryLog(logFrom).error('"Hi" was not sent', thrown)

    expect(calls).toEqual([['kayjs-mail', 'info', '"Hi" sent'], ['kayjs-mail', 'error', '"Hi" was not sent', thrown]])
  })

  it('writes to the console with a kay that has no logFrom, saying what was thrown after the message', () => {
    const info = spyOn(console, 'info').mockImplementation(() => undefined)
    const error = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      libraryLog(undefined).info('"Hi" sent')
      libraryLog(undefined).error('"Hi" was not sent', new Error('550 mailbox unavailable'))

      expect(info).toHaveBeenCalledWith('kayjs-mail: "Hi" sent')
      expect(error).toHaveBeenCalledWith('kayjs-mail: "Hi" was not sent: 550 mailbox unavailable')
    }
    finally {
      info.mockRestore()
      error.mockRestore()
    }
  })

  it.if(hasLogFrom)('reaches the app\'s log setting through the kay installed, from kayjs-mail, with the error as thrown', () => {
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
