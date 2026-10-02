import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'

const root = join(import.meta.dir, 'fixtures/islands')

describe('kay build', () => {
  it('bundles the islands for production and writes the manifest a server boots from', async () => {
    try {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'build', root], { stdout: 'pipe', stderr: 'pipe' })
      const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
      const manifest = await Bun.file(join(root, '.kay/client/manifest.json')).json() as { entry: string, islands: Record<string, string[]> }
      const entry = await Bun.file(join(root, '.kay/client/dist', manifest.entry.slice('/_kay/'.length))).text()

      expect(code).toBe(0)
      expect(errors).toStartWith('built 1 island in ')
      expect(Object.keys(manifest.islands)).toEqual(['counter.kay'])
      // Minified: no line of the bundle is indented.
      expect(entry).not.toContain('\n  ')
    }
    finally {
      await rm(join(root, '.kay'), { recursive: true, force: true })
    }
  })
})
