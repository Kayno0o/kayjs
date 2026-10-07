import { t } from 'elysia'
import { defineConfig } from 'kay/server'

export default defineConfig({
  site: 'https://x.example',
  base: '/repo',
  images: { maxDensity: 3 },
  redirects: { '/old': '/about', '/blog/:slug': '/posts/:slug' },
  publicEnv: t.Object({ KAY_TEST_STATIC_KEY: t.String({ default: 'static-key' }) }),
})
