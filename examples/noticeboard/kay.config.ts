import { authPages } from '@kaynooo/kayjs-auth'
import { mailExtension } from '@kaynooo/kayjs-mail'
import tailwind from 'bun-plugin-tailwind'
import { defineConfig } from 'kay/server'

// The extensions load the app's auth and mail only as the server builds, so this file never imports its database.
export default defineConfig({
  lang: 'en',
  plugins: [tailwind],
  seo: { name: 'Noticeboard', titleTemplate: '%s | Noticeboard', description: 'A club noticeboard, made with kay and its libraries' },
  extensions: [
    authPages({ auth: () => import('./src/auth') }),
    mailExtension('./src/mail'),
  ],
})
