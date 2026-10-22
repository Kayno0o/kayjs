import type { Action } from '../src/runtime'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { session } from '../src/server/session'
import { testSite } from '../src/test'

// Made at the top of the file as a site is, so each test posts to it as a client of its own.
const sessions = await testSite({ root: 'tests/fixtures/session', use: [session({ secret: 'a test secret of at least 32 characters' })] })

describe('kay/test on a project with a session', () => {
  it('serves the pages behind the app\'s plugins, so a session signs in, carries over and signs out', async () => {
    const signed = await testSite({ root: 'tests/fixtures/session', use: [session({ secret: 'a test secret of at least 32 characters' })], locals: () => ({ greeting: 'Hello' }) })
    const { signIn, signOut } = await import(join(import.meta.dir, 'fixtures/session/src/routes/index.kay')) as { signIn: Action<{ name: string }, unknown>, signOut: Action<Record<string, never>, unknown> }

    expect((await signed.submit(signIn, { name: '' })).html).toContain('<p class="error">Who are you?</p>')
    // `locals` adds to what the plugins derived, after them.
    expect((await signed.submit(signIn, { name: 'Ada' })).html).toContain('<p>Hello, signed in as Ada</p>')
    expect(signed.cookies.has('kay_session')).toBe(true)
    expect((await signed.visit('/')).html).toContain('<p>Hello, signed in as Ada</p>')
    expect((await signed.submit(signOut, {})).html).toContain('<p>Hello, signed out</p>')
    expect(signed.cookies.has('kay_session')).toBe(false)
  })

  it('calls an action with a form\'s fields, read as a form post reads them and answered as a call', async () => {
    const signed = await testSite({ root: 'tests/fixtures/session', use: [session({ secret: 'a test secret of at least 32 characters' })], locals: () => ({ greeting: 'Hello' }) })
    const { profile, signIn, signOut, limited } = await import(join(import.meta.dir, 'fixtures/session/src/routes/index.kay')) as { profile: Action<{ age: number, admin: boolean, tags: string[], rank?: number, avatar?: File }, unknown>, signIn: Action<{ name: string }, unknown>, signOut: Action<Record<string, never>, unknown>, limited: Action<Record<string, never>, unknown> }
    const form = (fields: [string, string | File][]) => {
      const data = new FormData()

      for (const [name, value] of fields)
        data.append(name, value)

      return data
    }

    // Coerced as a form post's fields are, the blank optional left out.
    expect(await signed.call(profile, form([['age', '36'], ['admin', 'on'], ['tags', 'a'], ['tags', 'b'], ['rank', ''], ['avatar', new File([], '')]]))).toEqual({ age: 36, admin: true, tags: ['a', 'b'] })
    expect(await signed.call(profile, form([['age', '1'], ['avatar', new File(['png'], 'me.png', { type: 'image/png' })]]))).toMatchObject({ avatar: 'me.png' })
    await expect(signed.call(profile, form([['age', 'old'], ['admin', 'on']]))).rejects.toMatchObject({ name: 'ActionError', status: 422, errors: { age: expect.any(String) } })
    // What the handler passed to ctx.fail, and no flash cookie: the island reads the answer itself.
    await expect(signed.call(signIn, form([['name', '']]))).rejects.toMatchObject({ status: 400, data: { error: 'Who are you?' } })
    expect(signed.cookies.has('kay_flash')).toBe(false)
    await expect(signed.call(signOut, form([]))).rejects.toMatchObject({ name: 'ActionRedirectError', location: '/' })
    expect(await signed.call(limited, form([]))).toBe('ok')
    await expect(signed.call(limited, form([]))).rejects.toMatchObject({ status: 429 })
    // The honeypot catches a form's fields however they are sent.
    await expect(signed.call(profile, form([['age', '1'], ['website', 'spam']]))).rejects.toMatchObject({ status: 422, errors: { website: 'Leave this field empty' } })
  })
})

describe('a client per test', () => {
  const limit = async () => (await import(join(import.meta.dir, 'fixtures/session/src/routes/index.kay')) as { limited: Action<Record<string, never>, string> }).limited

  it('counts a rate limit over the posts one test sends', async () => {
    const limited = await limit()

    expect(await sessions.call(limited, {})).toBe('ok')
    await expect(sessions.call(limited, {})).rejects.toMatchObject({ status: 429 })
  })

  it('posts as another client in the next test, whatever the one before sent', async () => {
    expect(await sessions.call(await limit(), {})).toBe('ok')
  })

  it('posts as the client the header of a trusted proxy names', async () => {
    const limited = await limit()
    const proxied = await testSite({ root: 'tests/fixtures/session', use: [session({ secret: 'a test secret of at least 32 characters' })], proxy: { header: 'x-real-ip' } })
    const from = (address: string) => ({ headers: { 'x-real-ip': address } })

    expect(await proxied.call(limited, {}, from('203.0.113.9'))).toBe('ok')
    await expect(proxied.call(limited, {}, from('203.0.113.9'))).rejects.toMatchObject({ status: 429 })
    expect(await proxied.call(limited, {}, from('203.0.113.10'))).toBe('ok')
  })
})
