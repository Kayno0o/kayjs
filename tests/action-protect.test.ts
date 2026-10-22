import { describe, expect, it } from 'bun:test'
import { t } from 'elysia'
import { action } from '../src/runtime/action'

const schema = t.Object({})

describe('an action\'s options grouped under protect', () => {
  it('reads the checks under protect as the server reads them', () => {
    const grouped = action(schema, () => 1, { tool: true, maxSize: '1mb', protect: { honeypot: 'website', minTime: '3s', rateLimit: { max: 1, window: '1m' } } })

    expect(grouped.protection).toEqual({ tool: true, maxSize: '1mb', honeypot: 'website', minTime: '3s', rateLimit: { max: 1, window: '1m' } })
  })

  it('still reads the flat form, kept until 1.74', () => {
    const flat = action(schema, () => 1, { honeypot: 'website', proofOfWork: 50 })

    expect(flat.protection).toEqual({ honeypot: 'website', proofOfWork: 50 })
  })

  it('lets protect win over a flat key, and an undefined one leave it', () => {
    const mixed = action(schema, () => 1, { honeypot: 'old', minTime: '1s', protect: { honeypot: 'new', minTime: undefined } })

    expect(mixed.protection).toEqual({ honeypot: 'new', minTime: '1s' })
  })

  it('checks the settings under protect as the action is declared', () => {
    expect(() => action(schema, () => 1, { protect: { minTime: 'soon' as never } })).toThrow()
    expect(() => action(schema, () => 1, { protect: { proofOfWork: 0 } })).toThrow('whole number')
  })
})
