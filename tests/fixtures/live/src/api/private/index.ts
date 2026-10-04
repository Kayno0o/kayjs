import { api, events } from 'kay/server'

export default api()
  .get('/me', ({ user }) => ({ user }))
  .get('/news', () => events(['private']))
  .ws('/feed', { message(ws, message) { ws.send(message) } })
