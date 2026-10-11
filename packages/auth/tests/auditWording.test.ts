import { describe, expect, test } from 'bun:test'
import { describeAuditEntry } from '../src/auditWording'

describe('describeAuditEntry', () => {
  test('words an entry with its detail, in English by default', () => {
    expect(describeAuditEntry({ event: 'role-granted', detail: 'editor' })).toBe('Role editor granted')
    expect(describeAuditEntry({ event: 'signed-in', detail: 'oauth:discord' })).toBe('Signed in with discord')
    expect(describeAuditEntry({ event: 'signed-in', detail: 'magic-link' })).toBe('Signed in with a mailed link')
    expect(describeAuditEntry({ event: 'member-joined', detail: 'org1 admin member' })).toBe('Joined an organization as admin, member')
    expect(describeAuditEntry({ event: 'banned', detail: null })).toBe('Suspended')
  })

  test('words it in the language of the locale when kayjs-auth ships it, English otherwise', () => {
    expect(describeAuditEntry({ event: 'provider-linked', detail: 'Discord' }, { locale: 'fr-FR' })).toBe('Compte Discord associé')
    expect(describeAuditEntry({ event: 'password-changed', detail: null }, { locale: 'de' })).toBe('Password changed')
  })

  test('takes the app\'s wording over its own, a string or a function of the detail', () => {
    const wording = { 'signed-out': 'Logged out', 'role-granted': (detail: string | null) => `Now ${detail}` }

    expect(describeAuditEntry({ event: 'signed-out', detail: null }, { wording })).toBe('Logged out')
    expect(describeAuditEntry({ event: 'role-granted', detail: 'editor' }, { locale: 'fr', wording })).toBe('Now editor')
  })

  test('reads a sign-out everywhere logged before it was its own event', () => {
    expect(describeAuditEntry({ event: 'signed-out', detail: 'everywhere-else' })).toBe(describeAuditEntry({ event: 'signed-out-everywhere', detail: 'this-one-kept' }))
  })
})
