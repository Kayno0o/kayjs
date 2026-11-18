import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { authRateLimits } from '../src/check/auth-rate-limits'
import { applySafeFixes } from '../src/check/fixes'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('rate-limits-lint-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

describe('deprecated-auth-rate-limits', () => {
  const call = (limits: string) => `import { authCore } from '@kayjs/auth'\n\nexport const auth = authCore({ rateLimit: ${limits} } as never)\n`

  it('groups the flat keys by feature and keeps the other keys', async () => {
    const root = await project({
      'src/auth.ts': call('{ register: { max: 3, window: \'1h\' }, signIn: { max: 20, window: \'15m\' }, forgotAccount: [{ max: 1, window: \'1d\' }], signInAccount: { max: 2, window: \'1h\' }, oauthToken: { max: 9, window: \'1m\' }, oauthRegisterAll: { max: 5, window: \'1h\' } }'),
    })

    const found = await authRateLimits(root, {})

    expect(found).toHaveLength(5)
    expect(found.filter(one => one.fixes?.[0]?.safe === true)).toHaveLength(1)
    await applySafeFixes(root, found)
    expect(await Bun.file(join(root, 'src/auth.ts')).text()).toBe(call('{ register: { max: 3, window: \'1h\' }, signIn: { ip: { max: 20, window: \'15m\' }, account: { max: 2, window: \'1h\' } }, forgot: { account: [{ max: 1, window: \'1d\' }] }, oauth: { token: { max: 9, window: \'1m\' }, registerAll: { max: 5, window: \'1h\' } } }'))
  })

  it('leaves a grouped object alone, and reports without a fix where it cannot rewrite', async () => {
    const grouped = call('{ signIn: { ip: { max: 20, window: \'15m\' }, account: { max: 2, window: \'1h\' } } }')
    const spread = call('{ ...base, signInAccount: { max: 2, window: \'1h\' } }')
    const clash = call('{ signIn: { account: { max: 1, window: \'1h\' } }, signInAccount: { max: 2, window: \'1h\' } }')
    const root = await project({ 'src/grouped.ts': grouped, 'src/spread.ts': spread, 'src/clash.ts': clash, 'src/other.ts': 'export const x = { rateLimit: { signInAccount: 1 } }\n' })
    const found = await authRateLimits(root, {})

    expect(found.map(one => one.file.split('/').pop()).toSorted()).toEqual(['clash.ts', 'spread.ts'])
    expect(found.every(one => one.fixes === undefined)).toBe(true)
  })
})

describe('deprecated-auth-rate-limits comments', () => {
  it('keeps a comment beside the key it moves', async () => {
    const root = await project({ 'src/a.ts': 'import { authCore } from \'@kayjs/auth\'\n\nexport const auth = authCore({ rateLimit: { /* keep */ signInAccount: { max: 2, window: \'1h\' } } } as never)\n' })
    const found = await authRateLimits(root, {})

    expect(found).toHaveLength(1)
    await applySafeFixes(root, found)
    expect(await Bun.file(join(root, 'src/a.ts')).text()).toContain('{ /* keep */ signIn: { account: { max: 2, window: \'1h\' } } }')
  })
})

describe('deprecated-auth-rate-limits layout and call shapes', () => {
  it('rewrites only the keys it moves: the order, the layout and the comments between the others stay', async () => {
    const before = [
      'import { authCore } from \'@kayjs/auth\'',
      '',
      'export const auth = authCore({',
      '  rateLimit: {',
      '    // sign-up is rare',
      '    register: { max: 3, window: \'1h\' },',
      '    signInAccount: { max: 2, window: \'1h\' },',
      '    // the address',
      '    signIn: { max: 20, window: \'15m\' },',
      '    link: { max: 9, window: \'1h\' },',
      '  },',
      '} as never)',
      '',
    ].join('\n')

    const root = await project({ 'src/a.ts': before })
    const found = await authRateLimits(root, {})

    await applySafeFixes(root, found)

    expect(await Bun.file(join(root, 'src/a.ts')).text()).toBe(before
      .replace('    signInAccount: { max: 2, window: \'1h\' },', '    signIn: { account: { max: 2, window: \'1h\' }, ip: { max: 20, window: \'15m\' } },')
      .replace('    signIn: { max: 20, window: \'15m\' },\n', ''))
  })

  it('reads authCore through a namespace import, satisfies and a .kay fence', async () => {
    const root = await project({
      'src/ns.ts': 'import * as kauth from \'@kayjs/auth\'\n\nexport const a = kauth.authCore({ rateLimit: { forgotAccount: { max: 1, window: \'1d\' } } })\n',
      'src/sat.ts': 'import { auth } from \'@kayjs/auth\'\n\nexport const a = auth({ rateLimit: { inviteAddress: { max: 1, window: \'1d\' } } } satisfies object)\n',
      'src/routes/page.kay': '--- server\nimport { authCore } from \'@kayjs/auth\'\n\nconst a = authCore({ rateLimit: { oauthToken: { max: 1, window: \'1m\' } } } as never)\n---\np x\n',
    })

    const found = await authRateLimits(root, {})

    expect(found).toHaveLength(3)
    await applySafeFixes(root, found)
    expect(await Bun.file(join(root, 'src/ns.ts')).text()).toContain('rateLimit: { forgot: { account: { max: 1, window: \'1d\' } } }')
    expect(await Bun.file(join(root, 'src/sat.ts')).text()).toContain('rateLimit: { invite: { address: { max: 1, window: \'1d\' } } }')
    expect(await Bun.file(join(root, 'src/routes/page.kay')).text()).toContain('rateLimit: { oauth: { token: { max: 1, window: \'1m\' } } }')
  })
})
