import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { ai } from '@kaynooo/kayjs-ai'
import tailwind from 'bun-plugin-tailwind'
import { analytics } from 'kay/analytics'
import { defineConfig, sqliteRates } from 'kay/server'
import { highlight } from './src/highlight'
import { pageWeight } from './src/page-weight'
import { THEME_SCRIPT } from './src/theme'

// The website id from Umami, see README.md; the docs count nothing while it is unset. The host is Umami's name on the compose network.
const umamiWebsiteId = process.env.UMAMI_WEBSITE_ID?.trim()
const umamiHost = process.env.UMAMI_HOST?.trim() || 'http://umami:3000'

const MARKDOWN_EXTENSION = /\.md$/

// The full reference moved from /reference to /llms; /reference/checks is the people's page on kay check now.
const moved = readdirSync(join(import.meta.dir, '../llms')).map(file => file.replace(MARKDOWN_EXTENSION, '')).filter(topic => topic !== 'checks')

// Beside this file whatever the folder the server starts from, so the build and the tests meet the one file `kay start` does.
const chatCounts = sqliteRates(join(import.meta.dir, 'data/ai.sqlite'))

// The migration guides moved from /guides to their own section.
const migrations = ['astro', 'sveltekit', 'nextjs', 'laravel']

export default defineConfig({
  log: false,
  plugins: [tailwind],
  // Behind the host's nginx, whose address every visitor would otherwise share: the chat's limits count the visitor.
  proxy: true,
  // The chat button on every page runs on Mistral's account, whose rate limit is low (about a request a second, and an answer takes up to five): 4 questions a minute per visitor, 60,000 tokens a day each (about a dozen full answers), 1,500,000 a day in all (a few euros a month at most). The counts are kept in docs/data, so a restart keeps them.
  extensions: [pageWeight, ...umamiWebsiteId ? [analytics({ provider: 'umami', websiteId: umamiWebsiteId, host: umamiHost })] : [], ai({ rateLimit: { max: 4, window: '1m', store: chatCounts }, budget: { tokens: 60_000, total: 1_500_000, window: '1d', store: chatCounts } })],
  site: 'https://kayjs.kaynooo.fr',
  seo: {
    name: 'kay',
    description: 'A Bun web framework: one .kay file per component, pages rendered to plain HTML on the server, interactive islands in the browser.',
  },
  // Only the share cards draw with it: no stylesheet names Inter, so pages never fetch it.
  fonts: [{ fontsource: '@fontsource/inter', weights: [700] }],
  // kay's own mark, the kingfisher the docs' favicon shows too.
  images: { card: { background: '#17202e', color: '#eef2f7', logo: '../src/server/favicon.svg' } },
  // Set once for every collection, and for the chat's code blocks, which the server highlights with it as well.
  markdown: { highlight },
  search: true,
  // The theme picked in the header, put on the page before it paints.
  head: [{ tag: 'script', props: { children: THEME_SCRIPT } }],
  // kay's own docs wear kay's mark.
  lints: { 'default-favicon': 'allow' },
  // /docs is where a visitor, or an agent, guesses the docs are.
  redirects: { '/docs': '/getting-started/introduction', '/ask': '/', ...Object.fromEntries(migrations.map(framework => [`/guides/migrating-from-${framework}`, `/migrating/from-${framework}`])), ...Object.fromEntries(moved.map(topic => [`/reference/${topic}`, `/llms/${topic}`])) },
})
