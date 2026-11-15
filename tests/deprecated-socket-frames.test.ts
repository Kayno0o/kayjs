import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { socketFrames } from '../src/check/socket-frames'
import { scratchDir } from './scratch'

async function fixed(files: Record<string, string>) {
  const root = await scratchDir('socket-frames-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  const found = await socketFrames(root, {})

  await applySafeFixes(root, found)

  return { root, found, read: async (path: string) => Bun.file(join(root, path)).text() }
}

describe('deprecated-socket-frames', () => {
  it('sends the value itself where a handler sent its JSON text', async () => {
    const { root, found, read } = await fixed({
      'src/api/chat.ts': 'import { api } from \'kay/server\'\n\nexport default api().ws(\'/\', {\n  open(ws) {\n    ws.send(JSON.stringify({ hello: 1 }))\n  },\n  message(socket, body) {\n    socket.send(JSON.stringify(body), true)\n    socket.publish(\'room\', JSON.stringify(body))\n    socket.send(\'plain\')\n  },\n})\n',
    })

    try {
      expect(found).toHaveLength(3)
      expect(found.every(one => one.code === 'deprecated-socket-frames' && one.fixes?.[0]?.safe === true)).toBe(true)
      expect(await read('src/api/chat.ts')).toBe('import { api } from \'kay/server\'\n\nexport default api().ws(\'/\', {\n  open(ws) {\n    ws.send({ hello: 1 })\n  },\n  message(socket, body) {\n    socket.send(body, true)\n    socket.publish(\'room\', body)\n    socket.send(\'plain\')\n  },\n})\n')
      expect(await socketFrames(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves a send outside a websocket handler, and a file with no api', async () => {
    const { root, found } = await fixed({
      'src/api/other.ts': 'import { api } from \'kay/server\'\n\nexport default api().get(\'/\', ({ ws }) => ws.send(JSON.stringify(1)))\n',
      'src/plain.ts': 'import { Elysia } from \'elysia\'\n\nexport default new Elysia().ws(\'/\', { message(ws) { ws.send(JSON.stringify(1)) } })\n',
    })

    try {
      expect(found).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
