import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { deprecatedConfigKeys } from '../src/check/deprecated-config-keys'
import { applySafeFixes } from '../src/check/fixes'
import { scratchDir } from './scratch'

async function project(config: string): Promise<string> {
  const root = await scratchDir('config-keys-')

  await Bun.write(join(root, 'kay.config.ts'), config)

  return root
}

describe('deprecated-config-keys', () => {
  it('renames apiPath, subset and weight of a Fontsource font, and writes perMinute as a rate', async () => {
    const source = 'import { defineConfig } from \'kay\'\n\nconst serve = { apiPath: \'/v1\' }\n\nexport default defineConfig({\n  serve,\n  live: { connections: 3, perMinute: 60 },\n  fonts: [\n    { fontsource: \'@fontsource/inter\', subset: \'latin\', weight: 400 },\n    { fontsource: \'@fontsource/inter\', subset: [\'latin\', \'greek\'], weight: [400, 700] },\n    { family: \'Mine\', src: \'a.woff2\', weight: 400 },\n  ],\n})\n'
    const root = await project(source)

    try {
      const found = deprecatedConfigKeys(root, {})

      expect(found.map(one => [one.line, one.fixes?.[0]?.safe ?? null])).toEqual([[3, true], [7, true], [9, true], [9, true], [10, true], [10, true]])
      expect(found.every(one => one.code === 'deprecated-config-keys')).toBe(true)
      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'kay.config.ts')).text()).toBe('import { defineConfig } from \'kay\'\n\nconst serve = { apiPrefix: \'/v1\' }\n\nexport default defineConfig({\n  serve,\n  live: { connections: 3, rate: { max: 60, window: \'1m\' } },\n  fonts: [\n    { fontsource: \'@fontsource/inter\', subsets: [\'latin\'], weights: [400] },\n    { fontsource: \'@fontsource/inter\', subsets: [\'latin\', \'greek\'], weights: [400, 700] },\n    { family: \'Mine\', src: \'a.woff2\', weight: 400 },\n  ],\n})\n')
      expect(deprecatedConfigKeys(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a key beside its new name, or with a value it cannot move, with no fix', async () => {
    const root = await project('const per = 5\n\nexport default {\n  serve: { apiPath: \'/v1\', apiPrefix: \'/v1\' },\n  live: { perMinute: per },\n  fonts: [{ fontsource: \'@fontsource/inter\', subset: pick() }],\n}\n')

    try {
      const found = deprecatedConfigKeys(root, {})

      expect(found).toHaveLength(3)
      expect(found.every(one => one.fixes === undefined)).toBe(true)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports nothing for the new names, and nothing at allow', async () => {
    const clean = await project('export default { serve: { apiPrefix: \'/v1\' }, live: { rate: { max: 1, window: \'1m\' } }, fonts: [{ fontsource: \'@fontsource/inter\', subsets: [\'latin\'] }] }\n')
    const old = await project('export default { serve: { apiPath: \'/v1\' } }\n')

    try {
      expect(deprecatedConfigKeys(clean, {})).toEqual([])
      expect(deprecatedConfigKeys(old, { lints: { 'deprecated-config-keys': 'allow' } })).toEqual([])
    }
    finally {
      await Promise.all([rm(clean, { recursive: true, force: true }), rm(old, { recursive: true, force: true })])
    }
  })
})
