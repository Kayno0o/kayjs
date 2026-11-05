import { TypeCompiler } from '@sinclair/typebox/compiler'
import { Value } from '@sinclair/typebox/value'
import { describe, expect, it } from 'bun:test'
import { s } from '../src/runtime'
import { isEmail, normalizeAddress } from '../src/runtime/email'
import { BAD_EMAILS as BAD, GOOD_EMAILS as GOOD } from './helpers/emails'

describe('isEmail', () => {
  it('accepts an address a mailer can deliver to, in any case and script', () => {
    for (const address of GOOD)
      expect(isEmail(address)).toBe(true)
  })

  it('refuses what is not one plain address: IPs, quoted parts, trailing dots, lists, names, header injection, over 254 characters, a host the URL parser would rewrite', () => {
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

  it('maps one inbox to one stored string', () => {
    expect(normalizeAddress('Ada@BÜCHER.example')).toBe('ada@xn--bcher-kva.example')
    expect(normalizeAddress('ada@bücher.example')).toBe('ada@xn--bcher-kva.example')
  })

  it('does not need URL.parse, which older browsers lack', () => {
    const parse = URL.parse.bind(URL)

    ;(URL as { parse?: unknown }).parse = undefined

    try {
      for (const address of [...GOOD, ...BAD])
        expect(isEmail(address)).toBe(GOOD.includes(address))
    }
    finally {
      URL.parse = parse
    }
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

  it('is the one the compiled validators use too', () => {
    const check = TypeCompiler.Compile(schema)

    for (const address of GOOD)
      expect(check.Check(address)).toBe(true)

    for (const address of BAD)
      expect(check.Check(address)).toBe(false)
  })
})
