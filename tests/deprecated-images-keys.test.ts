import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { imagesKeys } from '../src/check/images-keys'
import { scratchDir } from './scratch'

async function fixed(files: Record<string, string>): Promise<{ text: Record<string, string>, found: Awaited<ReturnType<typeof imagesKeys>> }> {
  const root = await scratchDir('images-keys-')

  try {
    await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

    const found = await imagesKeys(root, {})

    await applySafeFixes(root, found)

    return { found, text: Object.fromEntries(await Promise.all(Object.keys(files).map(async path => [path, await Bun.file(join(root, path)).text()]))) }
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('deprecated-images-keys', () => {
  it('groups the flat keys under remote, formats and limits and keeps the others', async () => {
    const { found, text } = await fixed({
      'kay.config.ts': 'export default { images: { remoteMaxSize: \'10mb\', ttl: \'7d\', remoteTimeout: \'30s\', avif: false, quality: 70, maxVariants: 10, queue: false } }\n',
    })

    expect(found).toHaveLength(6)
    expect(text['kay.config.ts']).toBe('export default { images: { remote: { maxSize: \'10mb\', timeout: \'30s\' }, ttl: \'7d\', formats: { avif: false, quality: 70 }, limits: { variants: 10, queue: false } } }\n')
  })

  it('reports with no fix where the group is already written or a key is shorthand', async () => {
    const { found, text } = await fixed({
      'kay.config.ts': 'export default { images: { remote: { hosts: [] }, remoteMaxSize: \'10mb\' } }\n',
      'a/kay.config.ts': 'const queue = 3\nexport default { images: { queue } }\n',
    })

    expect(found).toHaveLength(2)
    expect(found.every(one => one.fixes === undefined)).toBe(true)
    expect(text['kay.config.ts']).toContain('remoteMaxSize')
    expect(text['a/kay.config.ts']).toContain('{ queue }')
  })

  it('leaves the grouped form, other files and other keys alone', async () => {
    const { found } = await fixed({
      'kay.config.ts': 'export default { images: { remote: { maxSize: \'1mb\' }, formats: { avif: false }, limits: { queue: 1 } }, queue: 1 }\n',
      'src/other.ts': 'export default { images: { queue: 1 } }\n',
    })

    expect(found).toEqual([])
  })
})
