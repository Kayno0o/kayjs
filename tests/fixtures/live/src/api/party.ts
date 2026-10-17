import { t } from 'elysia'
import { dispatch } from 'kay'
import { api, rooms } from 'kay/server'

const said = t.Object({ type: t.Literal('said'), from: t.String(), text: t.String() })
const joined = t.Object({ type: t.Literal('joined'), room: t.String(), members: t.Array(t.String()) })
const score = t.Object({ type: t.Literal('score'), room: t.String(), score: t.Number() })

type Sent = typeof said.static | typeof joined.static | typeof score.static

// Guests join rooms by message, each listed by their name; a burst of bumps goes out as one score.
const party = rooms<Sent, string>()
const scores = new Map<string, number>()
const sendScore = party.coalesce(room => ({ type: 'score', room, score: scores.get(room) ?? 0 }), { wait: '30ms' })

export default api()
  .ws('/', {
    query: t.Object({ name: t.String() }),
    body: t.Union([
      t.Object({ type: t.Literal('join'), room: t.String() }),
      t.Object({ type: t.Literal('leave'), room: t.String() }),
      t.Object({ type: t.Literal('say'), room: t.String(), text: t.String() }),
      t.Object({ type: t.Literal('bump'), room: t.String() }),
      t.Object({ type: t.Literal('drop') }),
    ]),
    response: t.Union([said, joined, score]),
    message(ws, body) {
      dispatch(body, {
        join: ({ room }) => {
          party.join(ws, room, ws.data.query.name)
          party.publish(room, { type: 'joined', room, members: party.members(room) })
        },
        leave: ({ room }) => party.leave(ws, room),
        say: ({ room, text }) => party.publish(room, { type: 'said', from: ws.data.query.name, text }, { except: ws }),
        bump: ({ room }) => {
          scores.set(room, (scores.get(room) ?? 0) + 1)
          sendScore(room)
        },
        drop: () => ws.close(1011, 'dropped'),
      })
    },
    close(ws) {
      party.leave(ws)
    },
  })
  .get('/members/:room', ({ params }) => party.members(params.room))
