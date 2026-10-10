import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import tailwind from 'bun-plugin-tailwind'
import { defineConfig } from 'kay/server'
import { pageWeight } from './src/page-weight'

// The full reference moved from /reference to /llms; /reference/checks is the people's page on kay check now.
const moved = readdirSync(join(import.meta.dir, '../llms')).map(file => file.replace(/\.md$/, '')).filter(topic => topic !== 'checks')

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
  images: { card: { background: '#17202e', color: '#eef2f7' } },
  // kay's own docs wear kay's mark.
  lints: { 'default-favicon': 'allow' },
  redirects: Object.fromEntries(moved.map(topic => [`/reference/${topic}`, `/llms/${topic}`])),
})
