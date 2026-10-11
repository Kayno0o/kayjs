import { defineConfig } from 'kay/server'
import { authPages } from '../../src/pages'

export default defineConfig({
  extensions: [authPages({ server: async () => (await import('./src/auth')).auth.plugin })],
  i18n: { locales: ['en', 'fr'], defaultLocale: 'en' },
})
