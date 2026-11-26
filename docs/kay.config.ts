import type { BuildPluginContext } from '@kayjs/kay/config'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { icons } from '@kayjs/icons/plugin'
import { images } from '@kayjs/images'
import { seo } from '@kayjs/seo'
import { ui } from '@kayjs/ui/plugin'
import { defineConfig } from '@kayjs/kay/config'
import { docs, SECTIONS } from './src/content'
import { pageWeight } from './src/page-weight'

const SITE = process.env.SITE_URL ?? 'https://kayjs-v2.kaynooo.fr'

const docsAssets = {
  name: 'kay-docs-assets',
  css: ['src/docs.css'],
  build(ctx: BuildPluginContext) {
    const repoRoot = resolve(ctx.root, '..')
    // Emit root llms.txt at /llms.txt
    const llmsPath = resolve(repoRoot, 'llms.txt')
    const coreLlms = existsSync(llmsPath) ? readFileSync(llmsPath, 'utf8').trim() : ''
    if (coreLlms)
      ctx.emitPublic('llms.txt', `${coreLlms}\n`)

    // Emit raw Markdown endpoint for every doc page (e.g. /docs/plugins/auth.md)
    const entries = docs.all()
    const sectionLabels = new Map(SECTIONS.map(s => [s.id, s.label]))
    const fullParts: string[] = [
      `# Kay v2 — Full Documentation & Package Reference\n\n> Complete Markdown corpus generated from ${SITE}. Individual pages are also available at \`${SITE}/docs/<slug>.md\`, and the 1-page summary is at \`${SITE}/llms.txt\`.`,
    ]

    if (coreLlms)
      fullParts.push(coreLlms)

    // Append all first-party plugin llms.txt references
    const packagesDir = resolve(repoRoot, 'packages')
    if (existsSync(packagesDir)) {
      const pluginRefs: string[] = []
      for (const dir of readdirSync(packagesDir).sort()) {
        if (dir === 'kay')
          continue
        const pluginLlms = join(packagesDir, dir, 'llms.txt')
        if (existsSync(pluginLlms))
          pluginRefs.push(readFileSync(pluginLlms, 'utf8').trim())
      }
      if (pluginRefs.length > 0)
        fullParts.push(pluginRefs.join('\n\n---\n\n'))
    }

    for (const entry of entries) {
      const pageMd = `# ${entry.data.title}\n\n> ${entry.data.description}\n\n${entry.body.trim()}\n`
      ctx.emitPublic(`docs/${entry.slug}.md`, pageMd)
      const sec = sectionLabels.get(entry.data.section) ?? entry.data.section
      fullParts.push(`# ${entry.data.title}\n\n> Section: ${sec} | Source: ${SITE}/docs/${entry.slug}.md\n> ${entry.data.description}\n\n${entry.body.trim()}`)
    }

    ctx.emitPublic('llms-full.txt', `${fullParts.join('\n\n---\n\n')}\n`)
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
