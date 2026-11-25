import { mailPlugin } from '@kayjs/mail'
import { ui } from '@kayjs/ui/plugin'
import { defineConfig } from 'kay/server'
import { auth, BOARD_ROOM, board, mail, sendPresence } from './src/services'

export default defineConfig({
  plugins: [
    ui({ grammar: 'editorial' }),
    auth.plugin,
    mailPlugin(mail),
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
