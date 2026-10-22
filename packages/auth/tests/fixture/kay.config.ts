import { defineConfig } from 'kay/server'
import { auth } from '../../src/pages'

export default defineConfig({
  extensions: [auth({ module: './src/auth', viewer: true, ...process.env.FIXTURE_PREFIX && { prefix: process.env.FIXTURE_PREFIX } })],
  i18n: { locales: ['en', 'fr'], defaultLocale: 'en' },
})
