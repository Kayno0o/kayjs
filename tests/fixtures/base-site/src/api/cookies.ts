import { api } from 'kay/server'

// The cookies a request carried, and routes that set one scoped to the mount point and one to the whole host, then lead to a page.
export default api()
  .get('/read', ({ request }) => request.headers.get('cookie') ?? '', { detail: { tool: true } })
  .get('/enter', () => new Response(null, { status: 302, headers: [['location', '/home'], ['set-cookie', 'scoped=a; Path=/blog'], ['set-cookie', 'wide=b; Path=/']] }))
  .get('/elsewhere', () => new Response(null, { status: 204, headers: [['set-cookie', 'other=c; Path=/other']] }))
