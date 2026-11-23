// Kay v2 Showcase config: @kayjs/ui (live grammar switcher serves all 5 CSS grammars) + @kayjs/auth.

import type { BuildPluginContext } from 'kay/server'
import { readFileSync } from 'node:fs'
import { createAuth, memoryAuthStore } from '@kayjs/auth'
import { grammarCssPath } from '@kayjs/ui/plugin'
import { defineConfig } from 'kay/server'

const GRAMMARS = ['editorial', 'workshop', 'console', 'soft', 'orbit', 'bare'] as const

export const auth = createAuth({
  store: memoryAuthStore('showcase'),
  secret: 'showcase-dev-secret-change-in-prod',
  defaultRedirect: '/',
})

const grammarAssets = {
  name: 'showcase-grammars',
  build(ctx: BuildPluginContext) {
    const bare = readFileSync(grammarCssPath('bare'), 'utf8')
    ctx.emitPublic('grammars/bare.css', bare)
    for (const g of GRAMMARS) {
      if (g === 'bare')
        continue
      const css = readFileSync(grammarCssPath(g), 'utf8').replace(/@import\s+['"]\.\.\/bare\.css['"];?\s*/g, '')
      ctx.emitPublic(`grammars/${g}.css`, `${bare}\n${css}`)
    }
  },
}

export default defineConfig({
  plugins: [auth.plugin, grammarAssets],
})
