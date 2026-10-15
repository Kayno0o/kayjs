import type { HealthConfig } from '../config'
import process from 'node:process'
import { KayError } from '../compiler/errors'
import { HEALTH_PATH } from '../server/lifecycle'

const START_TIMEOUT_MS = 30_000
const POLL_MS = 50
const STOP_TIMEOUT_MS = 5_000
const OUTPUT_LINES = 40

// Starts the executable on a free port as a deploy would, waits until its health route answers 200, runs it again as `--health` the way a container's health check does, then stops it.
// A server that exits before it answers fails with its own output, one that never answers within 30 s with what it printed so far.
export async function verifyExecutable(executable: string, root: string, health: HealthConfig | false | undefined): Promise<number> {
  const started = performance.now()
  const port = String(await freePort())
  const env = { ...process.env, NODE_ENV: 'production', PORT: port }
  const server = Bun.spawn([executable], { cwd: root, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const output = (async () => (await Promise.all([new Response(server.stdout).text(), new Response(server.stderr).text()])).join('').trim())()

  try {
    const url = `http://127.0.0.1:${port}${health === false ? '/' : health?.path ?? HEALTH_PATH}`
    let ready = false

    while (!ready && server.exitCode === null && performance.now() - started < START_TIMEOUT_MS) {
      ready = await answers(url, health === false)

      if (!ready)
        await Bun.sleep(POLL_MS)
    }

    if (!ready) {
      const reason = server.exitCode !== null ? `exited with code ${server.exitCode} before it answered` : `did not answer within ${START_TIMEOUT_MS / 1000} s`

      if (server.exitCode === null)
        await stop(server)

      throw new KayError('executable-failed', `kay: the executable ${reason}\n${tail(await output)}`.trimEnd())
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
