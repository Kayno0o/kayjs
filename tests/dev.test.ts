import type { Subprocess } from 'bun'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { KayCompileError } from '../src/build/transform'
import { dev } from '../src/dev'
import { bootFailure } from '../src/server/dev'

async function until(condition: () => boolean, timeout = 5000) {
  for (const start = Date.now(); !condition(); await Bun.sleep(20)) {
    if (Date.now() - start > timeout)
      throw new Error('timed out')
  }
}

async function firstEvent(response: Response): Promise<string> {
  const reader = response.body!.getReader()
  const { value } = await reader.read()

  await reader.cancel()

  return typeof value === 'string' ? value : new TextDecoder().decode(value)
}

describe('kay dev', () => {
  it('restarts the server on a change and keeps the generated types current', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-dev-'))
    const children: Subprocess[] = []

    await Bun.write(join(root, 'src/server.ts'), 'setInterval(() => undefined, 1000)\n')
    await Bun.write(join(root, 'src/routes/index.kay'), 'p Home\n')
    const stop = await dev(root, { onRestart: child => children.push(child) })

    try {
      expect(children).toHaveLength(1)
      expect(await Bun.file(join(root, '.kay/types/src/routes/index.kay.tsx')).exists()).toBe(true)

      await Bun.write(join(root, 'src/routes/about.kay'), 'p About\n')
      await until(() => children.length === 2)

      expect(children[0]!.killed).toBe(true)
      // The new server starts first; the types follow it.
      await until(() => existsSync(join(root, '.kay/types/src/routes/about.kay.tsx')))
    }
    finally {
      await stop()
      await rm(root, { recursive: true, force: true })
    }
    expect(children.at(-1)!.killed).toBe(true)
  })

  it('serves the compile errors of a project that failed to boot, and the reload stream', async () => {
    const source = 'p ok\nelse\n  p no\n'
    const error = new KayCompileError([{ file: join(process.cwd(), 'src/broken.kay'), source, start: 5, end: 9, message: '`else` must directly follow an `if`' }])
    const app = bootFailure(error, process.cwd())
    const page = await app.handle(new Request('http://localhost/any/page'))
    const html = await page.text()

    expect(page.status).toBe(500)
    expect(html).toContain('<h2>src/broken.kay:2:1</h2>')
    expect(html).toContain('2 | else\n  | ^^^^')
    expect(html).toContain('new EventSource("/_kay/dev/events")')

    const events = await app.handle(new Request('http://localhost/_kay/dev/events'))

    expect(events.headers.get('content-type')).toBe('text/event-stream')
    expect(await firstEvent(events)).toMatch(/^retry: 100\nevent: boot\ndata: [\w-]+\n\n$/)
  })
})
