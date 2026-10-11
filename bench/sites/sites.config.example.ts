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
] satisfies Site[]
