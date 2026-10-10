import { defineConfig } from 'kay/server'
import { mail } from './src/mail'

export default defineConfig({ settings: { '@kaynooo/kayjs-mail': './src/mail-settings.ts' }, extensions: [mail.extension] })
