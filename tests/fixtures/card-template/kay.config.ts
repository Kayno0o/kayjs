import tailwind from 'bun-plugin-tailwind'
import { defineConfig } from 'kay/server'

export default defineConfig({
  site: 'https://cards.example',
  seo: { name: 'Cards' },
  plugins: [tailwind],
})
