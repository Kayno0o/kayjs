import type { BareUser } from '../../src/core'
import type { AuthStore } from '../../src/store'
import { describe, expect, test } from 'bun:test'
import { s } from 'kay'
import { cookieJar } from 'kay/test'
import { testApp } from './app'

type SignInAs = (site: { cookies: Bun.CookieMap }, who: Record<string, unknown>) => Promise<BareUser>

// `testApp` types the app's data as empty, so the data under test goes through a looser signature.
function looseSignInAs(auth: { signInAs: (site: { cookies: Bun.CookieMap }, who: never) => Promise<BareUser> }): SignInAs {
  return async (site, who) => auth.signInAs(site, who as never)
}

// What `auth.signInAs` must do on each store: `fresh` answers an empty store.
export function signInAsContract(name: string, fresh: () => Promise<AuthStore>) {
  describe(`${name}: signInAs`, () => {
    async function setup() {
      const store = await fresh()
      const made = testApp({ store, user: s.Object({ avatar: s.Optional(s.String()), theme: s.Optional(s.String()) }) as never })
      const signInAs = looseSignInAs(made.auth)
      const site = cookieJar()
      const who = async () => {
        const text = await (await site.send(made.app.handle, new Request('http://localhost/me'))).text()

        return text === 'anonymous' ? text : JSON.parse(text) as { id: string, data: Record<string, unknown> }
      }

      return { ...made, signInAs, store, site, who }
    }

    test('makes a member and signs a site in, finds one by username alone or by email, and signs out', async () => {
      const { auth, signInAs, site, who } = await setup()
      const ada = await signInAs(site, { email: 'Ada@Example.com', username: 'Ada', roles: ['editor'], emailVerified: true })

      expect(await who()).toMatchObject({ id: ada.id, email: 'ada@example.com', username: 'Ada', roles: ['editor'], emailVerified: true })

      const grace = await signInAs(site, { username: 'grace' })

      expect(await who()).toMatchObject({ id: grace.id, username: 'grace' })
      expect(await signInAs(site, { username: 'ADA' })).toMatchObject({ id: ada.id })
      expect(await signInAs(site, { email: 'ada@EXAMPLE.com' })).toMatchObject({ id: ada.id })
      expect(await who()).toMatchObject({ id: ada.id })
      auth.signOut(site)
      expect(await who()).toBe('anonymous')
    })

    test('makes a member with a password, who then signs in with it', async () => {
      const { signInAs, app, site } = await setup()

      await signInAs(site, { username: 'ada', password: 'correct horse battery staple' })

      const response = await app.handle(new Request('http://localhost/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: 'ada', password: 'correct horse battery staple' }) }))

      expect(await response.json()).toMatchObject({ ok: true })
    })

    test('sets the app\'s user data on a new member, and refuses data the schema rejects or one without a schema', async () => {
      const { signInAs, site, who } = await setup()
      const ada = await signInAs(site, { username: 'ada', data: { avatar: 'a.png' } })

      expect(ada.data).toEqual({ avatar: 'a.png' })
      expect(await who()).toMatchObject({ id: ada.id, data: { avatar: 'a.png' } })
      await expect(signInAs(site, { username: 'bob', data: { avatar: 3 as unknown as string } })).rejects.toThrow('could not set the member\'s data')
      await expect(looseSignInAs(testApp().auth)(cookieJar(), { username: 'bob', data: { avatar: 'b.png' } })).rejects.toThrow('has no `user` schema')
    })

    test('throws for a banned member and keeps the current one signed in', async () => {
      const { signInAs, store, site, who } = await setup()
      const ada = await signInAs(site, { username: 'ada' })
      const bob = await signInAs(cookieJar(), { username: 'bob' })

      await store.users.update(bob.id, { bannedAt: new Date(), bannedUntil: null })
      await expect(signInAs(site, { username: 'bob' })).rejects.toThrow()
      expect(await who()).toMatchObject({ id: ada.id })
    })

    test('throws for a member whose email, username, roles or data differ from the fields given, and signs in one that matches', async () => {
      const { auth, signInAs, site, who } = await setup()
      const ada = await signInAs(site, { email: 'ada@example.com', username: 'ada', roles: ['editor'], data: { avatar: 'a.png' } })

      auth.signOut(site)
      await expect(signInAs(site, { username: 'ada', email: 'other@example.com' })).rejects.toThrow('email differ')
      await expect(signInAs(site, { email: 'ada@example.com', username: 'other' })).rejects.toThrow('username differ')
      await expect(signInAs(site, { username: 'ada', roles: ['admin'] })).rejects.toThrow('roles differ')
      await expect(signInAs(site, { username: 'ada', data: { avatar: 'b.png' } })).rejects.toThrow('data differ')
      expect(await who()).toBe('anonymous')
      expect(await signInAs(site, { email: 'ada@example.com', username: 'ADA', roles: ['editor'], data: { avatar: 'a.png' } })).toMatchObject({ id: ada.id })
      expect(await who()).toMatchObject({ id: ada.id })
    })
  })
}
