import { describe, expect, it } from 'bun:test'
import { t } from 'elysia'
import { action } from '../src/runtime/action'

const schema = t.Object({})

describe('an action\'s options grouped under protect', () => {
  it('reads the checks under protect as the server reads them', () => {
    const grouped = action(schema, () => 1, { tool: true, maxSize: '1mb', protect: { honeypot: 'website', minTime: '3s', rateLimit: { max: 1, window: '1m' } } })

    expect(grouped.protection).toEqual({ tool: true, maxSize: '1mb', honeypot: 'website', minTime: '3s', rateLimit: { max: 1, window: '1m' } })
  })

  it('no longer reads the flat form of 1.70, nor checks it', () => {
    const flat = action(schema, () => 1, { tool: true, honeypot: 'website', minTime: 'soon', proofOfWork: 0 } as never)

    expect(flat.protection).toEqual({ tool: true })
  })

  it('checks the settings under protect as the action is declared', () => {
    expect(() => action(schema, () => 1, { protect: { minTime: 'soon' as never } })).toThrow()
    expect(() => action(schema, () => 1, { protect: { proofOfWork: 0 } })).toThrow('whole number')
  })
})
