import { api, eventStream } from 'kay/server'

export default api()
  .get('/me', ({ user }) => ({ user }))
  .get('/news', () => eventStream(['private']))
  .ws('/feed', { message(ws, message) { ws.send(message) } })
