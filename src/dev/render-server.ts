import type { KayConfig } from '../config'
import { existsSync, rmSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { constants, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'
import { KAY_DIR, RENDER_OUTPUT } from '../build/assets'
import { projectPaths } from '../project'
import { alive } from '../server/lifecycle'
import { START_COMMAND, START_PARENT } from '../server/parent'
import { environmentWithoutDotenv, PAGES_ENTRY } from './sources'

const SOCKET_PRELOAD = join(import.meta.dir, 'render-socket.ts')
const STOPS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
// Long enough for a large app's first client build; a server that never listens is said to.
const SERVE_TIMEOUT_MS = 60_000
const STOP_WAIT_MS = 5000
const OWN_BUILD = /^render-(\d+)$/
const OWN_SOCKET = /^kay-render-(\d+)-/

// Stops it and removes its build and socket.
type Stop = () => Promise<void>

interface RenderOptions {
  entry?: string | undefined
  // Marks each element with the `.kay` line it was written at.
  inspect?: boolean
}

// Starts the project's server entry as `kay dev` would serve it, on a Unix socket of its own or, with `port`, on a free loopback port for a browser to open; the reason it did not start comes back as a string.
export async function startRenderServer(root: string, command: string, config: KayConfig | undefined, options: RenderOptions & { port: true }): Promise<{ port: number, stop: Stop } | string>
export async function startRenderServer(root: string, command: string, config: KayConfig | undefined, options?: RenderOptions): Promise<{ socket: string, stop: Stop } | string>
export async function startRenderServer(root: string, command: string, config: KayConfig | undefined, options: RenderOptions & { port?: boolean } = {}): Promise<{ socket: string, stop: Stop } | { port: number, stop: Stop } | string> {
  const { entry } = projectPaths(root, config)

  await Promise.all([removeLeftovers(join(root, KAY_DIR), OWN_BUILD), removeLeftovers(tmpdir(), OWN_SOCKET)])

  const dir = await mkdtemp(join(tmpdir(), `kay-render-${process.pid}-`))
  const socket = join(dir, 'server.sock')
  const output = join(root, KAY_DIR, `render-${process.pid}`)
  const env = await environmentWithoutDotenv(root)
  let serving: (value: number | undefined) => void
  const served = new Promise<number | undefined>((resolveServing) => {
    serving = resolveServing
  })
  // The server's own output is a log, which goes beside the body rather than into it.
  const defaultServer = existsSync(entry) ? entry : PAGES_ENTRY
  const server = Bun.spawn([process.execPath, '--preload', SOCKET_PRELOAD, options.entry === undefined ? defaultServer : resolve(options.entry)], { cwd: root, env: { ...env, NODE_ENV: 'development', [START_PARENT]: String(process.pid), [START_COMMAND]: `kay ${command}`, ...options.inspect && { KAY_INSPECT: '1' }, ...options.port ? { KAY_RENDER_PORT: '1' } : { KAY_RENDER_SOCKET: socket }, [RENDER_OUTPUT]: basename(output) }, stdin: 'ignore', stdout: 2, stderr: 'inherit', ipc: (message: { serving?: boolean, port?: number }) => message.serving === true && serving(message.port) })

  // Interrupted, it leaves no server or build behind.
  const stops = STOPS.map(signal => [signal, () => {
    server.kill()
    rmSync(dir, { recursive: true, force: true })
    rmSync(output, { recursive: true, force: true })
    process.exit(128 + constants.signals[signal])
  }] as const)

  for (const [signal, stop] of stops)
    process.once(signal, stop)

  const stop = async () => {
    for (const [signal, handler] of stops)
      process.off(signal, handler)

    // A server that drains, or ignores SIGTERM, is not waited on for long.
    server.kill()

    if (await Promise.race([server.exited, Bun.sleep(STOP_WAIT_MS)]) === undefined)
      server.kill('SIGKILL')

    await server.exited
    await Promise.all([rm(dir, { recursive: true, force: true }), rm(output, { recursive: true, force: true })])
  }

  const listening = async () => ({ port: await served })
  const exited = async () => {
    await server.exited

    return 'exited' as const
  }
  const outcome = await Promise.race([listening(), exited(), Bun.sleep(SERVE_TIMEOUT_MS)])

  if (outcome === undefined) {
    await stop()

    return `the server did not listen within ${SERVE_TIMEOUT_MS / 1000} s; its entry starts one through Elysia's \`listen()\` or \`Bun.serve\``
  }

  if (outcome === 'exited') {
    await stop()

    return `the server exited with code ${server.exitCode ?? server.signalCode} before it served`
  }

  if (!options.port)
    return { socket, stop }

  if (outcome.port === undefined) {
    await stop()

    return 'the server did not say which port it listens on'
  }

  return { port: outcome.port, stop }
}

// What a SIGKILLed kay render left, named after its pid; a running one's own is left alone.
async function removeLeftovers(dir: string, own: RegExp): Promise<void> {
  let names: string[]

  try {
    names = await readdir(dir)
  }
  // No `.kay` yet, as before a project's first build.
  catch {
    return
  }

  await Promise.all(names.map(async (name) => {
    const pid = own.exec(name)?.[1]

    if (pid === undefined || alive(Number(pid)))
      return

    try {
      await rm(join(dir, name), { recursive: true, force: true })
    }
    // Another user's, in a shared temp directory.
    catch {}
  }))
}
