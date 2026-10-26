import type { Static } from '../src/runtime'
import type { Action, Failure, FailureData, FailureOf, InputOf, SuccessOf } from '../src/runtime/action'
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

const choice = t.Union([t.Literal('smash'), t.Literal('pass')])
const verdict = action(t.Object({ choice }), input => input.choice)

describe('the types a schema gives an island', () => {
  it('reads a value shape off the schema, and an action\'s input off the action', () => {
    const value: Static<typeof choice> = 'smash'
    const input: InputOf<typeof verdict> = { choice: 'pass' }

    // @ts-expect-error only the schema's literals
    const wrong: Static<typeof choice> = 'maybe'
    // @ts-expect-error the input holds the schema's field
    const missing: InputOf<typeof verdict> = {}

    expect([value, input, wrong, missing, verdict]).toHaveLength(5)
  })
})

const upload = action(t.Object({ audio: t.File(), extra: t.Optional(t.Array(t.File())), note: t.Optional(t.File()), nested: t.Object({ clip: t.File(), when: t.Date() }), count: t.Number() }), input => input.audio.name)

describe('the input of an action reading files', () => {
  it('takes a Blob where the handler reads a File', () => {
    const blob: InputOf<typeof upload> = { audio: new Blob(['x']), extra: [new File(['y'], 'y.txt')], note: new Blob(['n']), nested: { clip: new Blob(['c']), when: new Date() }, count: 1 }
    // @ts-expect-error a Blob is no number, no date
    const other: InputOf<typeof upload> = { audio: new Blob(['x']), nested: { clip: new Blob(['c']), when: new Blob(['d']) }, count: new Blob(['1']) }

    // @ts-expect-error a string is no file
    const wrong: InputOf<typeof upload> = { audio: 'x' }

    expect([blob, other, wrong, upload]).toHaveLength(4)
  })
})

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

  it('keeps the failure data a page reads from the action outcome', () => {
    const failure: FailureOf<typeof claim> = { status: 409, values: {}, errors: {}, data: { reason: 'taken' } }
    const success: SuccessOf<typeof claim> = { data: 'ok' }

    // @ts-expect-error the data is the reason ctx.fail gave
    const wrong: FailureOf<typeof claim> = { status: 409, values: {}, errors: {}, data: { reason: 1 } }

    expect([failure, success, wrong]).toHaveLength(3)
  })

  it('leaves the failure data of an action that cannot fail unknown', () => {
    const plain = action(t.Object({ id: t.String() }), input => input.id)
    const data: FailureData<string> = undefined
    // @ts-expect-error an action that never fails does not stand for one failing with a reason
    const typed: Action<{ id: string }, string | Failure<{ reason: string }>> = plain

    expect([data, typed]).toHaveLength(2)
  })
})

describe('an action\'s serverError message', () => {
  it('is typed the error and the context when given as a function, sync or async', () => {
    const words = action(t.Object({}), () => 'ok', {
      messages: {
        serverError: async (error, ctx) => `${ctx.locale}: ${error instanceof Error ? error.message : 'unknown'}`,
      },
    })
    const plain = action(t.Object({}), () => 'ok', { messages: { serverError: () => 'Try again later' } })
    // @ts-expect-error the message is a text
    const number = action(t.Object({}), () => 'ok', { messages: { serverError: () => 1 } })
    // @ts-expect-error the error is not a string
    const unknown = action(t.Object({}), () => 'ok', { messages: { serverError: (error: string) => error } })

    expect([words, plain, number, unknown]).toHaveLength(4)
  })
})
