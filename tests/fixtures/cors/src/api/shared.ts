import { t } from 'elysia'
import { api } from 'kay/server'

const reused = new Response('reused', { headers: { vary: 'Accept-Encoding' } })

export default api({ cors: { origins: ['https://app.example.com', 'https://*.partner.example', 'capacitor://localhost'], credentials: true, expose: ['x-total'] }, bodyLimit: 256 })
  .get('/items', ({ set }) => {
    set.headers['x-total'] = '1'

    return [{ id: 1 }]
  })
  .post('/items', ({ body }) => ({ added: body.name }), { body: t.Object({ name: t.String() }) })
  .delete('/items/:id', ({ params }) => ({ removed: params.id }))
  .get('/greeting', ({ set }) => {
    set.headers.vary = 'Accept-Language'

    return 'hello'
  })
  .get('/built', () => new Response('built', { headers: { vary: 'Accept-Encoding' } }))
  .get('/reused', () => reused)
  .get('/slow', async () => {
    await Bun.sleep(5)

    return reused
  })
  .ws('/live', { message: (ws, message) => ws.send(message) })
