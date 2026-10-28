import { describe, expect, it } from 'bun:test'
import { FlatMethods } from '../src/flatMethods'
import { testApp } from './helpers/app'

const GROUPS = ['password', 'email', 'magicLink', 'twoFactor', 'passkeys', 'sessions', 'tokens', 'oauthServer', 'admin', 'organizations']
const DEPRECATED = /\/\*\* @deprecated since 1\.82: `auth\.(\w+)\.(\w+)` \*\/\n {2}(?:async )?(\w+)\(/g

// An object on `FlatMethods` whose groups answer each call with the method it reached and the arguments it got.
function recorder(): Record<string, (...args: unknown[]) => unknown> {
  const groups = Object.fromEntries(GROUPS.map(group => [group, { value: new Proxy({}, { get: (_, method) => (...args: unknown[]) => ({ called: `${group}.${String(method)}`, args }) }) }]))

  return Object.create(FlatMethods.prototype, groups) as Record<string, (...args: unknown[]) => unknown>
}

describe('the flat methods before 1.82', () => {
  it('each call the grouped method their deprecation names, with the same arguments', async () => {
    const source = await Bun.file(new URL('../src/flatMethods.ts', import.meta.url)).text()
    const named = [...source.matchAll(DEPRECATED)].map(([, group, method, flat]) => [flat!, `${group}.${method}`] as const)
    const flats = Object.getOwnPropertyNames(FlatMethods.prototype).filter(name => name !== 'constructor')
    const auth = recorder()

    expect(named.map(([flat]) => flat).sort()).toEqual(flats.sort())

    for (const [flat, grouped] of named)
      expect(await auth[flat]!('a', 2)).toEqual({ called: grouped, args: ['a', 2] })
  })

  it('still work on a request', async () => {
    const app = testApp()
    const browser = app.browser()

    await browser.call('password.register', { email: 'ada@example.com', password: 'correct horse battery staple' })
    expect(await browser.post('/call/listSessions', [])).toMatchObject([{ current: true }])
  })
})
