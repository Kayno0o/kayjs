import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { sizeLimits } from '../src/check/size-limits'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('size-limits-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

describe('deprecated-size-limits', () => {
  it('renames maxAttachmentBytes of ask and the maxSize map of an extension, and leaves what is not theirs', async () => {
    const asking = 'import { ask } from \'@kaynooo/kayjs-ai\'\n\nexport const read = (messages: never[]) => ask(messages, { maxAttachmentBytes: 5_000_000 })\n'
    const shorthand = 'import { ask } from \'@kaynooo/kayjs-ai\'\n\nconst maxAttachmentBytes = 1000\n\nexport const read = (messages: never[]) => ask(messages, { maxAttachmentBytes })\n'
    const namespaced = 'import * as ai from \'@kaynooo/kayjs-ai\'\n\nexport const read = (messages: never[]) => ai.ask(messages, { maxAttachmentBytes: 1 })\n'
    const fence = '--- server\nimport { ask } from \'@kaynooo/kayjs-ai\'\n\nexport const read = (messages: never[]) => ask(messages, { maxAttachmentBytes: 1 })\n---\np x\n'
    const clash = 'import { ask } from \'@kaynooo/kayjs-ai\'\n\nexport const read = (messages: never[]) => ask(messages, { maxAttachmentBytes: 1, maxSize: \'2mb\' })\n'
    const extension = 'import type { KayExtension } from \'kay/server\'\n\nexport const upload = (): KayExtension => ({ name: \'upload\', maxSize: { \'/upload\': \'8mb\' } })\n'
    const own = 'import { ask } from \'./mine\'\nimport type { KayExtension } from \'kay/server\'\n\nexport const read = ask([], { maxAttachmentBytes: 1 })\nexport const sized = { name: \'x\', maxSize: 5 }\nexport const scalar: KayExtension = { name: \'y\', maxSize: undefined }\n'
    const elsewhere = 'export const other = { name: \'z\', maxSize: { a: 1 } }\n'
    const root = await project({ 'src/asking.ts': asking, 'src/shorthand.ts': shorthand, 'src/namespaced.ts': namespaced, 'src/routes/fence.kay': fence, 'src/clash.ts': clash, 'src/extension.ts': extension, 'src/own.ts': own, 'src/elsewhere.ts': elsewhere })

    try {
      const found = await sizeLimits(root, {})

      expect(found.map(diagnostic => [diagnostic.file.slice(root.length + 1), diagnostic.line, diagnostic.fixes === undefined]).sort()).toEqual([
        ['src/asking.ts', 3, false],
        ['src/clash.ts', 3, true],
        ['src/extension.ts', 3, false],
        ['src/namespaced.ts', 3, false],
        ['src/routes/fence.kay', 4, false],
        ['src/shorthand.ts', 5, false],
      ])

      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'src/asking.ts')).text()).toBe(asking.replace('maxAttachmentBytes', 'maxSize'))
      expect(await Bun.file(join(root, 'src/shorthand.ts')).text()).toBe(shorthand.replace('{ maxAttachmentBytes })', '{ maxSize: maxAttachmentBytes })'))
      expect(await Bun.file(join(root, 'src/namespaced.ts')).text()).toBe(namespaced.replace('maxAttachmentBytes', 'maxSize'))
      expect(await Bun.file(join(root, 'src/routes/fence.kay')).text()).toBe(fence.replace('maxAttachmentBytes', 'maxSize'))
      expect(await Bun.file(join(root, 'src/extension.ts')).text()).toBe(extension.replace('maxSize', 'maxSizeByPath'))
      expect(await Bun.file(join(root, 'src/clash.ts')).text()).toBe(clash)
      expect(await Bun.file(join(root, 'src/own.ts')).text()).toBe(own)
      expect(await Bun.file(join(root, 'src/elsewhere.ts')).text()).toBe(elsewhere)
      expect((await sizeLimits(root, {})).map(diagnostic => diagnostic.file.slice(root.length + 1))).toEqual(['src/clash.ts'])
      expect(await sizeLimits(root, { lints: { 'deprecated-size-limits': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
