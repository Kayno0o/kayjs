import { api, eventStream } from 'kay/server'

const sockets = { opened: 0, closed: 0 }

// The cookies a request carried, and routes that set one scoped to the mount point and one to the whole host, then lead to a page.
export default api()
  .get('/read', ({ request }) => request.headers.get('cookie') ?? '', { detail: { tool: true } })
  .get('/enter', () => new Response(null, { status: 302, headers: [['location', '/home'], ['set-cookie', 'scoped=a; Path=/blog'], ['set-cookie', 'wide=b; Path=/']] }))
  .get('/elsewhere', () => new Response(null, { status: 204, headers: [['set-cookie', 'other=c; Path=/other']] }))
  .get('/headers', ({ request }) => Object.fromEntries(request.headers))
  .post('/headers', ({ request }) => Object.fromEntries(request.headers))
  .ws('/feed', { message(ws, message) { ws.send(message) } })
  .get('/headers-stream', ({ request }) => eventStream([Object.fromEntries(request.headers)]))
  .ws('/watch', { open() { sockets.opened++ }, close() {
    sockets.closed++
  }, message(ws, message) { ws.send(message) } })
  .ws('/gate', { beforeHandle({ set, status }) {
    set.headers['set-cookie'] = 'gated=1; Path=/'

    return status(401, 'closed')
  }, message(ws, message) { ws.send(message) } })
  .get('/sockets', () => sockets)
