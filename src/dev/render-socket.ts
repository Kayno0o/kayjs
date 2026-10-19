import process from 'node:process'

// Preloaded into the server `kay render` runs: each server the entry starts listens on a Unix socket rather than a port, so nothing on the network reaches it and no port is taken, and the first tells `kay render` it is up.
const SOCKET = process.env.KAY_RENDER_SOCKET!
// `PARENT_WATCHED` in `src/server/parent.ts`, which this preload does not import, so it is read by its name.
const PARENT_WATCHED = Symbol.for('kay.parentWatched')
const PARENT_POLL_MS = 1000
const serve = Bun.serve.bind(Bun)
// `START_PARENT` in `src/server/lifecycle.ts`, read rather than `process.ppid`, which already names the reaper when `kay render` died before this preload ran.
const parent = Number(process.env.KAY_START_PID) || process.ppid
let started = 0

delete process.env.KAY_RENDER_SOCKET

let asked = false

// A server `kay render` outlived stops: through `pages()`, which drains it, or here for an entry serving without it, by SIGTERM so its own handlers run, then for good a poll later.
setInterval(() => {
  if (process.ppid === parent || Reflect.get(globalThis, PARENT_WATCHED) === true)
    return

  if (asked)
    process.exit()

  asked = true
  process.kill(process.pid, 'SIGTERM')
}, PARENT_POLL_MS).unref()

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

// As `kay dev` has it, so a module the entry imports before it calls `pages()`, such as one importing `~icons` or a `.kay` mail, loads; a project that cannot load its config fails in `pages()` instead.
try {
  const { registerEarlyLoader } = await import('../server/loader')

  await registerEarlyLoader(process.cwd())
}
catch {}
