import { mail } from '@kayjs/mail'
import { defineConfig } from 'kay/server'

export default defineConfig({ i18n: { locales: ['en', 'fr'], default: 'en' }, librarySettings: { '@kayjs/mail': './src/mail-settings.ts' }, extensions: [mail({ module: './src/mail' })] })
