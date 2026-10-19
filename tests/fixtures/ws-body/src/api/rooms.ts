import { s } from 'kay'
import { api } from 'kay/server'

// Echoes what the route's `body` hands `message()`, so a test reads what arrived: its coerced values and its kinds.
let errors = 0

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
  .ws('/nested', {
    body: s.Object({ type: s.Literal('a'), nested: s.Object({ n: s.Integer() }), list: s.Array(s.Integer()) }),
    // Counts what reaches an error hook, which a refused message must not.
    error() {
      errors++

      return 'refused'
    },
    message(ws, body) {
      ws.send(JSON.stringify({ type: 'echo', body }))
    },
  })
  .ws('/optional', {
    body: s.Object({ type: s.Literal('a'), nested: s.Optional(s.Object({ n: s.Integer() })) }),
    message(ws, body) {
      ws.send(JSON.stringify({ type: 'echo', body, own: Object.keys(body) }))
    },
  })
  .get('/errors', () => errors)
  .ws('/plain', {
    message(ws, body) {
      ws.send(JSON.stringify({ type: 'echo', body }))
    },
  })
  .post('/h', ({ body }) => body, { body: s.Object({ at: s.Integer() }) })
