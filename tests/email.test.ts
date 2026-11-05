import { Value } from '@sinclair/typebox/value'
import { describe, expect, it } from 'bun:test'
import { s } from '../src/runtime'
import { isEmail } from '../src/runtime/email'
import { normalizeAddress } from '../src/server/library'

const GOOD = ['ada@example.com', 'Ada@Example.COM', 'ada+news@example.com', 'first.last@sub.example.co.uk', 'ada@bücher.example', 'é@example.com', 'a@b.io', `${'a'.repeat(64)}@example.com`, 'o\'brien@example.com']
const BAD = ['', 'ada', 'ada@', '@example.com', 'ada@example', 'ada@192.168.0.1', 'ada@example.com.', 'ada@example..com', '"ada smith"@example.com', 'ada smith@example.com', 'a@b@example.com', 'a,b@example.com', 'Ada <ada@example.com>', '.ada@example.com', 'ada.@example.com', 'ada@-example.com', 'ada@example.com\nBcc: x@y.test', 'ada@example.com\r\nBcc: x@y.test', 'ada\r\n@example.com', `${'a'.repeat(65)}@example.com`, `ada@${'a'.repeat(250)}.com`, `${'a'.repeat(60)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.com`]

describe('isEmail', () => {
  it('accepts an address a mailer can deliver to, in any case and script', () => {
    for (const address of GOOD)
      expect(isEmail(address)).toBe(true)
  })

  it('refuses what is not one plain address: IPs, quoted parts, trailing dots, lists, names, header injection, over 254 characters', () => {
    for (const address of BAD)
      expect(isEmail(address)).toBe(false)

    expect(isEmail(42)).toBe(false)
    expect(isEmail(undefined)).toBe(false)
  })

  it('refuses whitespace around the address instead of trimming it', () => {
    expect(isEmail(' ada@example.com')).toBe(false)
    expect(isEmail('ada@example.com ')).toBe(false)
    expect(normalizeAddress(' ada@example.com ')).toBe('ada@example.com')
  })

  it('agrees with normalizeAddress on every case', () => {
    for (const address of [...GOOD, ...BAD])
      expect(isEmail(address)).toBe(address === address.trim() && normalizeAddress(address) !== undefined)
  })
})

describe('the email format', () => {
  const schema = s.String({ format: 'email' })

  it('is checked by the same function on the server', () => {
    for (const address of GOOD)
      expect(Value.Check(schema, address)).toBe(true)

    for (const address of BAD)
      expect(Value.Check(schema, address)).toBe(false)
  })
})
