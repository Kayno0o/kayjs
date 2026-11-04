import { describe, expect, it } from 'bun:test'
import { cms } from '../src/extension'

describe('cms() options', () => {
  it('refuses an option it does not take, naming the nearest one', () => {
    expect(() => cms({ prefx: '/x' } as never)).toThrow('`prefx`, did you mean `prefix`?')
  })
})
