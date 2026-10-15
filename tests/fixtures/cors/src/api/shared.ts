import { t } from 'elysia'
import { api } from 'kay/server'

const reused = new Response('reused', { headers: { vary: 'Accept-Encoding' } })

// A Response whose headers refuse writes, as a fetch() result's do in some runtimes.
function frozen(): Response {
  const response = new Response('frozen', { headers: { 'vary': 'Accept-Encoding', 'access-control-allow-origin': '*', 'access-control-allow-credentials': 'true', 'access-control-expose-headers': 'x-secret' } })
  const refuse = () => {
    throw new TypeError('Headers are immutable')
  }

  Object.defineProperties(response.headers, { set: { value: refuse }, delete: { value: refuse }, append: { value: refuse } })

  return response
}

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
  .get('/large', () => new Response('large '.repeat(2000), { headers: { 'content-type': 'text/plain', 'vary': 'Accept-Language' } }))
  .get('/own-grant', () => new Response('own', { headers: { 'access-control-allow-origin': '*', 'access-control-allow-credentials': 'true', 'access-control-expose-headers': 'x-secret' } }))
  .get('/own-header', ({ set }) => {
    set.headers['Access-Control-Allow-Origin'] = '*'
    set.headers['access-control-allow-credentials'] = 'true'
    set.headers['access-control-expose-headers'] = 'x-secret'

    return { own: true }
  })
  .get('/context-grant', ({ set }) => {
    set.headers['access-control-allow-origin'] = '*'
    set.headers['access-control-allow-credentials'] = 'true'

    return new Response('context')
  })
  .get('/frozen', () => frozen())
  .get('/redirect', () => Response.redirect('https://elsewhere.example/', 302))
  .get('/upstream', async () => fetch('data:text/plain,upstream'))
  .get('/cookie', ({ cookie }) => {
    cookie.session!.set({ value: 'abc', httpOnly: true })

    return { cookie: true }
  })
  .get('/created', ({ set }) => {
    set.status = 201

    return { created: true }
  })
  .get('/missing', () => new Response('missing', { status: 404 }))
  .get('/slow', async () => {
    await Bun.sleep(5)

    return reused
  })
  .ws('/live', { message: (ws, message) => ws.send(message) })
