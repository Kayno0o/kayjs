import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { streamOpen } from '../src/check/stream-on'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('stream-open-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

const read = async (root: string, path: string) => Bun.file(join(root, path)).text()

describe('deprecated-stream-open', () => {
  it('gives onOpen an object: an arrow\'s plain parameter, a function reference, and nothing for the rest', async () => {
    const source = 'import { socket, stream } from \'kay\'\nimport * as api from \'./api\'\n\nconst feed = stream(api, \'/feed\')\nconst chat = socket(api, \'/chat\')\n\nfeed.onOpen(again => again && refetch())\nchat.onOpen((again) => {\n  if (again)\n    refetch()\n})\nfeed.onOpen(rejoin)\nchat.onOpen(() => chat.send(1))\nfeed.onOpen(({ reconnected }) => reconnected)\nfeed.onOpen((again: boolean) => again)\nfeed.onOpen((event: { reconnected: boolean }) => event)\nconst emitter = new EventEmitter()\nemitter.onOpen(x => x)\n'
    const root = await project({ 'src/open.ts': source })

    try {
      const found = await streamOpen(root, {})

      expect(found.map(one => one.fixes?.[0]?.safe ?? null)).toEqual([true, true, null, null])
      await applySafeFixes(root, found)
      expect(await read(root, 'src/open.ts')).toBe(source.replace('onOpen(again => again', 'onOpen(({ reconnected: again }) => again').replace('onOpen((again) => {', 'onOpen(({ reconnected: again }) => {'))
      expect(await streamOpen(root, { lints: { 'deprecated-stream-open': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
