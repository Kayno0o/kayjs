import { Elysia } from 'elysia'

// A module that is no `api()` instance is held to the same limits.
export default new Elysia().ws('/', { message(ws) {
  ws.send('plain')
} })
