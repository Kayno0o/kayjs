import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ai } from '@kaynooo/kayjs-ai'
import tailwind from 'bun-plugin-tailwind'
import { defineConfig } from 'kay/server'
import { pageWeight } from './src/page-weight'
import { THEME_SCRIPT } from './src/theme'

const MARKDOWN_EXTENSION = /\.md$/

// The full reference moved from /reference to /llms; /reference/checks is the people's page on kay check now.
const moved = readdirSync(join(import.meta.dir, '../llms')).map(file => file.replace(MARKDOWN_EXTENSION, '')).filter(topic => topic !== 'checks')

// The migration guides moved from /guides to their own section.
const migrations = ['astro', 'sveltekit', 'nextjs', 'laravel']

export default defineConfig({
  log: false,
  plugins: [tailwind],
  // Behind the host's nginx, whose address every visitor would otherwise share: the chat's limits count the visitor.
  proxy: true,
  // The chat on /ask runs on Mistral's account, whose rate limit is low (about a request a second, and an answer takes up to five): 4 questions a minute per visitor, 60,000 tokens a day each (about a dozen full answers), 4,000,000 a day in all (a few dollars at most).
  extensions: [pageWeight, ai({ limit: { max: 4, window: '1m' }, budget: { tokens: 60_000, total: 4_000_000, window: '1d' } })],
  site: 'https://kayjs.kaynooo.fr',
  seo: {
    name: 'kay',
    description: 'A Bun web framework: one .kay file per component, pages rendered to plain HTML on the server, interactive islands in the browser.',
  },
  // Only the share cards draw with it: no stylesheet names Inter, so pages never fetch it.
  fonts: [{ fontsource: '@fontsource/inter', weights: [700] }],
  // kay's own mark, the kingfisher the docs' favicon shows too.
  images: { card: { background: '#17202e', color: '#eef2f7', logo: '../src/server/favicon.svg' } },
  search: true,
  // The theme picked in the header, put on the page before it paints.
  head: [{ tag: 'script', props: { children: THEME_SCRIPT } }],
  // kay's own docs wear kay's mark.
  lints: { 'default-favicon': 'allow' },
  // /docs is where a visitor, or an agent, guesses the docs are.
  redirects: { '/docs': '/getting-started/introduction', ...Object.fromEntries(migrations.map(framework => [`/guides/migrating-from-${framework}`, `/migrating/from-${framework}`])), ...Object.fromEntries(moved.map(topic => [`/reference/${topic}`, `/llms/${topic}`])) },
})
