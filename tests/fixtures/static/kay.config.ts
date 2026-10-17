import { basename } from 'node:path'
import process from 'node:process'
import { t } from 'elysia'
import { defineConfig } from 'kay/server'

const LINK = /(?:href|src)="([^"]+)"/g

export default defineConfig({
  site: 'https://x.example',
  base: '/repo',
  robots: { disallow: ['/private'] },
  // The tests read the linked stylesheets and their files.
  inlineStyles: false,
  // The test serves the remote image from a port of its own.
  images: { maxDensity: 3, remote: process.env.KAY_TEST_REMOTE_ORIGIN ? [`${process.env.KAY_TEST_REMOTE_ORIGIN}/photos/`] : [] },
  redirects: { '/old': '/about', '/blog/:slug': '/posts/:slug', '/moved': { to: '/about', status: 302 }, '/temp': { to: '/about', permanent: false }, '/kept': { to: '/about', status: 308 } },
  publicEnv: t.Object({ KAY_TEST_STATIC_KEY: t.String({ default: 'static-key' }) }),
  // Lists the files each page links before its end, as a footer giving the page's weight would size them.
  extensions: [{
    name: 'linked-files',
    async transformPage({ path, html, file }) {
      const files = await Promise.all([...html.matchAll(LINK)].map(async ([, url]) => file(url!)))

      return html.replace('</body>', `<!--linked from ${path}: ${files.filter(found => found !== undefined).map(found => basename(found)).join(' ')}--></body>`)
    },
  }],
})
