import type { Server } from 'bun'

// Placeholder until kay exports the client address it rate-limits actions by: the socket's address, which behind a proxy is the proxy's.
export function clientKey(request: Request, server: Server<unknown> | null | undefined): string {
  return server?.requestIP(request)?.address ?? 'unknown'
}
