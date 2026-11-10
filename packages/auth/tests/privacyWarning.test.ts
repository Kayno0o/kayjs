import type { AuthSessionData } from '../src/auth'
import type { AuthPagesConfig } from '../src/pages'
import { describe, expect, spyOn, test } from 'bun:test'
import { session } from 'kay/server'
import { authCore } from '../src/auth'
import { log } from '../src/log'
import { memoryAuth } from '../src/memoryStore'
import { SECRET } from './helpers/app'

type Options = Partial<Parameters<typeof authCore>[0]>

const make = (options: Options) => authCore({ sessions: session<AuthSessionData>({ secret: SECRET }), secret: SECRET, store: memoryAuth(), ...options })

// How many times the boot warned about the register page's missing purpose and policy, with NODE_ENV as given.
function warnings(env: string | undefined, options: Options): number {
  const was = process.env.NODE_ENV
  const warned = spyOn(log, 'warn').mockImplementation(() => undefined)

  if (env === undefined)
    delete process.env.NODE_ENV
  else
    process.env.NODE_ENV = env

  try {
    make(options)

    return warned.mock.calls.filter(([message]) => String(message).includes('register page')).length
  }
  finally {
    if (was === undefined)
      delete process.env.NODE_ENV
    else
      process.env.NODE_ENV = was

    warned.mockRestore()
  }
}

describe('the register page boot warning', () => {
  const pages = (config: AuthPagesConfig = {}) => ({ pages: config })

  test('warns in production when the stock pages open sign-up with no privacy link', () => {
    expect(warnings('production', pages())).toBe(1)
    expect(warnings('production', pages({ purpose: 'To sign you in.' }))).toBe(1)
  })

  test('is quiet with a privacy link, with sign-up or passwords off, without the pages, and outside production', () => {
    expect(warnings('production', pages({ privacy: '/privacy' }))).toBe(0)
    expect(warnings('production', { ...pages(), signUp: false })).toBe(0)
    expect(warnings('production', { ...pages(), password: false })).toBe(0)
    expect(warnings('production', {})).toBe(0)
    expect(warnings(undefined, pages())).toBe(0)
  })
})
