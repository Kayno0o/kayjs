import { t } from 'elysia'
import { api } from 'kay/server'

// Sends each message back, to the page that opened it under the base.
export default api()
  .ws('/', {
    body: t.Object({ text: t.String({ maxLength: 40 }) }),
    response: t.Object({ text: t.String() }),
    message(ws, message) {
      ws.send({ text: `echo ${message.text}` })
    },
  })
