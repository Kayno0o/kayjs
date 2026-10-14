import type { AuthStore } from '../../src/store'
import { beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { userRecord } from './app'

// What every store must do, run against each one: `fresh` answers an empty store.
export function storeContract(name: string, fresh: () => Promise<AuthStore>) {
  describe(`${name}: the store contract`, () => {
    let store: AuthStore

    beforeEach(async () => {
      setSystemTime()
      store = await fresh()
    })

    const identity = (provider: string, providerId: string, userId: string) => ({ provider, providerId, userId, accessToken: 'sealed', refreshToken: null, tokenExpiresAt: new Date('2030-01-01T00:00:00Z'), createdAt: new Date() })

    test('users round-trip, are found by email and by username whatever its case, and hand out copies', async () => {
      const created = userRecord({ id: 'u1', email: 'ada@example.com', username: 'Ada', roles: ['admin'], emailVerifiedAt: new Date('2026-01-01T00:00:00Z') })

      await store.users.create(created)

      expect(await store.users.get('u1')).toEqual(created)
      expect((await store.users.findByEmail('ada@example.com'))?.id).toBe('u1')
      expect((await store.users.findByUsername('ADA'))?.id).toBe('u1')
      expect(await store.users.get('missing')).toBeUndefined()
      expect(await store.users.findByEmail('nobody@example.com')).toBeUndefined()

      const copy = await store.users.get('u1')

      copy!.roles.push('mutated')

      expect((await store.users.get('u1'))!.roles).toEqual(['admin'])
    })

    test('a taken email or username is refused, on create and on update', async () => {
      await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com', username: 'Ada' }))
      await store.users.create(userRecord({ id: 'u2', email: 'bob@example.com', username: 'Bob' }))

      expect(async () => store.users.create(userRecord({ id: 'u3', email: 'ada@example.com' }))).toThrow()
      expect(async () => store.users.create(userRecord({ id: 'u3', username: 'ADA' }))).toThrow()
      expect(async () => store.users.update('u2', { email: 'ada@example.com' })).toThrow()
      expect(async () => store.users.update('u2', { username: 'ada' })).toThrow()
    })

    test('an update changes the fields given only, and answers the user, or undefined without one', async () => {
      await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com', username: 'Ada' }))

      expect(await store.users.update('u1', { sessionVersion: 3, username: null })).toMatchObject({ id: 'u1', email: 'ada@example.com', username: null, sessionVersion: 3 })
      expect(await store.users.findByUsername('Ada')).toBeUndefined()
      expect(await store.users.update('missing', { sessionVersion: 1 })).toBeUndefined()
    })

    test('users list newest first, a page at a time, searched by part of an email or a username whatever its case, or by id', async () => {
      await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com', username: 'Ada', createdAt: new Date('2026-01-01T00:00:00Z') }))
      await store.users.create(userRecord({ id: 'u2', email: 'bob@example.com', createdAt: new Date('2026-01-02T00:00:00Z') }))
      await store.users.create(userRecord({ id: 'u3', username: 'Adalbert', createdAt: new Date('2026-01-03T00:00:00Z'), bannedAt: new Date('2026-02-01T00:00:00Z'), banReason: 'spam' }))

      const ids = (found: { users: { id: string }[] }) => found.users.map(user => user.id)

      expect(ids(await store.users.list({ offset: 0, limit: 10 }))).toEqual(['u3', 'u2', 'u1'])
      expect(await store.users.list({ offset: 1, limit: 1 })).toMatchObject({ users: [{ id: 'u2' }], total: 3 })
      expect(await store.users.list({ search: 'ADA', offset: 0, limit: 10 })).toMatchObject({ users: [{ id: 'u3', bannedAt: new Date('2026-02-01T00:00:00Z'), banReason: 'spam' }, { id: 'u1' }], total: 2 })
      expect(ids(await store.users.list({ search: 'bob@', offset: 0, limit: 10 }))).toEqual(['u2'])
      expect(ids(await store.users.list({ search: 'u1', offset: 0, limit: 10 }))).toEqual(['u1'])
      expect(await store.users.list({ search: '%', offset: 0, limit: 10 })).toEqual({ users: [], total: 0 })
    })

    test('a TOTP step advances only forward', async () => {
      await store.users.create(userRecord({ id: 'u1', totpLastStep: 10 }))

      expect(await store.users.advanceTotpStep('u1', 10)).toBe(false)
      expect(await store.users.advanceTotpStep('u1', 11)).toBe(true)
      expect(await store.users.advanceTotpStep('u1', 11)).toBe(false)
      expect(await Promise.all([store.users.advanceTotpStep('u1', 12), store.users.advanceTotpStep('u1', 12)])).toContain(false)
      expect((await store.users.get('u1'))!.totpLastStep).toBe(12)
    })

    test('identities are found, listed by user, updated, deleted, and unique per provider account', async () => {
      const discord = identity('discord', '1', 'u1')

      await store.users.create(userRecord({ id: 'u1' }))
      await store.identities.create(discord)
      await store.identities.create(identity('github', '7', 'u1'))

      expect(await store.identities.find('discord', '1')).toEqual(discord)
      expect((await store.identities.listByUser('u1')).map(entry => entry.provider).sort()).toEqual(['discord', 'github'])
      expect(async () => store.identities.create(identity('discord', '1', 'u1'))).toThrow()

      await store.identities.update('discord', '1', { accessToken: null, tokenExpiresAt: null })

      expect(await store.identities.find('discord', '1')).toMatchObject({ accessToken: null, tokenExpiresAt: null })

      await store.identities.delete('discord', '1')

      expect(await store.identities.find('discord', '1')).toBeUndefined()
    })

    test('a token is spent once, by its type, and not once expired', async () => {
      await store.users.create(userRecord({ id: 'u1' }))
      const token = (digest: string, expiresAt = new Date(Date.now() + 60_000)) => ({ digest, type: 'magic-link' as const, userId: 'u1', email: 'ada@example.com', redirect: '/account', expiresAt })

      await store.tokens.create(token('a'))
      await store.tokens.create(token('b', new Date(Date.now() - 1000)))
      await store.tokens.create(token('c'))

      expect(await store.tokens.consume('a', 'reset-password')).toBeUndefined()
      expect(await Promise.all([store.tokens.consume('a', 'magic-link'), store.tokens.consume('a', 'magic-link')])).toContainEqual(undefined)
      expect(await store.tokens.consume('a', 'magic-link')).toBeUndefined()
      expect(await store.tokens.consume('b', 'magic-link')).toBeUndefined()

      await store.tokens.deleteForUser('u1', 'verify-email')
      expect(await store.tokens.consume('c', 'magic-link')).toMatchObject({ digest: 'c', type: 'magic-link', userId: 'u1', email: 'ada@example.com', redirect: '/account' })
    })

    test('a user\'s tokens are deleted by type or all together', async () => {
      await store.users.create(userRecord({ id: 'u1' }))
      const expiresAt = new Date(Date.now() + 60_000)

      await store.tokens.create({ digest: 'a', type: 'magic-link', userId: 'u1', email: 'x', redirect: null, expiresAt })
      await store.tokens.create({ digest: 'b', type: 'verify-email', userId: 'u1', email: 'x', redirect: null, expiresAt })
      await store.tokens.deleteForUser('u1', 'magic-link')

      expect(await store.tokens.consume('a', 'magic-link')).toBeUndefined()
      expect(await store.tokens.consume('b', 'verify-email')).toBeDefined()
    })

    test('recovery codes are replaced as a set, spent once and counted', async () => {
      await store.users.create(userRecord({ id: 'u1' }))
      await store.recoveryCodes.replace('u1', ['a', 'b', 'c'])

      expect(await store.recoveryCodes.count('u1')).toBe(3)
      expect(await Promise.all([store.recoveryCodes.consume('u1', 'a'), store.recoveryCodes.consume('u1', 'a')])).toEqual(expect.arrayContaining([true, false]))
      expect(await store.recoveryCodes.consume('u2', 'b')).toBe(false)

      await store.recoveryCodes.replace('u1', ['d'])

      expect(await store.recoveryCodes.consume('u1', 'b')).toBe(false)
      expect(await store.recoveryCodes.count('u1')).toBe(1)
    })

    test('bearer tokens are found by digest, listed, touched and deleted by their owner only', async () => {
      await store.users.create(userRecord({ id: 'u1' }))
      await store.users.create(userRecord({ id: 'u2' }))
      await store.bearerTokens.create({ id: 't1', userId: 'u1', label: 'Phone', digest: 'd1', scopes: ['posts:read'], createdAt: new Date('2026-01-01T00:00:00Z'), lastUsedAt: null, expiresAt: new Date('2030-01-01T00:00:00Z') })

      const at = new Date('2026-02-01T00:00:00Z')

      await store.bearerTokens.touch('t1', at)

      expect(await store.bearerTokens.findByDigest('d1')).toMatchObject({ id: 't1', lastUsedAt: at, scopes: ['posts:read'], expiresAt: new Date('2030-01-01T00:00:00Z') })
      expect((await store.bearerTokens.listByUser('u1')).map(token => token.label)).toEqual(['Phone'])
      expect(await store.bearerTokens.delete('u2', 't1')).toBe(false)
      expect(await store.bearerTokens.delete('u1', 't1')).toBe(true)
      expect(await store.bearerTokens.findByDigest('d1')).toBeUndefined()
    })

    test('sessions are got, listed by user oldest first, updated, and deleted by their owner only', async () => {
      const session = (id: string, createdAt: string, maxAge: number | null = null) => ({ id, userId: 'u1', version: 0, userAgent: 'Firefox', ip: '10.0.0.1', createdAt: new Date(createdAt), lastSeenAt: new Date(createdAt), maxAge })

      await store.users.create(userRecord({ id: 'u1' }))
      await store.sessions.create(session('s2', '2026-01-02T00:00:00Z', 86_400))
      await store.sessions.create(session('s1', '2026-01-01T00:00:00Z'))

      const at = new Date('2026-02-01T00:00:00Z')

      await store.sessions.update('s1', { version: 3, ip: '10.0.0.2', lastSeenAt: at })

      expect(await store.sessions.get('s1')).toEqual({ ...session('s1', '2026-01-01T00:00:00Z'), version: 3, ip: '10.0.0.2', lastSeenAt: at })
      expect(await store.sessions.listByUser('u1')).toEqual([expect.objectContaining({ id: 's1', maxAge: null }), session('s2', '2026-01-02T00:00:00Z', 86_400)])
      expect(await store.sessions.delete('u2', 's1')).toBe(false)
      expect(await store.sessions.delete('u1', 's1')).toBe(true)
      expect(await store.sessions.get('s1')).toBeUndefined()
      expect(await store.passkeys.get('p1')).toBeUndefined()
      expect(await store.sessions.get('missing')).toBeUndefined()
    })

    test('passkeys are got, listed by user oldest first, updated, unique, and deleted by their owner only', async () => {
      const passkey = (id: string, createdAt: string) => ({ id, userId: 'u1', name: 'Phone', publicKey: 'pk', counter: 0, transports: ['internal'], multiDevice: true, backedUp: false, createdAt: new Date(createdAt), lastUsedAt: null })

      await store.users.create(userRecord({ id: 'u1' }))
      await store.passkeys.create(passkey('p2', '2026-01-02T00:00:00Z'))
      await store.passkeys.create(passkey('p1', '2026-01-01T00:00:00Z'))

      const at = new Date('2026-02-01T00:00:00Z')

      await store.passkeys.update('p1', { name: 'Laptop', counter: 4_000_000_000, backedUp: true, lastUsedAt: at })

      expect(await store.passkeys.get('p1')).toEqual({ ...passkey('p1', '2026-01-01T00:00:00Z'), name: 'Laptop', counter: 4_000_000_000, backedUp: true, lastUsedAt: at })
      expect((await store.passkeys.listByUser('u1')).map(found => found.id)).toEqual(['p1', 'p2'])
      expect(async () => store.passkeys.create(passkey('p1', '2026-01-03T00:00:00Z'))).toThrow()
      expect(await store.passkeys.delete('u2', 'p1')).toBe(false)
      expect(await store.passkeys.delete('u1', 'p1')).toBe(true)
      expect(await store.passkeys.get('p1')).toBeUndefined()
    })

    test('the audit log lists newest first, by user and before an instant, and is pruned by age', async () => {
      const entry = (id: string, userId: string, at: string) => ({ id, userId, event: 'signed-in', detail: 'password', ip: '10.0.0.1', userAgent: 'Firefox', actorId: null, at: new Date(at) })

      await store.audit!.add(entry('a1', 'u1', '2026-01-01T00:00:00Z'))
      await store.audit!.add(entry('a2', 'u2', '2026-01-02T00:00:00Z'))
      await store.audit!.add(entry('a3', 'u1', '2026-01-03T00:00:00Z'))

      expect((await store.audit!.list({ limit: 10 })).map(found => found.id)).toEqual(['a3', 'a2', 'a1'])
      expect((await store.audit!.list({ userId: 'u1', limit: 10 })).map(found => found.id)).toEqual(['a3', 'a1'])
      expect((await store.audit!.list({ before: new Date('2026-01-03T00:00:00Z'), limit: 1 })).map(found => found.id)).toEqual(['a2'])
      expect(await store.audit!.list({ userId: 'u2', limit: 10 })).toEqual([entry('a2', 'u2', '2026-01-02T00:00:00Z')])

      await store.audit!.prune(new Date('2026-01-02T00:00:00Z'))

      expect((await store.audit!.list({ limit: 10 })).map(found => found.id)).toEqual(['a3', 'a2'])
    })

    test('the audit log orders entries of one millisecond by id, newest first, and pages across them without a skip or a repeat', async () => {
      const entry = (id: string, userId: string, at: string) => ({ id, userId, event: 'signed-in', detail: null, ip: '10.0.0.1', userAgent: 'Firefox', actorId: null, at: new Date(at) })
      const same = '2026-02-01T00:00:00.000Z'

      await store.audit!.add(entry('b2', 'u1', same))
      await store.audit!.add(entry('b3', 'u2', same))
      await store.audit!.add(entry('b1', 'u1', same))
      await store.audit!.add(entry('b0', 'u1', '2026-01-31T00:00:00.000Z'))
      await store.audit!.add(entry('b4', 'u1', '2026-02-02T00:00:00.000Z'))

      expect((await store.audit!.list({ limit: 10 })).map(found => found.id)).toEqual(['b4', 'b3', 'b2', 'b1', 'b0'])

      for (const limit of [1, 2, 3]) {
        const seen: string[] = []
        let before: { at: Date, id: string } | undefined

        for (;;) {
          const page = await store.audit!.list({ ...before ? { before } : {}, limit })

          if (page.length === 0)
            break

          seen.push(...page.map(found => found.id))
          before = page.at(-1)
        }

        expect(seen).toEqual(['b4', 'b3', 'b2', 'b1', 'b0'])
      }

      expect((await store.audit!.list({ userId: 'u1', before: { at: new Date(same), id: 'b2' }, limit: 10 })).map(found => found.id)).toEqual(['b1', 'b0'])
      expect((await store.audit!.list({ before: { at: new Date(same), id: 'b1' }, limit: 10 })).map(found => found.id)).toEqual(['b0'])
      // A bare instant still excludes the whole millisecond.
      expect((await store.audit!.list({ before: new Date(same), limit: 10 })).map(found => found.id)).toEqual(['b0'])
    })

    test('the audit log forgets a user, in their entries and in those they acted in', async () => {
      const entry = (id: string, userId: string, actorId: string | null) => ({ id, userId, event: 'role-granted', detail: 'editor', ip: '10.0.0.1', userAgent: 'Firefox', actorId, at: new Date('2026-01-01T00:00:00Z') })

      await store.audit!.add(entry('a1', 'u1', null))
      await store.audit!.add(entry('a2', 'u2', 'u1'))
      await store.audit!.add(entry('a3', 'u2', null))
      await store.audit!.forget('u1', 'gone')

      expect(await store.audit!.list({ userId: 'u1', limit: 10 })).toEqual([])
      expect((await store.audit!.list({ userId: 'gone', limit: 10 })).map(({ id, detail, ip, userAgent, actorId }) => ({ id, detail, ip, userAgent, actorId }))).toEqual([{ id: 'a1', detail: null, ip: '', userAgent: '', actorId: null }])
      expect((await store.audit!.list({ userId: 'u2', limit: 10 })).map(({ id, detail, ip, userAgent, actorId }) => ({ id, detail, ip, userAgent, actorId })).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: 'a2', detail: 'editor', ip: '', userAgent: '', actorId: 'gone' },
        { id: 'a3', detail: 'editor', ip: '10.0.0.1', userAgent: 'Firefox', actorId: null },
      ])
    })

    test('deleting a user takes everything kept for them', async () => {
      await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com' }))
      await store.identities.create(identity('discord', '1', 'u1'))
      await store.tokens.create({ digest: 'a', type: 'magic-link', userId: 'u1', email: 'x', redirect: null, expiresAt: new Date(Date.now() + 60_000) })
      await store.recoveryCodes.replace('u1', ['a'])
      await store.bearerTokens.create({ id: 't1', userId: 'u1', label: 'Phone', digest: 'd1', scopes: null, createdAt: new Date(), lastUsedAt: null, expiresAt: null })
      await store.sessions.create({ id: 's1', userId: 'u1', version: 0, userAgent: '', ip: '', createdAt: new Date(), lastSeenAt: new Date(), maxAge: null })
      await store.passkeys.create({ id: 'p1', userId: 'u1', name: 'Phone', publicKey: 'pk', counter: 0, transports: [], multiDevice: false, backedUp: false, createdAt: new Date(), lastUsedAt: null })

      await store.users.delete('u1')

      expect(await store.users.findByEmail('ada@example.com')).toBeUndefined()
      expect(await store.identities.find('discord', '1')).toBeUndefined()
      expect(await store.tokens.consume('a', 'magic-link')).toBeUndefined()
      expect(await store.recoveryCodes.count('u1')).toBe(0)
      expect(await store.bearerTokens.findByDigest('d1')).toBeUndefined()
      expect(await store.sessions.get('s1')).toBeUndefined()
    })

    test('organizations are found by id and slug, keep slugs unique, and take their members and invitations when deleted', async () => {
      const at = new Date('2026-01-01T00:00:00Z')

      await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com' }))
      await store.users.create(userRecord({ id: 'u2', email: 'grace@example.com' }))
      await store.organizations!.create({ id: 'o1', name: 'Acme', slug: 'acme', createdAt: at })
      await store.organizations!.create({ id: 'o2', name: 'Other', slug: null, createdAt: at })

      expect(async () => store.organizations!.create({ id: 'o3', name: 'Copy', slug: 'acme', createdAt: at })).toThrow()
      expect(await store.organizations!.findBySlug('acme')).toEqual({ id: 'o1', name: 'Acme', slug: 'acme', createdAt: at })
      expect(await store.organizations!.update('o1', { name: 'Acme Inc' })).toMatchObject({ name: 'Acme Inc', slug: 'acme' })
      expect(async () => store.organizations!.update('o2', { slug: 'acme' })).toThrow()

      await store.members!.add({ organizationId: 'o1', userId: 'u2', roles: ['member'], createdAt: new Date('2026-01-02T00:00:00Z') })
      await store.members!.add({ organizationId: 'o1', userId: 'u1', roles: ['owner'], createdAt: at })
      await store.members!.add({ organizationId: 'o2', userId: 'u1', roles: ['owner'], createdAt: new Date('2026-01-03T00:00:00Z') })

      expect(async () => store.members!.add({ organizationId: 'o1', userId: 'u1', roles: [], createdAt: at })).toThrow()
      expect((await store.members!.listByOrganization('o1')).map(member => member.userId)).toEqual(['u1', 'u2'])
      expect((await store.members!.listByUser('u1')).map(member => member.organizationId)).toEqual(['o1', 'o2'])
      expect(await store.members!.update('o1', 'u2', { roles: ['admin'] })).toMatchObject({ roles: ['admin'] })
      expect(await store.members!.update('o1', 'nobody', { roles: [] })).toBeUndefined()

      const invitation = { id: 'i1', organizationId: 'o1', email: 'alan@example.com', roles: ['member'], invitedBy: 'u2', createdAt: at, expiresAt: new Date('2026-01-08T00:00:00Z') }

      await store.invitations!.create(invitation)

      expect(await store.invitations!.get('i1')).toEqual(invitation)
      expect(await store.invitations!.listByEmail('alan@example.com')).toEqual([invitation])

      await store.users.delete('u2')

      expect(await store.members!.get('o1', 'u2')).toBeUndefined()
      expect(await store.invitations!.get('i1')).toMatchObject({ invitedBy: null })
      expect(await store.members!.remove('o2', 'u1')).toBe(true)
      expect(await store.members!.remove('o2', 'u1')).toBe(false)
      expect(await store.organizations!.delete('o1')).toBe(true)
      expect(await store.organizations!.delete('o1')).toBe(false)
      expect(await store.members!.listByUser('u1')).toEqual([])
      expect(await store.invitations!.listByOrganization('o1')).toEqual([])
    })

    test('attempts count within their window, start over after it, and reset', async () => {
      expect(await store.attempts.count('k')).toBe(0)
      expect(await store.attempts.hit('k', 60)).toBe(1)
      expect(await Promise.all([store.attempts.hit('k', 60), store.attempts.hit('k', 60)])).toEqual(expect.arrayContaining([2, 3]))
      expect(await store.attempts.count('k')).toBe(3)

      setSystemTime(Date.now() + 61_000)

      expect(await store.attempts.count('k')).toBe(0)
      expect(await store.attempts.hit('k', 60)).toBe(1)

      await store.attempts.reset('k')

      expect(await store.attempts.count('k')).toBe(0)
    })
  })
}
