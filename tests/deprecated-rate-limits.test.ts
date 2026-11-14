import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { authRateLimits } from '../src/check/auth-rate-limits'
import { applySafeFixes } from '../src/check/fixes'
import { rateEnforce } from '../src/check/rate-enforce'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('rate-limits-lint-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

describe('deprecated-rate-enforce', () => {
  it('renames enforce on a name bound once to rateLimit() of kay/server, in a module and a fence', async () => {
    const script = [
      'import { rateLimit } from \'kay/server\'',
      'import * as server from \'kay/server\'',
      '',
      'const visits = rateLimit(\'a\', { max: 1, window: \'1m\' })',
      'const other = server.rateLimit(\'b\', { max: 1, window: \'1m\' })',
      'export const run = async (ctx: never) => { await visits.enforce(ctx); await other.enforce(ctx) }',
      'export const own = (limit: { enforce: (c: never) => void }) => limit.enforce(1 as never)',
      '',
    ].join('\n')

    const page = '--- server\nimport { rateLimit } from \'kay/server\'\n\nconst limit = rateLimit(\'p\', { max: 2, window: \'1m\' })\nexport const go = (ctx: never) => limit.enforce(ctx)\n---\np x\n'
    const root = await project({ 'src/guard.ts': script, 'src/routes/page.kay': page, 'src/key.ts': 'import { limiter } from \'kay/server\'\nconst l = limiter({ max: 1, window: \'1m\' })\nexport const x = () => l.enforce(\'k\')\n' })
    const found = await rateEnforce(root, {})

    expect(found).toHaveLength(3)
    expect(found.every(one => one.code === 'deprecated-rate-enforce' && one.fixes?.[0]?.safe === true)).toBe(true)
    await applySafeFixes(root, found)
    expect(await Bun.file(join(root, 'src/guard.ts')).text()).toBe(script.replace('visits.enforce', 'visits.check').replace('other.enforce', 'other.check'))
    expect(await Bun.file(join(root, 'src/routes/page.kay')).text()).toBe(page.replace('limit.enforce', 'limit.check'))
    expect(await Bun.file(join(root, 'src/key.ts')).text()).toContain('l.enforce(\'k\')')
  })

  it('is silent when the lint is allowed or the name is bound twice', async () => {
    const twice = 'import { rateLimit } from \'kay/server\'\nlet a = rateLimit(\'a\', { max: 1, window: \'1m\' })\nexport const f = (c: never) => a.enforce(c)\n{ const a = 1 }\n'
    const root = await project({ 'src/a.ts': twice })

    expect(await rateEnforce(root, { lints: { 'deprecated-rate-enforce': 'allow' } })).toEqual([])
    expect(await rateEnforce(root, {})).toEqual([])
  })
})

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
  it('reports without a fix an object holding a comment', async () => {
    const root = await project({ 'src/a.ts': 'import { authCore } from \'@kayjs/auth\'\n\nexport const auth = authCore({ rateLimit: { /* keep */ signInAccount: { max: 2, window: \'1h\' } } } as never)\n' })
    const found = await authRateLimits(root, {})

    expect(found).toHaveLength(1)
    expect(found[0]!.fixes).toBeUndefined()
  })
})
