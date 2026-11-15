import { s } from 'kay'
import { api, rooms } from 'kay/server'

export const room = rooms({ reply: s.Object({ n: s.Number() }) })

// What each message names is what the route sends back, so a test reads every kind of value a frame carries.
const answers: Record<string, unknown> = {
  string: 'hi',
  numeric: '42',
  number: 42,
  zero: 0,
  boolean: false,
  null: null,
  object: { a: 1 },
  array: [1, 'two', null],
}

export default api()
  .ws('/boom', {
    error: () => 'reported',
    message() {
      throw new Error('boom')
    },
  })
  .ws('/replies', {
    body: s.String(),
    message(ws, kind) {
      if (kind === 'returned')
        return 7

      ws.send(answers[kind])

      return undefined
    },
  })
  .ws('/room', {
    response: room.response,
    open(ws) {
      room.join(ws, 'only')
    },
    message(_ws, message) {
      room.publish('only', message as { n: number })
    },
  })
  .ws('/bad', {
    response: s.Object({ n: s.Number() }),
    message(ws) {
      ws.send({ n: 'x' } as never)
    },
  })
  .get('/members', () => room.members('only').length)
