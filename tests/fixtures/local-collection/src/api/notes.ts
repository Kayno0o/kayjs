import { t } from 'elysia'
import { api } from 'kay/server'
import { notes, stats } from '../lib/db'

// What an island reads, plus what a test uses to play another client and to look at the server.
export default api()
  .get('/', () => [...notes.values()])
  .get('/stats', () => ({ ...stats, rows: [...notes.values()] }))
  .post('/other', ({ body }) => {
    notes.set(body.id, body)

    return body
  }, { body: t.Object({ id: t.String(), title: t.String(), rev: t.Number() }) })
  .post('/reset', () => {
    notes.clear()
    stats.saves = 0
    stats.drops = 0
  })
