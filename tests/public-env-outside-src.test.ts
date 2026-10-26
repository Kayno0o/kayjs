import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { publicEnvOutsideSrc } from '../src/check/public-env-outside-src'
import { scratchDir } from './scratch'

const schema = 'import { defineEnv, s } from \'kay/server\'\nexport const env = defineEnv({ MAP_KEY: s.Public(s.String()) })\n'

async function project(files: Record<string, string>): Promise<string> {
  const dir = await scratchDir('public-env-outside-src-')

  for (const [name, source] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true })
    await writeFile(join(dir, name), source)
  }

  return dir
}

describe('the public-env-outside-src lint', () => {
  it('reports an s.Public field in a module outside src, at the field', async () => {
    const found = await publicEnvOutsideSrc(await project({ 'common/env.ts': schema, 'src/env.ts': schema }), {})

    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ code: 'public-env-outside-src', severity: 'warning', line: 2 })
    expect(found[0]!.file.endsWith('common/env.ts')).toBe(true)
  })

  it('leaves src, tests, declarations and files without a field', async () => {
    const dir = await project({ 'src/nested/env.ts': schema, 'common/env.test.ts': schema, 'common/env.d.ts': schema, 'common/other.ts': 'export const a = 1\n', 'node_modules/lib/env.ts': schema })

    expect(await publicEnvOutsideSrc(dir, {})).toEqual([])
  })

  it('follows the level set for it, and a kay-allow comment', async () => {
    const dir = await project({ 'common/env.ts': schema })

    expect(await publicEnvOutsideSrc(dir, { lints: { 'public-env-outside-src': 'allow' } })).toEqual([])
    expect((await publicEnvOutsideSrc(dir, { lints: { 'public-env-outside-src': 'deny' } }))[0]?.severity).toBe('error')
    expect(await publicEnvOutsideSrc(await project({ 'common/env.ts': 'export const env = defineEnv({\n  // kay-allow public-env-outside-src\n  MAP_KEY: s.Public(s.String()),\n})\n' }), {})).toEqual([])
  })
})
