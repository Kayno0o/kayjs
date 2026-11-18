import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { invalidConfigValues, mergeBags, unknownConfigKeys } from '../src/config-shape'
import { checkSecret, readSecret } from '../src/server/secret'

describe('readSecret', () => {
  it('reads a value, a variable and a file, trimmed, and nothing from an empty or missing one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-secret-'))

    try {
      await writeFile(join(dir, 'key'), '  from-a-file\n')
      await writeFile(join(dir, 'empty'), '\n')
      process.env.KAY_SECRET_TEST = ' from-a-variable '

      expect(readSecret(' a-value ')).toBe('a-value')
      expect(readSecret({ env: 'KAY_SECRET_TEST' })).toBe('from-a-variable')
      expect(readSecret({ file: join(dir, 'key') })).toBe('from-a-file')
      expect(readSecret({ file: 'key' }, dir)).toBe('from-a-file')
      expect(readSecret('  ')).toBeUndefined()
      expect(readSecret({ env: 'KAY_SECRET_UNSET' })).toBeUndefined()
      expect(readSecret({ file: join(dir, 'empty') })).toBeUndefined()
      expect(readSecret({ file: join(dir, 'missing') })).toBeUndefined()
    }
    finally {
      delete process.env.KAY_SECRET_TEST
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses a secret that is none of the three shapes', () => {
    expect(checkSecret({ env: 'A' }, 'x')).toEqual({ env: 'A' })

    for (const bad of [5, null, [], {}, { env: '' }, { file: 3 }, { env: 'A', file: 'b' }, { path: 'x' }])
      expect(() => checkSecret(bad, 'x.secret')).toThrow('x.secret is a string')
  })

  it('stands in for a secret that gives nothing while a build verifies the executable', () => {
    process.env.KAY_BUILD_VERIFY = '1'

    try {
      const standIn = readSecret({ env: 'KAY_SECRET_UNSET' })

      expect(standIn).toHaveLength(36)
      expect(readSecret({ file: '/nowhere/secret' })).toBe(standIn)
      expect(readSecret('given')).toBe('given')
    }
    finally {
      delete process.env.KAY_BUILD_VERIFY
    }

    expect(readSecret({ env: 'KAY_SECRET_UNSET' })).toBeUndefined()
  })
})

describe('the config\'s secrets', () => {
  it('checks the keys and the values of proxy.key, mcp.token and metrics.token', () => {
    const config = { proxy: { key: { header: 'h', secret: { file: 'k' } } }, mcp: { token: { env: 'T' } }, ops: { metrics: { token: true } } }

    expect(unknownConfigKeys(config)).toEqual([])
    expect(invalidConfigValues(config)).toEqual([])
    expect(unknownConfigKeys({ mcp: { tokens: true } })).toHaveLength(1)
    expect(unknownConfigKeys({ proxy: { key: { header: 'h', secrets: 'x' } } })).toHaveLength(1)
    expect(invalidConfigValues({ mcp: { token: 5 } })).toHaveLength(1)
    expect(invalidConfigValues({ ops: { metrics: { token: false } } })).toHaveLength(1)
  })

  it('merges the options of a code call into mcp and proxy, a level deeper than the other keys', () => {
    const file = { mcp: { path: '/tools' }, proxy: { hops: 1, key: { header: 'x-key' } }, lang: 'en' }
    const merged = mergeBags(file, { mcp: { token: 'a-token-0123456789' }, proxy: { key: { secret: 's' } }, lang: undefined })

    expect(merged).toEqual({ mcp: { path: '/tools', token: 'a-token-0123456789' }, proxy: { hops: 1, key: { header: 'x-key', secret: 's' } }, lang: 'en' })
    expect(mergeBags({ mcp: true, proxy: 1 }, { mcp: { token: 't' }, proxy: { key: { header: 'h' } } })).toEqual({ mcp: { token: 't' }, proxy: { key: { header: 'h' } } })
  })
})
