import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import tailwind from 'bun-plugin-tailwind'
import { defineConfig } from 'kay/server'

// The full reference moved from /reference to /llms; /reference/checks is the people's page on kay check now.
const moved = readdirSync(join(import.meta.dir, '../llms')).map(file => file.replace(/\.md$/, '')).filter(topic => topic !== 'checks')

export default defineConfig({
  log: false,
  plugins: [tailwind],
  redirects: Object.fromEntries(moved.map(topic => [`/reference/${topic}`, `/llms/${topic}`])),
})
