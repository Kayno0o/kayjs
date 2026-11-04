import { describe, expect, it } from 'bun:test'
import { ActionError, ApiError } from 'kay'
import { failed, fieldsOf, messageOf, textOf, unreachable } from '../src/runtime/api-error'
import { issueMessage } from '../src/runtime/local'

describe('messageOf', () => {
  it('reads the form-wide message, the field messages, data.message, the text answered, then the fallback or the status', () => {
    expect(messageOf({ status: 422, errors: { '': 'Whole', 'title': 'Short' }, data: { message: 'Data' } })).toBe('Whole')
    expect(messageOf({ status: 422, errors: { title: 'Short', body: 'Empty' }, data: { message: 'Data' } })).toBe('Short, Empty')
    expect(messageOf({ status: 409, errors: {}, data: { message: 'Data' } }, 'Fallback')).toBe('Data')
    expect(messageOf({ status: 500, errors: {}, data: 'Text' }, 'Fallback')).toBe('Text')
    expect(messageOf({ status: 503, errors: {}, data: undefined }, 'Unavailable')).toBe('Unavailable')
    expect(messageOf({ status: 503, errors: {}, data: undefined })).toBe('HTTP 503')
  })

  it('reads the message per field a refused route answers, and nothing from any other answer', () => {
    expect(fieldsOf({ status: 422, errors: { 'title': 'Too short', '': 'Bad', 'odd': 1 } })).toEqual({ 'title': 'Too short', '': 'Bad' })
    expect(fieldsOf({ type: 'validation', errors: [{ path: '/title', message: 'Too short' }] })).toEqual({})
    expect(fieldsOf({ message: 'x' })).toEqual({})
    expect(fieldsOf('text')).toEqual({})
  })
})

describe('textOf and the failure factory', () => {
  it('reads an answer on its own: its message, the text, else the fallback', () => {
    expect(textOf({ message: 'Data' }, 'Fallback')).toBe('Data')
    expect(textOf('Text', 'Fallback')).toBe('Text')
    expect(textOf({ message: '' }, 'Fallback')).toBe('Fallback')
    expect(textOf(undefined, 'Fallback')).toBe('Fallback')
    expect(textOf(null, 'Fallback')).toBe('Fallback')
  })

  it('builds the failure a source has no answer behind, the cause kept', () => {
    const cause = new Error('socket')
    const error = failed(0, 'The connection was lost', cause)

    expect([error instanceof ApiError, error.status, error.message, error.errors, error.data, error.cause]).toEqual([true, 0, 'The connection was lost', {}, undefined, cause])
    expect(failed(403, 'Refused').status).toBe(403)
    expect(unreachable(cause).message).toBe('The server could not be reached')
    expect(unreachable(cause).cause).toBe(cause)
  })
})

describe('ApiError', () => {
  it('carries errors and data, with answer as the old name of data', () => {
    const error = new ApiError(409, 'Taken', { reason: 'locked' }, { id: 'Taken' })

    expect([error.status, error.message, error.errors, error.data, error.answer]).toEqual([409, 'Taken', { id: 'Taken' }, { reason: 'locked' }, { reason: 'locked' }])
  })

  it('is what an action throws too, its message read by the same rule', () => {
    const error = new ActionError(422, 'raw body', { title: 'Required' }, undefined)

    expect(error).toBeInstanceOf(ApiError)
    expect([error.message, error.errors, error.data]).toEqual(['Required', { title: 'Required' }, undefined])
    expect(new ActionError(500, 'boom').message).toBe('Action failed with 500')
  })
})

describe('issueMessage', () => {
  it('reads the message of a record written before issues had one, by its kind', () => {
    expect(issueMessage({ kind: 'conflict' })).toBe('The row changed on the server')
    expect(issueMessage({ kind: 'rejected', status: 422, errors: { title: 'Required' } })).toBe('Required')
    expect(issueMessage({ kind: 'rejected', status: 500 })).toBe('Action failed with 500')
    expect(issueMessage({ kind: 'rejected', status: 422, message: 'Kept' })).toBe('Kept')
  })
})
