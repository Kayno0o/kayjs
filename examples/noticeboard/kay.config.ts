import { auth } from '@kaynooo/kayjs-auth'
import { mail } from '@kaynooo/kayjs-mail'
import tailwind from 'bun-plugin-tailwind'
import { defineConfig } from 'kay/server'

// The extensions load the app's auth and mail only as the server builds, so this file never imports its database.
export default defineConfig({
  lang: 'en',
  plugins: [tailwind],
  seo: { name: 'Noticeboard', titleTemplate: '%s | Noticeboard', description: 'A club noticeboard, made with kay and its libraries' },
  extensions: [
    auth({ module: './src/auth' }),
    mail({ module: './src/mail' }),
  ],
})
