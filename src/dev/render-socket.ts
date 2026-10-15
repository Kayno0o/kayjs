import process from 'node:process'

// Preloaded into the server `kay render` runs: each server the entry starts listens on a Unix socket rather than a port, so nothing on the network reaches it and no port is taken, and the first tells `kay render` it is up.
const SOCKET = process.env.KAY_RENDER_SOCKET!
// `PARENT_WATCHED` in `src/server/lifecycle.ts`, which this preload does not import, to load nothing before the entry.
const PARENT_WATCHED = Symbol.for('kay.parentWatched')
const PARENT_POLL_MS = 1000
const serve = Bun.serve.bind(Bun)
const parent = process.ppid
let started = 0

delete process.env.KAY_RENDER_SOCKET

// A server `kay render` outlived stops: through `pages()`, which drains it, or here for an entry serving without it.
setInterval(() => process.ppid !== parent && Reflect.get(globalThis, PARENT_WATCHED) !== true && process.exit(), PARENT_POLL_MS).unref()

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
