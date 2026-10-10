import type { Site } from './sites'

// Copy to sites.config.ts (gitignored) or pass `--config <file>`: each entry is a site that ran on Astro, then moved to kay in the same repository.
export default [
  {
    name: 'bakery',
    repo: '../../../bakery',
    astro: 'a1b2c3d',
    pages: ['/', '/menu', '/contact'],
    loaded: ['/', '/menu'],
    env: { SITE_URL: 'https://bakery.example' },
  },
] satisfies Site[]
