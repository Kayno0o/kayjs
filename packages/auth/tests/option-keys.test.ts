import { describe, expect, it } from 'bun:test'
import { auth } from '../src/pages'

describe('auth() options', () => {
  it('refuses an option it does not take, naming the nearest one', () => {
    expect(() => auth({ prefx: '/x' } as never)).toThrow('`prefx`, did you mean `prefix`?')
  })
})
