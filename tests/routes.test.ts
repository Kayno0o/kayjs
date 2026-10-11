import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { scratchDir } from './scratch'

const cli = join(import.meta.dir, '..', 'src', 'cli.ts')

describe('kay routes', () => {
  it('lists each route with the file serving it, its methods, layouts and guards, the prerendered pages, each locale\'s copy, the libraries\' and kay\'s own, in order', async () => {
    const root = await scratchDir('routes-')
    const config = [
      'import { Elysia } from \'elysia\'\n',
      'const lib = { name: \'lib\', api: { dir: \'lib/api\', prefix: \'lib\' }, server: new Elysia().get(\'/hooked\', () => 1) }',
      'const built = { name: \'built\', server: () => new Elysia() }\n',
      'export default { requireGuards: true, publicEnv: {}, extensions: [lib, built], i18n: { locales: [\'en\', \'fr\'], defaultLocale: \'en\', paths: { \'/about\': { fr: \'/a-propos\' } } }, redirects: { \'/old\': \'/\', \'/tmp\': { to: \'/\', permanent: false } } }\n',
    ]

    await Promise.all([
      Bun.write(join(root, 'kay.config.ts'), config.join('\n')),
      Bun.write(join(root, 'src/server.ts'), 'export {}\n'),
      Bun.write(join(root, 'src/routes/about.kay'), '--- server\nexport const page = { guards: false }\n---\nh1 About\n'),
      Bun.write(join(root, 'src/routes/items/[id=integer].kay'), '--- server\nconst ids = [{ id: 1 }]\n\nexport const page = { guards: false, prerender: ids }\n---\nh1 Item\n'),
      Bun.write(join(root, 'src/api/chat.ts'), 'import { Elysia } from \'elysia\'\n\nconsole.log(\'connecting\')\n\nexport default new Elysia().ws(\'/\', { message() {} }).options(\'/\', () => \'\')\n'),
      Bun.write(join(root, 'src/api/exits.ts'), 'process.exit(7)\n'),
      Bun.write(join(root, 'lib/api/_guard.ts'), 'import { guard } from \'kay\'\n\nexport default guard(() => {})\n'),
      Bun.write(join(root, 'lib/api/session.ts'), 'import { Elysia } from \'elysia\'\n\nexport default new Elysia().get(\'/\', () => 1)\n'),
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

      expect(errors).toBe('connecting\n')
      expect(code).toBe(0)
      expect(lines).toEqual([
        'GET | /about | page | src/routes/about.kay, en, open',
        'layouts src/routes/_layout.kay',
        'GET | /fr/a-propos | page | src/routes/about.kay, fr, open',
        'GET | /admin/report | page | src/routes/admin/report.kay, en, prerendered',
        'layouts src/routes/_layout.kay',
        'guards | src/routes/admin/_guard.ts',
        'GET | /fr/admin/report | page | src/routes/admin/report.kay, fr, prerendered',
        'GET | / | page | src/routes/index.kay, en, open',
        'layouts src/routes/_layout.kay',
        'GET | /fr | page | src/routes/index.kay, fr, open',
        'POST | /_kay/action/src/routes/index.kay/add | action | src/routes/index.kay add',
        'GET | /items/:id=integer | page | src/routes/items/[id=integer].kay, en, prerendered as its prerender setting lists, open',
        'layouts src/routes/_layout.kay',
        'GET | /fr/items/:id=integer | page | src/routes/items/[id=integer].kay, fr, prerendered as its prerender setting lists, open',
        'GET | /posts/:slug | page | src/routes/posts/[slug].kay, en, 403: no guard under requireGuards',
        'layouts src/routes/_layout.kay',
        'GET | /fr/posts/:slug | page | src/routes/posts/[slug].kay, fr, 403: no guard under requireGuards',
        'GET | /llms.txt | endpoint | src/routes/llms.txt.ts, 403: no guard under requireGuards',
        'GET | /api/lib/session | api | lib/api/session.ts',
        'guards | lib/api/_guard.ts',
        '? | /api/broken/* | api | src/api/broken.ts, not loaded: no database, 403: no guard under requireGuards',
        'WS | /api/chat | api | src/api/chat.ts, 403: no guard under requireGuards',
        'OPTIONS | /api/chat | api | src/api/chat.ts, 403: no guard under requireGuards',
        '? | /api/exits/* | api | src/api/exits.ts, not loaded: it calls process.exit(7), 403: no guard under requireGuards',
        'GET | /api/items | api | src/api/items.ts, open',
        'POST | /api/items/:id | api | src/api/items.ts, open',
        'GET | /hooked | plugin | the extension lib',
        'GET | /old | redirect | 308 to /',
        'GET | /tmp | redirect | 307 to /',
        'GET | /_kay/health | kay | health check',
        'GET | /_kay/env.js | kay | public environment',
        'GET | /_kay/* | kay | build files',
        'GET | /_kay/image | kay | image variants',
        'GET | /_kay/card | kay | share cards',
        'GET | /_kay/files/* | kay | stored files',
        'POST | /_kay/error | kay | browser error reports',
        'GET | /favicon.ico | kay | favicon, unless the app serves it',
        'GET | /apple-touch-icon.png | kay | favicon, unless the app serves it',
        'GET | /icon-192.png | kay | favicon, unless the app serves it',
        'GET | /icon-512.png | kay | favicon, unless the app serves it',
        'GET | /manifest.webmanifest | kay | favicon, unless the app serves it',
        'GET | /favicon.svg | kay | favicon, unless the app serves it',
        'GET | /sw.js | kay | service worker',
        '',
        'Not listed: the routes src/server.ts and the extension built\'s server plugin add when the server starts.',
      ])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
