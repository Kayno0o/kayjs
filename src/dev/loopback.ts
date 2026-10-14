const LOOPBACKS = ['127.0.0.1', '::1']
const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/

// `localhost` names both loopback addresses, and Bun binds the other one when the first is taken: a client would then reach either server.
export function loopbackTaken(port: number): boolean {
  if (port === 0)
    return false

  for (const hostname of LOOPBACKS) {
    try {
      Bun.listen({ hostname, port, socket: { data: () => undefined } }).stop(true)
    }
    catch (error) {
      if ((error as { code?: unknown }).code === 'EADDRINUSE')
        return true
    }
  }

  return false
}

// This machine, by name or address, as a URL's hostname gives it.
export function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || LOOPBACK_V4.test(hostname)
}
