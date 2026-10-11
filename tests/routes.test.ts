import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { scratchDir } from './scratch'

const cli = join(import.meta.dir, '..', 'src', 'cli.ts')

describe('kay routes', () => {
  it('lists each route with the file serving it, its methods, layouts and guards, the prerendered pages and kay\'s own', async () => {
    const root = await scratchDir('routes-')

    await Promise.all([
      Bun.write(join(root, 'kay.config.ts'), 'export default { requireGuards: true, publicEnv: {}, redirects: { \'/old\': \'/\', \'/tmp\': { to: \'/\', permanent: false } } }\n'),
      Bun.write(join(root, 'src/routes/_layout.kay'), 'slot\n'),
      Bun.write(join(root, 'src/routes/index.kay'), '--- server\nimport { action } from \'kay/server\'\n\nexport const page = { guards: false }\nexport const add = action(() => {})\n---\nh1 Home\n'),
      Bun.write(join(root, 'src/routes/admin/_guard.ts'), 'import { guard } from \'kay\'\n\nexport default guard(() => {})\n'),
      Bun.write(join(root, 'src/routes/admin/report.kay'), '--- server\nexport const page = { prerender: true }\n---\nh1 Report\n'),
      Bun.write(join(root, 'src/routes/posts/[slug].kay'), 'h1 Post\n'),
      Bun.write(join(root, 'src/routes/llms.txt.ts'), 'export function GET() {\n  return \'hi\'\n}\n'),
      Bun.write(join(root, 'src/api/items.ts'), 'import { Elysia } from \'elysia\'\nimport { api } from \'kay/server\'\n\napi({ guards: false })\n\nexport default new Elysia().get(\'/\', () => []).post(\'/:id\', () => 1)\n'),
      Bun.write(join(root, 'src/api/broken.ts'), 'throw new Error(\'no database\')\n'),
    ])

    try {
      const child = Bun.spawn([process.execPath, cli, 'routes'], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
      const [listing, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      const lines = listing.trim().split('\n').map(line => line.trim().replaceAll(/ {2,}/g, ' | '))

      expect(errors).toBe('')
      expect(code).toBe(0)
      expect(lines).toEqual(expect.arrayContaining([
        'GET | /admin/report | page | src/routes/admin/report.kay, prerendered',
        'layouts src/routes/_layout.kay',
        'guards | src/routes/admin/_guard.ts',
        'GET | / | page | src/routes/index.kay, open',
        'POST | /_kay/action/src/routes/index.kay/add | action | src/routes/index.kay add',
        'GET | /posts/:slug | page | src/routes/posts/[slug].kay, 403: no guard under requireGuards',
        'GET | /llms.txt | endpoint | src/routes/llms.txt.ts, 403: no guard under requireGuards',
        'GET | /api/items | api | src/api/items.ts, open',
        'POST | /api/items/:id | api | src/api/items.ts, open',
        '? | /api/broken/* | api | src/api/broken.ts, not loaded: no database, 403: no guard under requireGuards',
        'GET | /old | redirect | 308 to /',
        'GET | /tmp | redirect | 307 to /',
        'GET | /_kay/health | kay | health check',
        'GET | /_kay/env.js | kay | public environment',
      ]))
      expect(listing).not.toContain('/sitemap.xml')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
