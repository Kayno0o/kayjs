import { describe, expect, it } from 'bun:test'
import { ActionError, ApiError } from 'kay'
import { fieldsOf, messageOf } from '../src/runtime/api-error'

describe('messageOf', () => {
  it('reads the form-wide message, the field messages, data.message, the text answered, then the fallback or the status', () => {
    expect(messageOf({ status: 422, errors: { '': 'Whole', 'title': 'Short' }, data: { message: 'Data' } })).toBe('Whole')
    expect(messageOf({ status: 422, errors: { title: 'Short', body: 'Empty' }, data: { message: 'Data' } })).toBe('Short, Empty')
    expect(messageOf({ status: 409, errors: {}, data: { message: 'Data' } }, 'Fallback')).toBe('Data')
    expect(messageOf({ status: 500, errors: {}, data: 'Text' }, 'Fallback')).toBe('Text')
    expect(messageOf({ status: 503, errors: {}, data: undefined }, 'Unavailable')).toBe('Unavailable')
    expect(messageOf({ status: 503, errors: {}, data: undefined })).toBe('HTTP 503')
  })

  it('names the field a validation failure refuses, else the whole form', () => {
    expect(fieldsOf({ type: 'validation', errors: [{ path: '/title', message: 'Too short' }, { path: '', message: 'Bad' }] })).toEqual({ 'title': 'Too short', '': 'Bad' })
    expect(fieldsOf({ message: 'x' })).toEqual({})
    expect(fieldsOf('text')).toEqual({})
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
    expect(new ActionError(500, 'boom').message).toBe('Action failed with 500: boom')
  })
})
