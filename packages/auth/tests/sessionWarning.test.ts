import type { AuthSessionData } from '../src/auth'
import { describe, expect, test } from 'bun:test'
import { session } from 'kay/server'
import { testApp } from './helpers/app'

describe('the session plugin', () => {
  test('is told kayjs-auth ends sessions itself, so it does not warn that a cookie with no store cannot be revoked', () => {
    const sessions = session<AuthSessionData>({ secret: 'a test secret that is long enough to seal' })
    let told = 0
    const spied = Object.assign(sessions, { endsSessionsElsewhere: () => ++told })

    testApp({ sessions: spied })

    expect(told).toBe(1)
  })
})
