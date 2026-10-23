import type { GuardContext } from 'kay'
import { describe, expect, test } from 'bun:test'
import { memoryRates } from 'kay/library'
import { HOST_SESSION_COOKIE, passwordGuard, Passwords, SESSION_COOKIE, sessionCookieOf, signedInBy } from '../src/password'

class Denied {
  constructor(readonly status: number, readonly message?: string) {}
}

function context(cookie?: string, name = SESSION_COOKIE): GuardContext {
  const url = new URL('http://site.test/_kay/cms/entries/posts/hello')
  const cookies = new Bun.CookieMap(cookie === undefined ? '' : `${name}=${cookie}`)

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
    const short = new Passwords({ editor: 'pw-editor' }, '1s')
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
    expect(() => passwordGuard('x', { maxAge: 'soon' as never })).toThrow()
  })

  test('signing out ends the sign-in for a copy of the cookie too, and only that one', async () => {
    const cookie = passwords.issue('editor', false).value
    const copy = cookie.slice()
    const other = passwords.issue('admin', false).value

    expect(passwords.read(copy)).toBe('editor')
    await passwords.revoke(cookie)
    expect(passwords.read(copy)).toBeUndefined()
    expect(passwords.read(other)).toBe('admin')

    // A forged or foreign value revokes nothing.
    await passwords.revoke('editor.9999999999999.forged')
    await passwords.revoke(undefined)
    expect(passwords.read(passwords.issue('editor', false).value)).toBe('editor')
  })

  test('a lone password signs in as the editor role', async () => {
    const lone = new Passwords({ editor: 'only' }, '1h')

    expect(lone.match('only')).toBe('editor')
  })
})

describe('the secret and the lazily loaded guard', () => {
  test('a cookie signed with one secret opens nothing signed with another', () => {
    const one = new Passwords({ editor: 'pw' }, '1h', 'secret-one')
    const other = new Passwords({ editor: 'pw' }, '1h', 'secret-two')
    const cookie = one.issue('editor', false).value

    expect(one.read(cookie)).toBe('editor')
    expect(other.read(cookie)).toBeUndefined()
    expect(new Passwords({ editor: 'pw' }, '1h').read(cookie)).toBeUndefined()
  })

  test('the sign-in screen knows a lazily loaded password guard once it has loaded', async () => {
    const { configure, settings } = await import('../src/settings')
    const { activePasswords } = await import('../src/password')

    configure({ guard: { load: async () => passwordGuard('lazy-pw') } })
    expect(activePasswords()).toBeUndefined()
    expect(await statusOf(context(), settings().guard)).toBe(401)
    expect(activePasswords()?.match('lazy-pw')).toBe('editor')

    configure({ guard: () => undefined })
    expect(activePasswords()).toBeUndefined()
  })
})

describe('signing out', () => {
  test('signing out ends the cookie and deletes both names', async () => {
    const { configure } = await import('../src/settings')
    const { signOutOf } = await import('../src/access')
    const { activePasswords } = await import('../src/password')
    const guard = passwordGuard({ editor: 'pw-editor' })

    configure({ guard })

    const cookie = activePasswords()!.issue('editor', false).value
    const ctx = context(cookie)
    const deleted: string[] = []

    ctx.cookies.delete = ((options: { name: string }) => void deleted.push(options.name)) as typeof ctx.cookies.delete

    await signOutOf(ctx)
    expect(deleted).toEqual([HOST_SESSION_COOKIE, SESSION_COOKIE])
    expect(await statusOf(context(cookie), guard)).toBe(401)
  })

  test('ends a copy of the cookie, which the guard then refuses with a 401', async () => {
    const { configure } = await import('../src/settings')
    const { signOutOf } = await import('../src/access')
    const { activePasswords } = await import('../src/password')
    const guard = passwordGuard({ editor: 'pw-editor' })

    configure({ guard })

    const cookie = activePasswords()!.issue('editor', false).value

    expect(await statusOf(context(cookie), guard)).toBe(200)
    await signOutOf(context(cookie))
    expect(await statusOf(context(cookie), guard)).toBe(401)
    // Another sign-in of the same role is a cookie of its own.
    expect(await statusOf(context(activePasswords()!.issue('editor', false).value), guard)).toBe(200)
  })
})

