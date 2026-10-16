import type { HealthConfig } from '../config'
import process from 'node:process'
import { KayError } from '../compiler/errors'
import { HEALTH_PATH } from '../server/lifecycle'

const START_TIMEOUT_MS = 30_000
const POLL_MS = 50
const STOP_TIMEOUT_MS = 5_000
const OUTPUT_LINES = 40
const OUTPUT_GRACE_MS = 500
const SETTLE_MS = 250

// Starts the executable on a free port as a deploy would, waits until its health route answers 200, runs it again as `--health` the way a container's health check does, then stops it.
// A server that exits before it answers fails with its own output, one that never answers within 30 s with what it printed so far.
// An answer only counts when the server is still running a moment later, as another process that took the port between picking it and the server binding it would answer for a server that then exits.
export async function verifyExecutable(executable: string, root: string, health: HealthConfig | false | undefined, startTimeoutMs = START_TIMEOUT_MS): Promise<number> {
  const started = performance.now()
  const port = String(await freePort())
  const env = { ...process.env, NODE_ENV: 'production', PORT: port }
  const server = Bun.spawn([executable], { cwd: root, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const printed = capture(server)

  try {
    const url = `http://127.0.0.1:${port}${health === false ? '/' : health?.path ?? HEALTH_PATH}`
    let ready = false

    while (!ready && server.exitCode === null && performance.now() - started < startTimeoutMs) {
      ready = await answers(url, health === false)

      if (!ready)
        await Bun.sleep(POLL_MS)
    }

    if (ready) {
      await Bun.sleep(SETTLE_MS)
      ready = server.exitCode === null
    }

    if (!ready) {
      const reason = server.exitCode !== null ? `exited with code ${server.exitCode} before it kept answering` : `did not answer within ${startTimeoutMs / 1000} s`

      if (server.exitCode === null)
        await stop(server)

      throw new KayError('executable-failed', `kay: the executable ${reason}\n${tail(await printed())}`.trimEnd())
    }

    if (health !== false) {
      const probe = Bun.spawn([executable, '--health'], { cwd: root, env, stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' })
      const [code, error] = await Promise.all([probe.exited, new Response(probe.stderr).text()])

      if (code !== 0)
        throw new KayError('executable-failed', `kay: the executable run with --health exited with code ${code} though the server answered\n${tail(error)}`.trimEnd())
    }
  }
  finally {
    await stop(server)
  }

  return performance.now() - started
}

// What the server prints, which a grandchild it left running may keep the pipes open on after it exits: the reader gives up OUTPUT_GRACE_MS after the server is gone, with what it got.
function capture(server: Bun.Subprocess<'ignore', 'pipe', 'pipe'>): () => Promise<string> {
  const chunks: string[] = []
  const readers = [server.stdout, server.stderr].map(stream => stream.getReader())
  const pumps = readers.map(async (reader) => {
    const decoder = new TextDecoder()

    for (let read = await reader.read(); !read.done; read = await reader.read())
      chunks.push(decoder.decode(read.value, { stream: true }))
  })

  return async () => {
    await server.exited
    await Promise.race([Promise.all(pumps), Bun.sleep(OUTPUT_GRACE_MS)])

    await Promise.all(readers.map(async (reader) => {
      try {
        await reader.cancel()
      }
      catch {}
    }))

    return chunks.join('').trim()
  }
}

// A route off, `health: false`, is ready when anything answers on the port.
async function answers(url: string, anything: boolean): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000), redirect: 'manual' })

    return anything || response.ok
  }
  catch {
    return false
  }
}

async function stop(server: Bun.Subprocess): Promise<void> {
  if (server.exitCode !== null)
    return

  server.kill('SIGTERM')

  const timer = setTimeout(() => server.kill('SIGKILL'), STOP_TIMEOUT_MS)

  await server.exited
  clearTimeout(timer)
}

async function freePort(): Promise<number> {
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
  const port = listener.port

  await listener.stop(true)

  return port!
}

function tail(text: string): string {
  return text.split('\n').slice(-OUTPUT_LINES).join('\n')
}
