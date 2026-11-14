import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { guardOptions } from '../src/check/guard-options'
import { scratchDir } from './scratch'

async function fixed(files: Record<string, string>): Promise<{ text: Record<string, string>, found: Awaited<ReturnType<typeof guardOptions>> }> {
  const root = await scratchDir('guard-option-')

  try {
    await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

    const found = await guardOptions(root, {})

    await applySafeFixes(root, found)

    return { found, text: Object.fromEntries(await Promise.all(Object.keys(files).map(async path => [path, await Bun.file(join(root, path)).text()]))) }
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('deprecated-guard-option', () => {
  it('renames `guard` in the jobs and images of kay.config.ts, and in vitals()', async () => {
    const { found, text } = await fixed({
      'kay.config.ts': 'import { vitals } from \'kay/server\'\n\nexport default {\n  jobs: { guard },\n  images: { guard: [a, b], resolve },\n  extensions: [vitals({ prefix: \'/v\', guard: admin })],\n  other: { guard: 1 },\n}\n',
    })

    expect(found).toHaveLength(3)
    expect(text['kay.config.ts']).toBe('import { vitals } from \'kay/server\'\n\nexport default {\n  jobs: { guards: guard },\n  images: { guards: [a, b], resolve },\n  extensions: [vitals({ prefix: \'/v\', guards: admin })],\n  other: { guard: 1 },\n}\n')
  })

  it('writes `requireGuards` as `guards: { default }`', async () => {
    const { found, text } = await fixed({ 'kay.config.ts': 'export default { requireGuards: true }\n', 'other/kay.config.ts': 'export default { requireGuards: false }\n' })

    expect(found).toHaveLength(2)
    expect(text['kay.config.ts']).toBe('export default { guards: { default: \'closed\' } }\n')
    expect(text['other/kay.config.ts']).toBe('export default { guards: { default: \'open\' } }\n')
  })

  it('reports with no fix a `guard` beside a `guards`, and ignores a vitals() of another package', async () => {
    const { found, text } = await fixed({
      'kay.config.ts': 'import { vitals } from \'elsewhere\'\n\nexport default { jobs: { guard: a, guards: b }, extensions: [vitals({ guard: c })] }\n',
    })

    expect(found).toHaveLength(1)
    expect(found[0]?.fixes).toBeUndefined()
    expect(text['kay.config.ts']).toContain('guard: a, guards: b')
  })
})