describe('a guard the app wraps', () => {
  class Redirected {
    constructor(readonly location: string) {}
  }

  async function visit(path: string, locals: object = {}): Promise<string | number> {
    const { default: screenGuard } = await import('../src/routes/_guard')
    const url = new URL(`http://site.test${path}`)
    const ctx = {
      request: new Request(url),
      url,
      cookies: new Bun.CookieMap(),
      locals,
      redirect: (location: string) => {
        throw new Redirected(location)
      },
      deny: (status: number, message?: string) => {
        throw new Denied(status, message)
      },
    } as unknown as GuardContext

    try {
      await screenGuard(ctx)

      return 200
    }
    catch (error) {
      return error instanceof Redirected ? error.location : (error as Denied).status
    }
  }

  const SIGN_IN = '/admin/sign-in?redirect=%2Fadmin%2Fcollections'

  test('a passwordGuard inside the guard keeps its sign-in screen', async () => {
    const { configure } = await import('../src/settings')
    const { activePasswords } = await import('../src/password')
    const pg = passwordGuard('wrapped-pw')
    const extra = (_ctx: GuardContext): boolean => true

    configure({ guard: async (ctx: GuardContext) => {
      if (extra(ctx))
        await pg(ctx)
    } })

    expect(await visit('/admin/collections')).toBe(SIGN_IN)
    expect(activePasswords()?.match('wrapped-pw')).toBe('editor')
  })

  test('so does one wrapped in a guard returned from { load }', async () => {
    const { configure } = await import('../src/settings')
    const { activePasswords } = await import('../src/password')
    const pg = passwordGuard('wrapped-pw')

    configure({ guard: { load: async () => async (ctx: GuardContext) => {
      await pg(ctx)
    } } })

    expect(await visit('/admin/collections')).toBe(SIGN_IN)
    expect(activePasswords()?.match('wrapped-pw')).toBe('editor')
  })

  test('a wrapped guard leaves a configure of another guard with no password sign-in', async () => {
    const { configure } = await import('../src/settings')
    const { activePasswords } = await import('../src/password')
    const pg = passwordGuard('wrapped-pw')

    configure({ guard: async (ctx: GuardContext) => {
      await pg(ctx)
    } })
    await visit('/admin/collections')
    configure({ guard: ({ deny }) => deny(401, 'Sign in') })

    expect(activePasswords()).toBeUndefined()
    expect(await visit('/admin/collections', { auth: { bareUser: async () => null, signInUrl: (back?: string) => `/login?redirect=${encodeURIComponent(back ?? '/')}` } })).toBe('/login?redirect=%2Fadmin%2Fcollections')
  })

  test('another passwordGuard of the app, run outside the cms guard, changes nothing', async () => {
    const { configure } = await import('../src/settings')
    const { activePasswords } = await import('../src/password')
    const mine = passwordGuard('cms-pw')
    const other = passwordGuard('other-pw')

    configure({ guard: async (ctx: GuardContext) => {
      await mine(ctx)
    } })
    await visit('/admin/collections')
    expect(await statusOf(context(), other)).toBe(401)

    expect(activePasswords()?.match('cms-pw')).toBe('editor')
    expect(activePasswords()?.match('other-pw')).toBeUndefined()
  })

  test('a passwordGuard run elsewhere does not turn a kayjs-auth app to the cms sign-in', async () => {
    const { configure } = await import('../src/settings')
    const { activePasswords } = await import('../src/password')
    const other = passwordGuard('other-pw')
    const auth = { bareUser: async () => null, signInUrl: (back?: string) => `/login?redirect=${encodeURIComponent(back ?? '/')}` }

    configure({ guard: ({ deny }) => deny(401, 'Sign in') })
    await statusOf(context(), other)

    expect(activePasswords()).toBeUndefined()
    expect(await visit('/admin/collections', { auth })).toBe('/login?redirect=%2Fadmin%2Fcollections')
  })

  test('a wrapped kayjs-auth guard sends to the auth sign-in page', async () => {
    const { configure } = await import('../src/settings')
    const auth = { bareUser: async () => null, signInUrl: (back?: string) => `/login?redirect=${encodeURIComponent(back ?? '/')}` }
    const inner = ({ deny }: GuardContext): never => deny(401, 'Sign in')

    configure({ guard: async (ctx: GuardContext) => {
      await inner(ctx)
    } })

    expect(await visit('/admin/collections', { auth })).toBe('/login?redirect=%2Fadmin%2Fcollections')
  })
})

