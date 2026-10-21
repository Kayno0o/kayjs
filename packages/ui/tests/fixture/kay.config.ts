import tailwind from 'bun-plugin-tailwind'
import { defineConfig } from 'kay/server'

export default defineConfig({ site: 'https://example.com', seo: { description: 'The kayjs-ui fixture.' }, plugins: [tailwind], i18n: { locales: ['en', 'fr'], defaultLocale: 'en' }, settings: { '@kaynooo/kayjs-ui': './src/ui-settings.ts' } })
