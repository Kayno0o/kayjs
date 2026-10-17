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
