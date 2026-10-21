import type { GuardContext } from 'kay'
import { describe, expect, test } from 'bun:test'
import { passwordGuard, Passwords, SESSION_COOKIE, signedInBy } from '../src/password'

class Denied {
  constructor(readonly status: number, readonly message?: string) {}
}

function context(cookie?: string): GuardContext {
  const url = new URL('http://site.test/api/cms/entries/posts/hello')
  const cookies = new Bun.CookieMap(cookie === undefined ? '' : `${SESSION_COOKIE}=${cookie}`)

  return { request: new Request(url), url, cookies, deny: (status: number, message?: string) => {
    throw new Denied(status, message)
  } } as unknown as GuardContext
}

async function statusOf(ctx: GuardContext, guard = passwordGuard({ editor: 'pw-editor', admin: 'pw-admin' })): Promise<number> {
  try {
    await guard(ctx)

    return 200
  }
  catch (error) {
    return (error as Denied).status
  }
}

describe('the password guard\'s sign-in cookie', () => {
  const passwords = new Passwords({ editor: 'pw-editor', admin: 'pw-admin' }, '1h')

  test('opens with the password of a role and signs that role in', async () => {
    const role = passwords.match('pw-admin')

    expect(role).toBe('admin')
    expect(passwords.match('pw-editor')).toBe('editor')
    expect(passwords.match('pw-adminx')).toBeUndefined()
    expect(passwords.match('')).toBeUndefined()

    const cookie = passwords.issue('admin', false)
    const ctx = context(cookie.value)

    expect(await statusOf(ctx)).toBe(200)
    expect(signedInBy.get(ctx.request)).toEqual({ name: 'admin', roles: ['admin'] })
    expect(cookie.httpOnly).toBe(true)
    expect(cookie.sameSite).toBe('lax')
  })

  test('refuses a visitor with no cookie or a forged one with a 401', async () => {
    const [, expires = '', signature = ''] = passwords.issue('editor', false).value.split('.')

    expect(await statusOf(context())).toBe(401)
    expect(await statusOf(context('admin.9999999999999.forged'))).toBe(401)
    // The editor's signature on the admin's name.
    expect(await statusOf(context(`admin.${expires}.${signature}`))).toBe(401)
    // The same signature with a later date.
    expect(await statusOf(context(`editor.${Number(expires) + 86_400_000}.${signature}`))).toBe(401)
    expect(await statusOf(context(`editor.${expires}`))).toBe(401)
    expect(await statusOf(context(`editor.${expires}.${signature}.more`))).toBe(401)
  })

  test('refuses roles that are object keys of the language, not of the app', async () => {
    for (const role of ['__proto__', 'constructor', 'toString', 'hasOwnProperty'])
      expect(passwords.read(`${role}.9999999999999.x`)).toBeUndefined()
  })

  test('refuses a cookie past its date, and one signed for another password', async () => {
    const short = new Passwords({ editor: 'pw-editor' }, 1)
    const cookie = short.issue('editor', false)

    expect(short.read(cookie.value)).toBe('editor')
    await Bun.sleep(1100)
    expect(short.read(cookie.value)).toBeUndefined()

    const changed = new Passwords({ editor: 'another' }, '1h')

    expect(changed.read(passwords.issue('editor', false).value)).toBeUndefined()
  })

  test('marks the cookie secure over https, and lasts as long as maxAge says', () => {
    expect(passwords.issue('editor', true).secure).toBe(true)
    expect(passwords.issue('editor', false).maxAge).toBe(3600)
  })

  test('refuses to be set up with an empty password, as an unset variable reads', () => {
    expect(() => passwordGuard('')).toThrow('no password')
    expect(() => passwordGuard('   ')).toThrow('no password')
    expect(() => passwordGuard({ editor: 'ok', admin: '' })).toThrow('admin')
    expect(() => passwordGuard({})).toThrow('takes a password')
    expect(() => passwordGuard({ 'a.b': 'x' })).toThrow('letters, digits')
    expect(() => passwordGuard('x', { maxAge: 'soon' })).toThrow()
  })

  test('a lone password signs in as the editor role', async () => {
    const lone = new Passwords({ editor: 'only' }, '1h')

    expect(lone.match('only')).toBe('editor')
  })
})
