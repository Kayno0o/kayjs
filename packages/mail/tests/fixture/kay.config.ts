import { mailExtension } from '@kaynooo/kayjs-mail'
import { defineConfig } from 'kay/server'

export default defineConfig({ i18n: { locales: ['en', 'fr'], defaultLocale: 'en' }, settings: { '@kaynooo/kayjs-mail': './src/mail-settings.ts' }, extensions: [mailExtension(async () => (await import('./src/mail')).mail)] })
