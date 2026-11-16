import { describe, expect, it } from 'bun:test'
import { dispatch } from '../src/runtime/dispatch'
import { durationWords } from '../src/runtime/duration-words'
import { KayError } from '../src/runtime/kay-error'
import { route } from '../src/runtime/route'
import { sanitizeHtml } from '../src/runtime/sanitize'

function thrown(run: () => unknown): unknown {
  try {
    run()
  }
  catch (error) {
    return error
  }

  return undefined
}

describe('the helpers that also run in an island', () => {
  it('refuse what they are given with a KayError coded argument-invalid, keeping the kay: prefix', () => {
    const refusals = [
      () => durationWords(5 as never, 'en'),
      () => dispatch({ type: 'a' }, {} as never),
      () => sanitizeHtml('<p>x</p>', { tags: ['script'] }),
    ]

    for (const refusal of refusals) {
      const error = thrown(refusal)

      expect(error).toBeInstanceOf(KayError)
      expect((error as KayError).code).toBe('argument-invalid')
      expect((error as KayError).message).toStartWith('kay: ')
    }
  })

  it('refuse an empty route param', () => {
    expect(thrown(() => route('/a/:id', { id: '' }))).toMatchObject({ code: 'argument-invalid' })
  })
})
