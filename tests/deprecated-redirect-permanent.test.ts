import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { redirectPermanent } from '../src/check/redirect-permanent'
import { scratchDir } from './scratch'

async function project(config: string): Promise<string> {
  const root = await scratchDir('redirect-permanent-')

  await Bun.write(join(root, 'kay.config.ts'), config)

  return root
}

describe('deprecated-redirect-permanent', () => {
  it('writes status: 307 for permanent: false, drops permanent: true and one beside a status that agrees', async () => {
    const source = 'import { defineConfig } from \'kay\'\n\nconst redirects = {\n  \'/a\': { to: \'/x\', permanent: false },\n  \'/b\': { to: \'/x\', permanent: true },\n  \'/c\': { to: \'/x\', permanent: true, status: 301 },\n  \'/d\': { to: \'/x\', status: 302, permanent: false },\n  \'/e\': { to: \'/x\', status: 308 },\n  \'/f\': { to: \'/x\', permanent: false, status: 301 },\n  \'/g\': \'/x\',\n}\n\nexport default defineConfig({ redirects })\n'
    const root = await project(source)

    try {
      const found = redirectPermanent(root, {})

      expect(found.map(one => [one.line, one.fixes?.[0]?.safe ?? null])).toEqual([[4, true], [5, true], [6, true], [7, true], [9, null]])
      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'kay.config.ts')).text()).toBe(source
        .replace('permanent: false },\n  \'/b', 'status: 307 },\n  \'/b')
        .replace(', permanent: true },', ' },')
        .replace('permanent: true, status: 301', 'status: 301')
        .replace('status: 302, permanent: false', 'status: 302'))
      expect(redirectPermanent(root, { lints: { 'deprecated-redirect-permanent': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a permanent that contradicts its status with no fix', async () => {
    const source = 'export default {\n  redirects: {\n    \'/e\': { status: 410, permanent: true },\n  },\n}\n'
    const root = await project(source)

    try {
      const found = redirectPermanent(root, {})

      expect(found).toHaveLength(1)
      expect(found[0]!.fixes).toBeUndefined()
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports nothing for a config that never says permanent', async () => {
    const root = await project('export default { redirects: { \'/a\': { to: \'/b\', status: 307 }, \'/gone\': { status: 410 } } }\n')

    try {
      expect(redirectPermanent(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
