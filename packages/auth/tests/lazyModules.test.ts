import { describe, expect, test } from 'bun:test'

interface Loaded {
  packages: string[]
  modules: string[]
}

// Not listed: captcha, breached, mail, gate, memoryStore and the OAuth client, providers and refresher are exported from `index.ts` as values and cost about 1.4 MB of 60 together, with no measurable load time (#2070), so they stay eager. The authorize mount modules are small and read by sync `Auth` methods.
// What each feature reads: its own modules, and the packages only it needs.
const FEATURES = {
  password: { modules: ['password.ts'], packages: [] },
  passkeys: { modules: ['passkeys.ts', 'webauthn.ts'], packages: ['@simplewebauthn/server'] },
  twoFactor: { modules: ['twoFactor.ts', 'totp.ts'], packages: [] },
  organizations: { modules: ['organizations.ts'], packages: [] },
  admin: { modules: ['admin.ts'], packages: [] },
  oauth: { modules: ['oauth/flow.ts'], packages: [] },
  oauthServer: { modules: ['authorize/clients.ts', 'authorize/grants.ts', 'authorize/register.ts', 'authorize/request.ts', 'authorize/token.ts'], packages: [] },
  forwardAuth: { modules: ['forwardRoutes.ts'], packages: [] },
  bearer: { modules: ['bearer.ts'], packages: [] },
  erase: { modules: ['erase.ts'], packages: [] },
} as const

type Feature = keyof typeof FEATURES

async function loaded(scenario: string): Promise<Loaded> {
  const run = Bun.spawn([process.execPath, `${import.meta.dir}/probes/loaded.ts`, scenario], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])

  expect(err).toBe('')

  return JSON.parse(out.trim().split('\n').pop()!) as Loaded
}

function loadsOf(result: Loaded, feature: Feature): boolean {
  const { modules, packages } = FEATURES[feature]

  return modules.some(module => result.modules.includes(module)) || packages.some(name => result.packages.includes(name))
}

// A scenario drives one feature of an app and no other.
const SCENARIOS: Record<string, { uses: Feature[] }> = {
  minimal: { uses: ['password'] },
  pages: { uses: [] },
  forwardAuth: { uses: ['forwardAuth'] },
  bearer: { uses: ['bearer'] },
  bearerIssued: { uses: ['password', 'bearer'] },
  forwardUnused: { uses: [] },
  forwardReturn: { uses: [] },
  switchesOff: { uses: [] },
  passkeys: { uses: ['password', 'passkeys'] },
  twoFactor: { uses: ['password', 'twoFactor'] },
  organizations: { uses: ['password', 'organizations'] },
  admin: { uses: ['password', 'admin', 'erase'] },
  oauth: { uses: ['oauth'] },
  oauthServer: { uses: ['oauthServer'] },
}

describe('a feature an app does not use is not loaded', () => {
  for (const [scenario, { uses }] of Object.entries(SCENARIOS)) {
    test(scenario, async () => {
      const result = await loaded(scenario)
      const used = new Set<Feature>(uses)

      expect(result.packages).toContain('elysia')

      for (const feature of Object.keys(FEATURES) as Feature[]) {
        if (used.has(feature))
          expect({ scenario, feature, loaded: loadsOf(result, feature) }).toEqual({ scenario, feature, loaded: true })
        else
          expect({ scenario, feature, loaded: loadsOf(result, feature) }).toEqual({ scenario, feature, loaded: false })
      }
    })
  }

  test('an app with no passkey and no OAuth loads neither simplewebauthn nor jose', async () => {
    const result = await loaded('minimal')

    expect(result.packages).not.toContain('@simplewebauthn/server')
    expect(result.packages).not.toContain('jose')
  })
})
