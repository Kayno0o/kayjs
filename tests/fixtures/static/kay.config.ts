import process from 'node:process'
import { t } from 'elysia'
import { defineConfig } from 'kay/server'

export default defineConfig({
  site: 'https://x.example',
  base: '/repo',
  // The test serves the remote image from a port of its own.
  images: { maxDensity: 3, remote: process.env.KAY_TEST_REMOTE_ORIGIN ? [`${process.env.KAY_TEST_REMOTE_ORIGIN}/photos/`] : [] },
  redirects: { '/old': '/about', '/blog/:slug': '/posts/:slug' },
  publicEnv: t.Object({ KAY_TEST_STATIC_KEY: t.String({ default: 'static-key' }) }),
})
