import { t } from 'elysia'
import { api, eventStream } from 'kay/server'

// Each room echoes what it gets, signed by who sent it; `drop` closes the connection as a crashing server would.
export default api()
  .ws('/:room', {
    body: t.Object({ text: t.String() }),
    response: t.Object({ room: t.String(), from: t.String(), text: t.String() }),
    message(ws, { text }) {
      if (text === 'drop')
        return ws.close(1011, 'dropped')

      ws.send({ room: ws.data.params.room, from: ws.data.user ?? 'anonymous', text })
    },
  })
  .get('/ticks', ({ query }) => eventStream((async function* () {
    for (let tick = 1; tick <= query.count; tick++)
      yield { tick, at: new Date(Date.UTC(2026, 0, tick)) }
  })()), { query: t.Object({ count: t.Integer() }) })
  .post('/answer', ({ body }) => eventStream(body.prompt.split(' ').map(word => `${word}\n`)), { body: t.Object({ prompt: t.String() }) })
  .get('/rooms', ({ query }) => ['general', 'games', 'news'].filter(name => name.startsWith(query.prefix ?? '')).map(name => ({ name, opened: new Date(Date.UTC(2026, 0, 1)) })), { query: t.Object({ prefix: t.Optional(t.String()) }) })
  .get('/rooms/:name', ({ params, status }) => params.name === 'general' ? { name: params.name, members: 3 } : status(404, 'No such room'))
  .get('/broken', () => eventStream((async function* () {
    yield 1

    throw new Error('the source broke')
  })()))
