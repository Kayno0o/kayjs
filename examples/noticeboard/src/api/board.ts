import { api } from 'kay/server'
import { BOARD, board, boardMessage, sendPresence } from '../board'

const OPEN = 1

// Served at /api/board: each open board page joins the room under its member's name.
export default api().ws('/', {
  response: boardMessage,
  async open(ws) {
    const user = await ws.data.auth.user()

    // Closed while the user was read, so it never joins a room it would stay in.
    if (ws.raw.readyState !== OPEN)
      return

    board.join(ws, BOARD, user?.username ?? null)
    sendPresence(BOARD)
  },
  close(ws) {
    board.leave(ws)
    sendPresence(BOARD)
  },
})