describe('a cookie copied before sign-out', () => {
  test('is refused by another process sharing the store, and by a restart', async () => {
    const store = memoryRates()
    const first = new Passwords({ editor: 'pw-editor' }, '1h', 'one-secret', store)
    const second = new Passwords({ editor: 'pw-editor' }, '1h', 'one-secret', store)
    const cookie = first.issue('editor', false).value

    expect(await second.current(cookie)).toBe('editor')
    await first.revoke(cookie)
    expect(await second.current(cookie)).toBeUndefined()
    expect(await new Passwords({ editor: 'pw-editor' }, '1h', 'one-secret', store).current(cookie)).toBeUndefined()
    expect(await second.current(second.issue('editor', false).value)).toBe('editor')
  })

  test('is refused when the store cannot say whether it was signed out', async () => {
    const down = { hit: async () => Promise.reject(new Error('down')), peek: async () => Promise.reject(new Error('down')) }
    const passwords = new Passwords({ editor: 'pw-editor' }, '1h', 's', down)

    expect(await passwords.current(passwords.issue('editor', false).value)).toBeUndefined()
  })
})

describe('the signing key', () => {
  test('comes from the app secret when none is given, so another app secret refuses the cookie', async () => {
    const before = process.env.KAY_SECRET

    try {
      process.env.KAY_SECRET = 'a'.repeat(40)

      const cookie = new Passwords({ editor: 'pw-editor' }, '1h').issue('editor', false).value

      expect(new Passwords({ editor: 'pw-editor' }, '1h').read(cookie)).toBe('editor')
      process.env.KAY_SECRET = 'b'.repeat(40)
      expect(new Passwords({ editor: 'pw-editor' }, '1h').read(cookie)).toBeUndefined()
    }
    finally {
      if (before === undefined)
        delete process.env.KAY_SECRET
      else
        process.env.KAY_SECRET = before
    }
  })
})

describe('in production', () => {
  function inProduction(run: () => void): void {
    const before = process.env.NODE_ENV

    process.env.NODE_ENV = 'production'

    try {
      run()
    }
    finally {
      process.env.NODE_ENV = before ?? 'test'
    }
  }

  test('a short password is refused, and so are two roles sharing one', () => {
    inProduction(() => {
      expect(() => passwordGuard('short')).toThrow('at least 12')
      expect(() => passwordGuard({ editor: 'a-long-enough-password', admin: 'a-long-enough-password' })).toThrow('the same password')
      expect(() => passwordGuard({ editor: 'a-long-enough-password', admin: 'another-long-password' })).not.toThrow()
    })
  })

  test('outside production they are accepted', () => {
    expect(() => passwordGuard('short')).not.toThrow()
    expect(() => passwordGuard({ editor: 'same', admin: 'same' })).not.toThrow()
  })
})

describe('the cookie name', () => {
  test('is __Host- prefixed over https and plain otherwise, and both are read', () => {
    const passwords = new Passwords({ editor: 'pw-editor' }, '1h', 's')
    const secure = passwords.issue('editor', true)

    expect(secure.name).toBe(HOST_SESSION_COOKIE)
    expect(secure.path).toBe('/')
    expect(secure.secure).toBe(true)
    expect(passwords.issue('editor', false).name).toBe(SESSION_COOKIE)
    expect(sessionCookieOf(new Bun.CookieMap(`${HOST_SESSION_COOKIE}=a`))).toBe('a')
    expect(sessionCookieOf(new Bun.CookieMap(`${SESSION_COOKIE}=b`))).toBe('b')
    expect(sessionCookieOf(new Bun.CookieMap(`${SESSION_COOKIE}=b; ${HOST_SESSION_COOKIE}=a`))).toBe('a')
  })

  test('is ended on sign-out with the secure expiry a browser takes for a __Host- cookie', () => {
    const map = new Bun.CookieMap()

    map.delete({ name: HOST_SESSION_COOKIE, path: '/' })
    expect(map.toSetCookieHeaders()[0]).toContain('Secure')
  })
})

describe('a store without peek', () => {
  test('is refused for a store given to passwordGuard, as it could neither tell a signed-out cookie nor count the ceiling', () => {
    expect(() => passwordGuard('pw-editor', { store: { hit: () => ({ count: 1, resetAt: 0 }) } })).toThrow('peek')
  })
})

describe('wrong passwords from everyone', () => {
  test('past the ceiling lock the sign-in until the window closes', async () => {
    const passwords = new Passwords({ editor: 'pw-editor' }, '1h', 's', memoryRates())

    for (let tried = 0; tried < 99; tried++)
      await passwords.failed()

    expect(await passwords.lockedOut()).toBe(false)
    await passwords.failed()
    expect(await passwords.lockedOut()).toBe(true)
  })
})
