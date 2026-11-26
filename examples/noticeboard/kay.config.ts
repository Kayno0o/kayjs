import { ui } from '@kayjs/ui/plugin'
import { defineConfig } from '@kayjs/kay/config'
import { auth, BOARD_ROOM, board, mail, sendPresence } from './src/services'

export default defineConfig({
  plugins: [
    ui({ grammar: 'editorial' }),
    auth.plugin,
    mail.plugin(),
    board.plugin({
      path: '/api/board',
      room: BOARD_ROOM,
      member: (ctx) => {
        const user = auth.getUser(ctx)
        return user ? (user.name || user.email) : null
      },
      onJoin: sendPresence,
      onLeave: sendPresence,
    }),
  ],
})
