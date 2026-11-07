import { describe, expect, test } from 'bun:test'
import { authFailure, failed, rejected } from '../src/failure'
import { testApp } from './helpers/app'

describe('an auth failure', () => {
  test('is the ErrorShape every result carries, with the kind as code', async () => {
    const { browser } = testApp({ signUp: false })
    const result = await browser().call('password.register', { email: 'ada@example.com', password: 'correct horse battery' })

    expect(result).toEqual({ ok: false, error: { code: 'off', status: 404, message: 'Off', errors: {}, data: undefined } })
  })

  test('gives a kind a status and a sentence', () => {
    expect(failed('limited').error).toMatchObject({ code: 'limited', status: 429, message: 'Limited' })
    expect(failed('signed-out').error).toMatchObject({ status: 401 })
    expect(failed('forbidden').error).toMatchObject({ status: 403 })
    expect(failed('last-owner').error).toMatchObject({ status: 409, message: 'Last owner' })
    expect(authFailure('something-new').status).toBe(400)
  })

  test('puts the fields a call refused on errors and on error.errors, with the first as the message', () => {
    expect(rejected({ email: 'taken', password: undefined, username: { message: 'Too long' } })).toEqual({
      ok: false,
      error: { code: 'invalid', status: 422, message: 'Email taken', errors: { email: 'taken', username: 'Too long' }, data: undefined },
      errors: { email: 'taken', password: undefined, username: { message: 'Too long' } },
    })
  })

  test('a registration refused for its fields carries both', async () => {
    const { browser } = testApp()
    const result = await browser().call('password.register', { email: 'not-an-address', password: 'correct horse battery' })

    expect(result).toMatchObject({ ok: false, error: { code: 'invalid' }, errors: { email: 'invalid' } })
    expect(result).toMatchObject({ error: { status: 422, errors: { email: 'invalid' } } })
  })
})
