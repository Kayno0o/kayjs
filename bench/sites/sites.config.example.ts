import type { Site } from './sites'
import { join } from 'node:path'

// Copy to sites.config.ts (gitignored) or pass `--config <file>`: each entry is a site that ran on Astro, then moved to kay in the same repository.
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
] satisfies Site[]
