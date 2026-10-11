import type { Site } from './sites'

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
  },
] satisfies Site[]
