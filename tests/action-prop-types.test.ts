import type { Action, Failure, FailureOf, SuccessOf } from '../src/runtime/action'
import { describe, expect, it } from 'bun:test'
import { t } from 'elysia'
import { action } from '../src/runtime/action'

const summarise = action(t.Object({ dossier: t.String() }), async function* (input, ctx) {
  if (input.dossier === 'none')
    return ctx.fail(404)

  yield 'text'

  return undefined
})

const claim = action(t.Object({ id: t.String() }), (input, ctx) => (input.id ? 'ok' : ctx.fail(409, { reason: 'taken' })))

describe('an action prop typed with the success output', () => {
  it('takes an action whose handler can ctx.fail', () => {
    const prop: Action<{ dossier: string }, AsyncGenerator<string>> = summarise

    expect(prop).toBe(summarise)
  })

  it('takes an action whose handler fails with data, typed or not', () => {
    const plain: Action<{ id: string }, string> = claim
    const typed: Action<{ id: string }, string | Failure<{ reason: string }>> = claim

    expect([plain, typed]).toHaveLength(2)
  })

  it('still refuses another success output or input', () => {
    // @ts-expect-error the handler answers text, not a number
    const output: Action<{ id: string }, number> = claim
    // @ts-expect-error the handler takes an id
    const input: Action<{ name: string }, string> = claim

    expect([output, input]).toHaveLength(2)
  })

  it('keeps the failure data a page reads through ctx.failed', () => {
    const failure: FailureOf<typeof claim> = { status: 409, values: {}, errors: {}, data: { reason: 'taken' } }
    const success: SuccessOf<typeof claim> = { data: 'ok' }

    // @ts-expect-error the data is the reason ctx.fail gave
    const wrong: FailureOf<typeof claim> = { status: 409, values: {}, errors: {}, data: { reason: 1 } }

    expect([failure, success, wrong]).toHaveLength(3)
  })
})
