import type { BuildPluginContext } from '@kayjs/kay/config'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { icons } from '@kayjs/icons/plugin'
import { images } from '@kayjs/images'
import { seo } from '@kayjs/seo'
import { ui } from '@kayjs/ui/plugin'
import { defineConfig } from '@kayjs/kay/config'
import { docs } from './src/content'
import { pageWeight } from './src/page-weight'

const SITE = process.env.SITE_URL ?? 'https://kayjs-v2.kaynooo.fr'

const docsAssets = {
  name: 'kay-docs-assets',
  css: ['src/docs.css'],
  build(ctx: BuildPluginContext) {
    // Emit root llms.txt at /llms.txt
    const llmsPath = resolve(ctx.root, '../llms.txt')
    if (existsSync(llmsPath))
      ctx.emitPublic('llms.txt', readFileSync(llmsPath, 'utf8'))
  },
}

export default defineConfig({
  lang: 'en',
  plugins: [
    ui({ grammar: 'orbit', emitGrammars: true }),
    docsAssets,
    icons(),
    images({
      card: {
        site: SITE,
        background: '#090c13',
        color: '#dbe0ea',
        accent: '#f5b83d',
        fontFamily: 'Chakra Petch, system-ui, sans-serif',
      },
    }),
    seo({
      site: SITE,
      name: 'kay',
      titleTemplate: '%s | kay',
      description: 'Kay v2 — Bun-native TSX framework with zero-directive automatic islands, fine-grained .value signals, flat-string SSR, and single-binary deploys.',
      favicon: 'public/favicon.svg',
      fonts: [
        { family: 'Chakra Petch', src: '@fontsource/chakra-petch/files/chakra-petch-latin-600-normal.woff2', weight: 600 },
        { family: 'IBM Plex Sans', src: '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2', weight: 400 },
        { family: 'IBM Plex Sans', src: '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2', weight: 600 },
        { family: 'JetBrains Mono', src: '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2', weight: 400 },
      ],
      redirects: {
        '/docs': '/docs/getting-started/introduction',
      },
      extraUrls: () => [
        '/grammars',
        ...docs.paths('/docs'),
      ],
    }),
    pageWeight(),
  ],
})
