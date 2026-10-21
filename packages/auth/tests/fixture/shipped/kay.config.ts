import { defineConfig } from 'kay/server'
import { auth } from '../../../src/pages'

export default defineConfig({
  extensions: [auth({ server: async () => (await import('../src/auth')).auth.plugin })],
  i18n: { locales: ['en', 'fr'], defaultLocale: 'en' },
})
