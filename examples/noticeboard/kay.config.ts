import tailwind from 'bun-plugin-tailwind'
import { defineConfig } from 'kay/server'

export default defineConfig({
  lang: 'en',
  plugins: [tailwind],
  seo: { name: 'Noticeboard', titleTemplate: '%s | Noticeboard', description: 'A club noticeboard, made with kay and its libraries' },
})
