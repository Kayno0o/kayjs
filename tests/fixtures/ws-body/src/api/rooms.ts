import { s } from 'kay'
import { api } from 'kay/server'

// Echoes what the route's `body` hands `message()`, so a test reads what arrived: its coerced values and its kinds.
export default api()
  .ws('/', {
    body: s.Union([
      s.Object({ type: s.Literal('say'), text: s.String() }),
      s.Object({ type: s.Literal('move'), at: s.Integer() }),
    ]),
    message(ws, body) {
      ws.send(JSON.stringify({ type: 'echo', body, kinds: Object.entries(body).map(([key, value]) => `${key}:${typeof value}`) }))
    },
  })
  .ws('/plain', {
    message(ws, body) {
      ws.send(JSON.stringify({ type: 'echo', body }))
    },
  })
  .post('/h', ({ body }) => body, { body: s.Object({ at: s.Integer() }) })
