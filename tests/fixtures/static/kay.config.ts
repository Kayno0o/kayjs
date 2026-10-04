import { defineConfig } from 'kay/server'

export default defineConfig({
  site: 'https://x.example',
  base: '/repo',
  redirects: { '/old': '/about', '/blog/:slug': '/posts/:slug' },
})
