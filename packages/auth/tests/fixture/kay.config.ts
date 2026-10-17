import { defineConfig } from 'kay/server'
import { authPages } from '../../src/pages'

export default defineConfig({
  extensions: [authPages({ auth: () => import('./src/auth'), ...process.env.FIXTURE_PREFIX && { prefix: process.env.FIXTURE_PREFIX } })],
  i18n: { locales: ['en', 'fr'], defaultLocale: 'en' },
})
