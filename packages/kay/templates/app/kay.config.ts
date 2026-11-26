import { ui } from '@kayjs/ui/plugin'
import { defineConfig } from '@kayjs/kay/config'
import { auth } from './src/auth'

export default defineConfig({
  lang: 'en',
  plugins: [
    ui({ grammar: 'editorial' }),
    auth,
  ],
})
