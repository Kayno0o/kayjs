import { defineConfig } from 'kay/server'
import { authPages } from '../../src/pages'

export default defineConfig({
  extensions: [authPages()],
  i18n: { locales: ['en', 'fr'], defaultLocale: 'en' },
})
