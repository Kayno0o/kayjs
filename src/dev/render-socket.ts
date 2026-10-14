import process from 'node:process'

// Preloaded into the server `kay render` runs: each server the entry starts listens on a Unix socket rather than a port, so nothing on the network reaches it and no port is taken, and the first tells `kay render` it is up.
const SOCKET = process.env.KAY_RENDER_SOCKET!
const serve = Bun.serve.bind(Bun)
let started = 0

delete process.env.KAY_RENDER_SOCKET

Bun.serve = ((options: Parameters<typeof Bun.serve>[0]) => {
  const onSocket: Record<string, unknown> = { ...options, unix: started === 0 ? SOCKET : `${SOCKET}.${started}` }

  // What only a TCP server takes.
  for (const option of ['port', 'hostname', 'reusePort', 'ipv6Only'])
    delete onSocket[option]

  const server = serve(onSocket as unknown as Parameters<typeof Bun.serve>[0])

  if (started++ === 0)
    process.send?.({ serving: true })

  return server
}) as typeof Bun.serve
