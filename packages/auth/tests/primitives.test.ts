import { Buffer } from 'node:buffer'
import { createHmac, hkdfSync } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import { localPath } from 'kay'
import { describeAuditEntry } from '../src/auditWording'
import { deriveKeys, digest } from '../src/keys'
import { createPkcePair } from '../src/oauth/pkce'
import { safeRedirect } from '../src/oauth/redirect'
import { createRoleHierarchy } from '../src/roles'
import { emailProblem, normalizeEmail, normalizeUsername, passwordProblem, usernameProblem } from '../src/rules'

describe('rules', () => {
  test('emails are folded to one form and checked loosely', () => {
    expect(normalizeEmail(' Ａda@Example.COM ')).toBe('ada@example.com')
    expect(emailProblem('ada@example.com')).toBeUndefined()
    expect(emailProblem('ada@localhost')).toBe('invalid')
    expect(emailProblem('ада@example.com')).toBeUndefined()
    expect(emailProblem('аlice@example.com')).toBe('invalid')
    expect(emailProblem('ada@example.com,eve@example.com')).toBe('invalid')
    expect(emailProblem('Ada <ada@example.com>')).toBe('invalid')
    expect(emailProblem('"ada"@example.com')).toBe('invalid')
    expect(emailProblem('ada@exa>mple.com')).toBe('invalid')
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

type Role = 'ROLE_USER' | 'ROLE_ADMIN' | 'ROLE_SUPER_ADMIN'

interface User { roles: Role[] }

const hierarchy: Record<Role, Role[]> = {
  ROLE_USER: [],
  ROLE_ADMIN: ['ROLE_USER'],
  ROLE_SUPER_ADMIN: ['ROLE_ADMIN'],
}

const { isGranted, hasRole } = createRoleHierarchy<User, Role>(hierarchy, u => u.roles)

describe('createRoleHierarchy', () => {
  test('isGranted walks inherited roles', () => {
    expect(isGranted('ROLE_USER', ['ROLE_ADMIN'])).toBe(true)
    expect(isGranted('ROLE_ADMIN', ['ROLE_SUPER_ADMIN'])).toBe(true)
    expect(isGranted('ROLE_SUPER_ADMIN', ['ROLE_ADMIN'])).toBe(false)
    expect(isGranted('ROLE_ADMIN', ['ROLE_USER'])).toBe(false)
  })

  test('hasRole builds a predicate that reads the principal roles', () => {
    const requireUser = hasRole('ROLE_USER')

    expect(requireUser({ roles: ['ROLE_ADMIN'] }, {})).toBe(true)
    expect(requireUser({ roles: ['ROLE_USER'] }, {})).toBe(true)
    expect(requireUser({ roles: [] }, {})).toBe(false)
  })

  test('hasRole denies an anonymous principal', () => {
    expect(hasRole('ROLE_USER')(null, {})).toBe(false)
  })
})

describe('describeAuditEntry', () => {
  test('words an entry with its detail, in English by default', () => {
    expect(describeAuditEntry({ event: 'role-granted', detail: 'editor' })).toBe('Role editor granted')
    expect(describeAuditEntry({ event: 'signed-in', detail: 'oauth:discord' })).toBe('Signed in with discord')
    expect(describeAuditEntry({ event: 'signed-in', detail: 'magic-link' })).toBe('Signed in with a mailed link')
    expect(describeAuditEntry({ event: 'member-joined', detail: 'org1 admin member' })).toBe('Joined an organization as admin, member')
    expect(describeAuditEntry({ event: 'banned', detail: null })).toBe('Suspended')
  })

  test('says the plain phrase for an empty detail, or an organization event naming no role', () => {
    expect(describeAuditEntry({ event: 'email-changed', detail: '' })).toBe('Email changed')
    expect(describeAuditEntry({ event: 'member-joined', detail: '' })).toBe('Joined an organization')
    expect(describeAuditEntry({ event: 'member-joined', detail: 'org1' })).toBe('Joined an organization')
    expect(describeAuditEntry({ event: 'member-roles-changed', detail: '' }, { locale: 'fr' })).toBe('Rôles dans l’organisation changés')
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

describe('safeRedirect', () => {
  test('allows same-origin absolute paths', () => {
    expect(safeRedirect('/dashboard')).toBe('/dashboard')
    expect(safeRedirect('/a/b?x=1')).toBe('/a/b?x=1')
  })

  test('rejects open-redirect targets, falling back', () => {
    expect(safeRedirect('//evil.com')).toBe('/')
    expect(safeRedirect('/\\evil.com')).toBe('/')
    expect(safeRedirect('/\t//evil.com')).toBe('/')
    expect(safeRedirect('https://evil.com')).toBe('/')
    expect(safeRedirect(null)).toBe('/')
    expect(safeRedirect(undefined, '/home')).toBe('/home')
  })

  test('rejects a path that normalises to another host, and answers the others normalised', () => {
    for (const path of ['/.//evil.com', '/./\\evil.com', '/%2e//evil.com', '/a/../..//evil.com', '/%2F%2Fevil.com', '/%2fevil.com', '/./%5Cevil.com'])
      expect([path, safeRedirect(path)]).toEqual([path, '/'])

    for (const path of ['/.%2f/evil.com', '/a/..%2f/evil.com', '/%2e%2e%2f%2e%2e%2f/evil.com', '/%252F/evil.com', '/%E0%A4%A'])
      expect([path, safeRedirect(path)]).toEqual([path, '/'])

    expect(safeRedirect('/a/./b/../c?next=//x#top')).toBe('/a/c?next=//x#top')
    expect(safeRedirect('/a/%2F')).toBe('/a/%2F')
    expect(['/../x', '/a?', '/é?q=é', '/a b'].map(path => safeRedirect(path))).toEqual(['/x', '/a', '/%C3%A9?q=%C3%A9', '/a%20b'])
    expect(safeRedirect(safeRedirect('/a/./é'))).toBe(safeRedirect('/a/./é'))
  })

  test('is kay\'s localPath, which holds the cases of a value leaving the site once decoded', () => {
    for (const path of ['/%09/evil.com', '/%2F/evil.com', '/%2509/evil.com'])
      expect([path, safeRedirect(path, '/home')]).toEqual([path, localPath(path, '/home')])
  })
})

describe('pkce', () => {
  test('produces an S256 verifier/challenge pair', async () => {
    const a = await createPkcePair()
    const b = await createPkcePair()

    expect(a.method).toBe('S256')
    expect(a.verifier).not.toBe(b.verifier)
    // RFC 7636: the challenge is base64url(sha256(verifier)), unpadded.
    expect(a.challenge).toBe(new Bun.CryptoHasher('sha256').update(a.verifier).digest('base64url'))
    expect(a.verifier).toMatch(/^[\w-]{43,128}$/)
  })
})

const SECRET = 'a-test-secret-that-is-long-enough-for-kayjs-auth'
const OTHER = 'another-test-secret-that-is-long-enough-too'

describe('deriveKeys', () => {
  test('encrypted text opens with the same context only', () => {
    const keys = deriveKeys(SECRET)
    const sealed = keys.encrypt('JBSWY3DPEHPK3PXP', 'totp:u1')

    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP')
    expect(keys.decrypt(sealed, 'totp:u1')).toBe('JBSWY3DPEHPK3PXP')
    expect(keys.decrypt(sealed, 'totp:u2')).toBeUndefined()
  })

  test('a rotated list opens what an older secret wrote and writes with the first', () => {
    const old = deriveKeys(OTHER)
    const rotated = deriveKeys([SECRET, OTHER])

    expect(rotated.decrypt(old.encrypt('x', 'c'), 'c')).toBe('x')
    expect(old.decrypt(rotated.encrypt('x', 'c'), 'c')).toBeUndefined()
  })

  test('a forged or truncated value opens to nothing', () => {
    const keys = deriveKeys(SECRET)

    expect(keys.decrypt('', 'c')).toBeUndefined()
    const sealed = keys.encrypt('x', 'c')
    // The last character may carry padding bits alone, so a whole one before it is changed.
    const at = sealed.length - 3
    const forged = `${sealed.slice(0, at)}${sealed[at] === 'A' ? 'B' : 'A'}${sealed.slice(at + 1)}`

    expect(keys.decrypt(forged, 'c')).toBeUndefined()
    expect(keys.decrypt(sealed.slice(0, -2), 'c')).toBeUndefined()
  })

  test('each use has its own key, none of them the secret itself', () => {
    const hmac = (key: string | Buffer) => createHmac('sha256', key).update('1.2.3.4').digest('base64url')
    const key = (purpose: string) => Buffer.from(hkdfSync('sha256', SECRET, '', `kayjs-auth ${purpose}`, 32))
    const fingerprint = deriveKeys(SECRET).fingerprint('1.2.3.4')

    expect(fingerprint).toBe(hmac(key('fingerprint')))
    expect([hmac(SECRET), hmac(key('encryption'))]).not.toContain(fingerprint)
  })

  test('fingerprints depend on the secret', () => {
    expect(deriveKeys(SECRET).fingerprint('1.2.3.4')).toBe(deriveKeys(SECRET).fingerprint('1.2.3.4'))
    expect(deriveKeys(SECRET).fingerprint('1.2.3.4')).not.toBe(deriveKeys(OTHER).fingerprint('1.2.3.4'))
  })

  test('a token digest is stable and does not hold the token', () => {
    expect(digest('token')).toBe(digest('token'))
    expect(digest('token')).not.toContain('token')
  })
})
