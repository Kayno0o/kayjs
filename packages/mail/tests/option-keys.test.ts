import { describe, expect, it } from 'bun:test'
import { mail } from '../src/mailer'

describe('mail() options', () => {
  it('refuses an option it does not take, naming the nearest one', () => {
    expect(() => mail({ fromName: 'a', trasport: 'x' } as never)).toThrow('`trasport`, did you mean `transport`?')
  })
})
