import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { streamOn } from '../src/check/stream-on'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('stream-on-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

const read = async (root: string, path: string) => Bun.file(join(root, path)).text()

describe('deprecated-stream-on', () => {
  it('rewrites on(fn) of a stream or socket bound in the file: an arrow\'s parameter, a function reference and a fence', async () => {
    const arrow = 'import { socket, stream } from \'kay\'\nimport * as api from \'./api\'\n\nconst feed = stream(api, \'/feed\')\nconst chat = socket(api, \'/chat\')\n\nfeed.on(item => console.log(item))\nchat.on((message) => {\n  console.log(message)\n})\nconst stop = feed.on(show)\n'
    const fence = '---\nimport { stream } from \'kay\'\nimport * as api from \'../api\'\n\nconst reader = stream(api, \'/feed\', { start: false })\nreader.on(v => seen.push(v))\n---\np x\n'
    const root = await project({ 'src/arrow.ts': arrow, 'src/routes/fence.kay': fence })

    try {
      const found = await streamOn(root, {})

      expect(found).toHaveLength(4)
      expect(found.every(one => one.code === 'deprecated-stream-on' && one.fixes?.[0]?.safe === true)).toBe(true)
      await applySafeFixes(root, found)
      expect(await read(root, 'src/arrow.ts')).toBe('import { socket, stream } from \'kay\'\nimport * as api from \'./api\'\n\nconst feed = stream(api, \'/feed\')\nconst chat = socket(api, \'/chat\')\n\nfeed.onData(({ value: item }) => console.log(item))\nchat.onData(({ value: message }) => {\n  console.log(message)\n})\nconst stop = feed.onData(({ value }) => show(value))\n')
      expect(await read(root, 'src/routes/fence.kay')).toBe(fence.replace('reader.on(v =>', 'reader.onData(({ value: v }) =>'))
      expect(await streamOn(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves other receivers alone: an emitter, a stream of another module, a name bound twice', async () => {
    const other = 'import { stream } from \'./mine\'\nimport { EventEmitter } from \'node:events\'\n\nconst emitter = new EventEmitter()\nconst mine = stream()\n\nemitter.on(\'x\', () => {})\nmine.on(v => v)\nprocess.on(\'exit\', () => {})\n'
    const twice = 'import { stream } from \'kay\'\nimport * as api from \'./api\'\n\nconst feed = stream(api, \'/a\')\n\nexport function again() {\n  const feed = new EventEmitter()\n\n  feed.on(v => v)\n}\n'
    const root = await project({ 'src/other.ts': other, 'src/twice.ts': twice })

    try {
      expect(await streamOn(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('wraps a callback that is no arrow of one plain parameter, and reports a spread or a callback naming `value` with no fix', async () => {
    const odd = 'import { stream } from \'kay\'\nimport * as api from \'./api\'\n\nconst feed = stream(api, \'/feed\')\n\nfeed.on(...handlers)\nfeed.on(function (item) { return item })\nfeed.on(async ({ id }) => id)\nfeed.on(handler(value))\nfeed.on((item: number) => item)\nfeed.on(() => ping())\n'
    const root = await project({ 'src/odd.ts': odd })

    try {
      const found = await streamOn(root, {})

      expect(found.map(one => one.fixes === undefined)).toEqual([true, false, false, true, false, false])
      await applySafeFixes(root, found)
      expect(await read(root, 'src/odd.ts')).toBe('import { stream } from \'kay\'\nimport * as api from \'./api\'\n\nconst feed = stream(api, \'/feed\')\n\nfeed.on(...handlers)\nfeed.onData(({ value }) => (function (item) { return item })(value))\nfeed.onData(async ({ value: { id } }) => id)\nfeed.on(handler(value))\nfeed.onData(({ value }) => ((item: number) => item)(value))\nfeed.onData(() => ping())\n')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('honours the level', async () => {
    const source = 'import { stream } from \'kay\'\nimport * as api from \'./api\'\n\nconst feed = stream(api, \'/feed\')\n\nfeed.on(item => item)\n'
    const root = await project({ 'src/feed.ts': source })

    try {
      expect(await streamOn(root, { lints: { 'deprecated-stream-on': 'allow' } })).toEqual([])
      expect(await streamOn(root, { lints: { 'deprecated-stream-on': 'deny' } })).toMatchObject([{ severity: 'error' }])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
