import tailwind from 'bun-plugin-tailwind'
import { defineConfig } from 'kay/server'

export default defineConfig({ plugins: [tailwind], settings: { '@kaynooo/kayjs-ui': './src/ui-settings.ts' } })
