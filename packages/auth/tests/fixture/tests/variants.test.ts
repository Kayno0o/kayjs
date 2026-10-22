import { join } from 'node:path'
import { expect, test } from 'bun:test'

// The fixture served with another `home` and `remember`, which the environment sets before its auth loads: each run is a process of its own, printing what tests/variants.ts saw.
async function variant(env: Record<string, string>): Promise<Record<string, unknown>> {
  const run = Bun.spawn([process.execPath, join(import.meta.dir, 'variants.ts')], { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' })

  try {
    const [printed, errors] = [await new Response(run.stdout).text(), await new Response(run.stderr).text()]

    expect(await run.exited).toBe(0)
    expect(errors).not.toContain('Error')

    return JSON.parse(printed.split('\n').findLast(line => line.startsWith('{'))!) as Record<string, unknown>
  }
  finally {
    run.kill()
  }
}

test('with password and magicLink off, the sign-in page keeps the provider buttons alone and the pages that only serve them answer 404', async () => {
  expect(await variant({ FIXTURE_SWITCHES: 'password,magicLink' })).toEqual({
    signIn: { password: 0, magic: 0, passkey: true, register: false },
    pages: { 'register': 404, 'reset-password': 404 },
    mailed: 0,
  })
}, 60_000)

test('with twoFactor and passkeys off, the account page offers neither', async () => {
  expect(await variant({ FIXTURE_SWITCHES: 'twoFactor,passkeys' })).toEqual({
    signIn: { password: 1, magic: 1, passkey: false, register: true },
    pages: { 'register': 200, 'reset-password': 200 },
    security: { password: true, twoFactor: false, passkeys: false },
  })
}, 60_000)

test('with magicLink off, the sign-in page has no mail form and the account page keeps the rest', async () => {
  expect(await variant({ FIXTURE_SWITCHES: 'magicLink' })).toEqual({
    signIn: { password: 1, magic: 0, passkey: true, register: true },
    pages: { 'register': 200, 'reset-password': 200 },
    security: { password: true, twoFactor: true, passkeys: true },
    mailed: 0,
  })
}, 60_000)

test('with pages.remember always, the pages show no box, the provider links carry remember=1, every sign-in lasts rememberMaxAge, and each flow lands on home in the page\'s language', async () => {
  expect(await variant({ FIXTURE_HOME: '/dashboard', FIXTURE_REMEMBER: 'always' })).toEqual({
    'signIn': { boxes: 0, links: ['/auth/discord?redirect=%2Fdashboard&remember=1'] },
    'register': { boxes: 0, links: ['/auth/discord?redirect=%2Fdashboard&remember=1'] },
    'registered': '/dashboard',
    'registeredLifetime': 90 * 24 * 60 * 60,
    'signedIn': '/dashboard',
    'checkedLifetime': 90 * 24 * 60 * 60,
    'reset-en': '/dashboard',
    'reset-fr': '/fr/dashboard',
  })
}, 60_000)

test('with pages.remember never under a base, the pages show no box, the provider links carry remember=0, a checked box posted changes nothing, and home lands under the base', async () => {
  // An action posted from a French page under a base runs in the default locale: kaynooo/kayjs#905.
  const seen = await variant({ FIXTURE_HOME: '/dashboard', FIXTURE_REMEMBER: 'never', FIXTURE_BASE: '/app' })

  delete seen['reset-fr']

  expect(seen).toEqual({
    'signIn': { boxes: 0, links: ['/app/auth/discord?redirect=%2Fdashboard&remember=0'] },
    'register': { boxes: 0, links: ['/app/auth/discord?redirect=%2Fdashboard&remember=0'] },
    'registered': '/app/dashboard',
    'registeredLifetime': 24 * 60 * 60,
    'signedIn': '/app/dashboard',
    'checkedLifetime': 24 * 60 * 60,
    'reset-en': '/app/dashboard',
  })
}, 60_000)

test('with a prefix given to authPages alone, under a base, the pages are served there and every flow lands on home, createAuth taking the prefix from authPages', async () => {
  const seen = await variant({ FIXTURE_PREFIX: '/members', FIXTURE_BASE: '/app', FIXTURE_HOME: '/dashboard' })

  delete seen['reset-fr']

  expect(seen).toEqual({
    'signIn': { boxes: 2, links: ['/app/auth/discord?redirect=%2Fdashboard&remember=0'] },
    'register': { boxes: 1, links: ['/app/auth/discord?redirect=%2Fdashboard&remember=0'] },
    'registered': '/app/dashboard',
    'registeredLifetime': 24 * 60 * 60,
    'signedIn': '/app/dashboard',
    'checkedLifetime': 90 * 24 * 60 * 60,
    'reset-en': '/app/dashboard',
  })
}, 60_000)

test('with the app\'s credential rules, the register page hints, constrains and words a refusal by them', async () => {
  expect(await variant({ FIXTURE_RULES: '1' })).toEqual({
    hint: ['At least 12 characters'],
    minlength: '12',
    check: ['Add a digit.'],
    short: ['Use at least 12 characters.'],
  })
}, 60_000)

test('the admin pages and the impersonation banner link under the base and the prefix, and a member is refused', async () => {
  const seen = await variant({ FIXTURE_ADMIN: '1', FIXTURE_PREFIX: '/members', FIXTURE_BASE: '/app', FIXTURE_HOME: '/dashboard' })

  expect(seen).toMatchObject({
    tabs: ['/app/members/admin', '/app/members/admin/audit'],
    search: '/app/members/admin',
    refused: 403,
    home: '/app/dashboard',
    banner: ['/app/auth/stop-impersonating'],
    stopped: [303, '/app/members/admin'],
    back: ['/members/admin'],
  })
  expect((seen.list as string[])).toHaveLength(1)
  expect((seen.list as string[])[0]).toStartWith('/app/members/admin/users/')
}, 60_000)
