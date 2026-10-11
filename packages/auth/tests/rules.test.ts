import { describe, expect, test } from 'bun:test'
import { emailProblem, normalizeEmail, normalizeUsername, passwordProblem, usernameProblem } from '../src/rules'

describe('rules', () => {
  test('emails are folded to one form and checked loosely', () => {
    expect(normalizeEmail(' Ａda@Example.COM ')).toBe('ada@example.com')
    expect(emailProblem('ada@example.com')).toBeUndefined()
    expect(emailProblem('ada@localhost')).toBe('invalid')
    expect(emailProblem('ада@example.com')).toBeUndefined()
    expect(emailProblem('аlice@example.com')).toBe('invalid')
  })

  test('passwords are 10 to 128 characters', () => {
    expect(passwordProblem('x'.repeat(9))).toBe('too-short')
    expect(passwordProblem('x'.repeat(10))).toBeUndefined()
    expect(passwordProblem('x'.repeat(129))).toBe('too-long')
  })

  test('usernames are letters and digits in any one script, punctuated inside only', () => {
    expect(normalizeUsername('  Ada   Lovelace ')).toBe('Ada Lovelace')
    expect(usernameProblem('Ada Lovelace')).toBeUndefined()
    expect(usernameProblem('Ада')).toBeUndefined()
    expect(usernameProblem('a')).toBe('length')
    expect(usernameProblem('-ada')).toBe('characters')
    expect(usernameProblem('аlice')).toBe('mixed-scripts')
  })
})
