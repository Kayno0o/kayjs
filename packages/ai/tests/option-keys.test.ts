import { describe, expect, it } from 'bun:test'
import { ai } from '../src/extension'

describe('ai() options', () => {
  it('refuses an option it does not take, naming the nearest one', () => {
    expect(() => ai({ budgt: 1 } as never)).toThrow('`budgt`, did you mean `budget`?')
  })
})
