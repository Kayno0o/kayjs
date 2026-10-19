import type { Site } from './sites'
import { createHmac } from 'node:crypto'
import { join } from 'node:path'

// What a Set-Cookie header says after the cookie itself, which a request does not send.
const COOKIE_ATTRIBUTES = /;.*/s

// Copy to sites.config.ts (gitignored) or pass `--config <file>`: each entry is a site that ran on Astro, or on a stack `before` names, then moved to kay in the same repository.
export default [
  {
    name: 'bakery',
    repo: '../../../bakery',
    astro: 'a1b2c3d',
    pages: ['/', '/menu', '/contact'],
    loaded: ['/', '/menu'],
    dev: {
      page: '/menu',
      astro: { template: { file: 'src/pages/menu.astro', text: 'Our breads' }, server: { file: 'src/pages/menu.astro', text: 'Sourdough' }, style: 'src/styles/global.css' },
      kay: { template: { file: 'src/routes/menu.kay', text: 'Our breads' }, server: { file: 'src/routes/menu.kay', text: 'Sourdough' }, style: 'src/app.css' },
    },
    env: { SITE_URL: 'https://bakery.example' },
    // Read by the dev servers instead of `env`, which may point them at the live site.
    devEnv: { SITE_URL: 'http://localhost' },
    // The dev copies run locally: an Astro config sending Vite's reloads to the public host would never reach the dev server.
    prepareDev: async (dir, kind) => {
      if (kind !== 'astro')
        return

      const file = Bun.file(join(dir, 'astro.config.mjs'))

      await Bun.write(file, (await file.text()).replace('hmr: { host: \'bakery.example\' },', () => ''))
    },
    // A dependency of the Astro side the registry no longer has, which nothing measured needs.
    patch: (manifest) => {
      delete manifest.devDependencies?.['@bakery/eslint-config']
    },
  },
  {
    name: 'florist',
    repo: '../../../florist',
    astro: 'd4e5f6a',
    pages: ['/', '/bouquets'],
    // A function of the variant when the sides differ, as each reads its own database, or a value depends on its ports.
    env: variant => ({ DATABASE_URL: `postgres://florist:bench@127.0.0.1:47600/florist_${variant.kind}`, API_URL: `http://127.0.0.1:${variant.ports.sidecar}` }),
    // The Astro pages fetch from an API production ran beside them: started and measured with the server, nginx sending it `/api/`.
    sidecar: { astro: { command: variant => [process.execPath, 'api/index.ts', '--port', String(variant.ports.sidecar)], paths: ['/api/'] } },
    // Started before the builds, given the variants measured, and stopped as the run ends, however far the start got: here a database per side, seeded afresh.
    services: {
      start: () => {
        if (Bun.spawnSync(['docker', 'run', '-d', '--rm', '--name', 'kay-bench-florist', '-e', 'POSTGRES_USER=florist', '-e', 'POSTGRES_PASSWORD=bench', '-p', '127.0.0.1:47600:5432', 'postgres:18-alpine']).exitCode !== 0)
          throw new Error('florist: docker run failed')
        // Then wait for it to answer, and create and seed `florist_astro` and `florist_kay`.
      },
      stop: () => {
        Bun.spawnSync(['docker', 'rm', '-fv', 'kay-bench-florist'])
      },
    },
  },
  {
    name: 'club',
    repo: '../../../club',
    // The commit that last ran before kay, here a Bun server with its own client build rather than Astro.
    astro: 'b7c8d9e',
    pages: ['/', '/members', '/login'],
    before: {
      label: 'Elysia + Solid',
      build: [process.execPath, 'scripts/build-client.ts'],
      serve: [process.execPath, '--preload', './web/preload.ts', 'index.ts'],
      outputs: ['dist'],
      // Production runs the sources themselves besides the client build.
      deploy: ['dist', 'index.ts', 'api', 'web'],
      sources: ['index.ts', 'api', 'web'],
    },
    // Every page but the sign-in needs a session, so readiness waits on that one.
    ready: '/login',
    // Each side's session, minted with that side's own secret; a sign-in against the server, which answers by then, works as well.
    auth: async (variant) => {
      if (variant.kind === 'kay') {
        const response = await fetch(`http://127.0.0.1:${variant.ports.backend}/login`, { method: 'POST', body: new URLSearchParams({ email: 'bench@club.example', password: 'bench' }), redirect: 'manual' })

        return { cookie: response.headers.getSetCookie().map(cookie => cookie.replace(COOKIE_ATTRIBUTES, '')).join('; ') }
      }

      return { cookie: `token=${signedToken('bench-secret')}` }
    },
  },
] satisfies Site[]

// The JWT the old side signs its sessions with, for a member that exists in its database.
function signedToken(secret: string): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const unsigned = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: '1', exp: Math.floor(Date.now() / 1000) + 3600 })}`

  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`
}
