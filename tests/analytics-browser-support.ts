import process from 'node:process'

// Assigning undefined to an environment variable stores the text "undefined".
export function restoreEnvironment(value: string | undefined): void {
  if (value === undefined)
    delete process.env.NODE_ENV
  else
    process.env.NODE_ENV = value
}

export interface Received { body: { url: string, referrer: string } }

export const received: Received[] = []

// A provider taking JSON posts at /collect and serving a tracker at /script.js that posts once when it runs.
export function fakeProvider(): ReturnType<typeof Bun.serve> {
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)

      if (url.pathname === '/script.js')
        return new Response(`fetch("http://localhost:${server.port}/collect", { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"url":"loaded","referrer":""}' })`, { headers: { 'content-type': 'text/javascript' } })

      received.push({ body: await request.json() as Received['body'] })

      return Response.json({}, { status: 202 })
    },
  })

  return server
}

// The visits reaching the provider so far, once `count` have.
export async function visits(count: number): Promise<Received[]> {
  const until = Date.now() + 5000

  while (received.length < count && Date.now() < until)
    await Bun.sleep(25)

  return received
}
