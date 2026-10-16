import { readdirSync } from 'node:fs'
import { join } from 'node:path'
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
  extensions: [pageWeight],
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
