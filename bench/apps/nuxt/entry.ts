import { useNitroApp } from 'nitropack/runtime'
import '#nitro-internal-pollyfills'

const nitroApp = useNitroApp()

// The request handler Nitro's Bun entry hands to `Bun.serve`, exported for the bench to call in-process.
export async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url)

  return nitroApp.localFetch(url.pathname + url.search, {
    host: url.hostname,
    protocol: url.protocol,
    headers: request.headers,
    method: request.method,
    body: request.body ? await request.arrayBuffer() : undefined,
  })
}
