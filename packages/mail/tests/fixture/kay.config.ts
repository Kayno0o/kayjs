import { mailExtension } from '@kaynooo/kayjs-mail'
import { defineConfig } from 'kay/server'

export default defineConfig({ settings: { '@kaynooo/kayjs-mail': './src/mail-settings.ts' }, extensions: [mailExtension(async () => (await import('./src/mail')).mail)] })
