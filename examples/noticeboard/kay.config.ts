import { ui } from '@kayjs/ui/plugin'
import { defineConfig } from '@kayjs/kay/config'
import { auth, board, mail } from './src/services'

export default defineConfig({
  plugins: [ui({ grammar: 'editorial' }), auth, mail, board],
})
