// Kay v2 Showcase config: @kayjs/ui (live grammar switcher serves all 6 CSS grammars) + @kayjs/auth.

import { createAuth, memoryAuthStore } from '@kayjs/auth'
import { ui } from '@kayjs/ui/plugin'
import { defineConfig } from '@kayjs/kay/config'

export const auth = createAuth({
  store: memoryAuthStore(),
  secret: 'showcase-dev-secret-change-in-prod',
  defaultRedirect: '/',
})

export default defineConfig({
  plugins: [auth.plugin, ui({ grammar: false, emitGrammars: true })],
})
