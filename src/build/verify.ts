import type { HealthConfig } from '../config'
import { readdir, readlink } from 'node:fs/promises'
import process from 'node:process'
import { KayError } from '../compiler/errors'
import { healthTimeoutMs } from '../server/config-limits'
import { HEALTH_PATH } from '../server/lifecycle'

const START_TIMEOUT_MS = 30_000
const PROBE_TIMEOUT_MS = 10_000
// What `--health` may take beyond its own wait for the route, to start and exit.
const PROBE_MARGIN_MS = 5_000
const OWNERSHIP_RETRY_MS = 500
const POLL_MS = 50
const STOP_TIMEOUT_MS = 5_000
const OUTPUT_LINES = 40
const OUTPUT_GRACE_MS = 500
const SETTLE_MS = 250
const GROUP_POLL_MS = 25
// The state, parent id and process group id of /proc/<pid>/stat, which follow the command in parentheses.
const STAT = /^\d+ \(.*\) (\S) (\d+) (\d+)/s
const INTERRUPTS = { SIGINT: 130, SIGHUP: 129, SIGTERM: 143 } as const
const WHITESPACE = /\s+/
const DIGITS = /^\d+$/
const SOCKET_LINK = /^socket:\[(\d+)\]$/
const LISTENING = '0A'

export interface VerifyOptions {
  startTimeoutMs?: number
  probeTimeoutMs?: number
  // Called each time the sockets of the server are looked at, for a test to count them.
  ownershipChecked?: () => void
}

// The longest `--health` may take: 10 s, or `health.timeout` and a margin when the app raises it past that.
export function probeWait(health: HealthConfig | false | undefined): number {
  return Math.max(PROBE_TIMEOUT_MS, (health === false ? 0 : healthTimeoutMs(health)) + PROBE_MARGIN_MS)
}

// Starts the executable on a free port as a deploy would, waits until its health route answers 200, runs it again as `--health` the way a container's health check does, then stops it.
// A server that exits before it answers fails with its own output, one that never answers within 30 s with what it printed so far.
// An answer only counts when the socket answering it belongs to the server's own process group (where /proc says so, on Linux) and the server is still running a moment later, as another process that took the port between picking it and the server binding it would answer for a server that then exits.
// The server runs in a group of its own, which is stopped whole: nothing it spawned outlives the verify, an interrupted build included, as the group no longer gets the terminal's signals.
export async function verifyExecutable(executable: string, root: string, health: HealthConfig | false | undefined, options: VerifyOptions = {}): Promise<number> {
  const { startTimeoutMs = START_TIMEOUT_MS, probeTimeoutMs = probeWait(health) } = options
  const started = performance.now()
  const port = String(await freePort())
  // HOST is pinned to loopback, where the readiness check and `--health` ask, whatever the build's shell or the project's .env exports.
  const env = { ...process.env, NODE_ENV: 'production', PORT: port, HOST: '127.0.0.1' }
  const server = Bun.spawn([executable], { cwd: root, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: true })
  const printed = capture(server)
  const running = () => server.exitCode === null && server.signalCode === null
  const live = new Set<Bun.Subprocess>([server])
  const release = onInterrupt(live)

  try {
    const url = `http://127.0.0.1:${port}${health === false ? '/' : health?.path ?? HEALTH_PATH}`
    let ready = false
    // While another process answers in the server's place, its sockets are looked at again only now and then.
    let foreignUntil = 0

    while (!ready && running() && performance.now() - started < startTimeoutMs) {
      ready = await answers(url, health === false)

      if (ready && performance.now() < foreignUntil) {
        ready = false
      }
      else if (ready) {
        options.ownershipChecked?.()
        ready = await ownsPort(server.pid, Number(port)) !== false
        foreignUntil = ready ? 0 : performance.now() + OWNERSHIP_RETRY_MS
      }

      if (!ready)
        await Bun.sleep(POLL_MS)
    }

    if (ready) {
      await Bun.sleep(SETTLE_MS)
      ready = running()
    }

    if (!ready) {
      const reason = running() ? `did not answer within ${startTimeoutMs / 1000} s` : `${server.signalCode === null ? `exited with code ${server.exitCode}` : `was killed by ${server.signalCode}`} before it kept answering`

      if (running())
        await stop(server)

      throw new KayError('executable-failed', `kay: the executable ${reason}\n${tail(await printed.text())}`.trimEnd())
    }

    if (health !== false) {
      const probe = Bun.spawn([executable, '--health'], { cwd: root, env, stdin: 'ignore', stdout: 'ignore', stderr: 'pipe', detached: true })

      live.add(probe)

      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(resolve, probeTimeoutMs, 'timeout')
      })
      const probed = await Promise.race([Promise.all([probe.exited, new Response(probe.stderr).text()]), timeout])

      clearTimeout(timer)
      await stop(probe)
      live.delete(probe)

      if (probed === 'timeout')
        throw new KayError('executable-failed', `kay: the executable run with --health did not exit within ${probeTimeoutMs / 1000} s though the server answered`)

      const [code, error] = probed

      if (code !== 0)
        throw new KayError('executable-failed', `kay: the executable run with --health exited with code ${code} though the server answered\n${tail(error)}`.trimEnd())
    }
  }
  finally {
    release()

    for (const child of live)
      await stop(child)

    await printed.close()
  }

  return performance.now() - started
}

export interface LoadOptions {
  timeoutMs?: number
}

// Runs the executable as `--load`, which loads every module it carries as the server would and exits before the server entry runs, with the variables the build has: a database or a secret the entry needs is not asked for, as the server is never started.
// A module that fails to load, or a load that takes longer than 30 s, fails with the executable's own output.
export async function loadExecutable(executable: string, root: string, options: LoadOptions = {}): Promise<number> {
  const { timeoutMs = START_TIMEOUT_MS } = options
  const started = performance.now()
  const child = Bun.spawn([executable, '--load'], { cwd: root, env: { ...process.env, NODE_ENV: 'production' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: true })
  const printed = capture(child)
  const release = onInterrupt(new Set([child]))
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(resolve, timeoutMs, 'timeout')
    })

    if (await Promise.race([child.exited, timeout]) === 'timeout') {
      await stop(child)

      throw new KayError('executable-failed', `kay: the executable did not finish loading its modules within ${timeoutMs / 1000} s\n${tail(await printed.text())}`.trimEnd())
    }

    if (child.exitCode !== 0) {
      const how = child.signalCode === null ? `exited with code ${child.exitCode}` : `was killed by ${child.signalCode}`

      throw new KayError('executable-failed', `kay: the executable ${how} while loading its modules\n${tail(await printed.text())}`.trimEnd())
    }
  }
  finally {
    clearTimeout(timer)
    release()
    await stop(child)
    await printed.close()
  }

  return performance.now() - started
}

// Kills the groups of `live` and exits as the signal would when the build is interrupted; the function it gives back takes the handlers off.
function onInterrupt(live: Set<Bun.Subprocess>): () => void {
  const interrupts = Object.entries(INTERRUPTS).map(([signal, code]) => ({
    signal: signal as keyof typeof INTERRUPTS,
    handler: () => {
      for (const child of live)
        signalGroup(child, 'SIGKILL')

      process.exit(code)
    },
  }))

  for (const { signal, handler } of interrupts)
    process.on(signal, handler)

  return () => {
    for (const { signal, handler } of interrupts)
      process.off(signal, handler)
  }
}

// What the server prints, which a grandchild it left running may keep the pipes open on after it exits: the reader gives up OUTPUT_GRACE_MS after the server is gone, with what it got.
function capture(server: Bun.Subprocess<'ignore', 'pipe', 'pipe'>): { text: () => Promise<string>, close: () => Promise<void> } {
  const chunks: string[] = []
  const readers = [server.stdout, server.stderr].map(stream => stream.getReader())
  const pumps = readers.map(async (reader) => {
    const decoder = new TextDecoder()

    for (let read = await reader.read(); !read.done; read = await reader.read())
      chunks.push(decoder.decode(read.value, { stream: true }))

    chunks.push(decoder.decode())
  })

  const close = async () => {
    await Promise.all(readers.map(async (reader) => {
      try {
        await reader.cancel()
      }
      catch {}
    }))
  }

  return {
    text: async () => {
      await server.exited
      await Promise.race([Promise.all(pumps), Bun.sleep(OUTPUT_GRACE_MS)])
      await close()
      await Promise.all(pumps)

      return chunks.join('').trim()
    },
    close,
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

function signalGroup(server: Bun.Subprocess, signal: NodeJS.Signals | 0): boolean {
  try {
    return process.kill(-server.pid, signal)
  }
  catch {
    return false
  }
}

// Stops the server and everything it started: its group is asked to end, then killed once STOP_TIMEOUT_MS has passed.
async function stop(server: Bun.Subprocess): Promise<void> {
  if (!signalGroup(server, 'SIGTERM'))
    server.kill('SIGTERM')

  const deadline = performance.now() + STOP_TIMEOUT_MS

  while (await groupRunning(server) && performance.now() < deadline)
    await Bun.sleep(GROUP_POLL_MS)

  if (!signalGroup(server, 'SIGKILL'))
    server.kill('SIGKILL')

  await server.exited
}

// Whether the group still holds a process that runs: one that no process reaps stays a zombie, and a container without an init leaves them, which are nothing to wait for.
async function groupRunning(server: Bun.Subprocess): Promise<boolean> {
  if (!signalGroup(server, 0))
    return false

  const members = [...(await readStats()).values()].filter(stat => stat.group === String(server.pid))

  return holdsRunning(members.map(stat => stat.state))
}

// Whether any of the states, as /proc gives them, is a process that runs; none listed is taken as one that does, as /proc may not list them.
export function holdsRunning(states: string[]): boolean {
  return states.length === 0 || states.some(state => state !== 'Z')
}

interface Stat {
  state: string
  parent: string
  group: string
}

// The state and the family of each process /proc lists; empty where it lists none.
async function readStats(): Promise<Map<string, Stat>> {
  const stats = new Map<string, Stat>()

  try {
    for (const pid of await readdir('/proc')) {
      if (!DIGITS.test(pid))
        continue

      try {
        const stat = STAT.exec(await Bun.file(`/proc/${pid}/stat`).text())

        if (stat !== null)
          stats.set(pid, { state: stat[1]!, parent: stat[2]!, group: stat[3]! })
      }
      catch {}
    }
  }
  catch {}

  return stats
}

// Whether the socket listening on the port belongs to the server's processes, its group and what its processes started: false when the sockets of all of them were read and it is none of theirs, undefined where /proc cannot say.
async function ownsPort(group: number, port: number): Promise<boolean | undefined> {
  const inodes = new Set<string>()

  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      for (const line of (await Bun.file(table).text()).split('\n').slice(1)) {
        const fields = line.trim().split(WHITESPACE)

        if (fields[3] === LISTENING && Number.parseInt(fields[1]?.slice(fields[1].indexOf(':') + 1) ?? '', 16) === port && fields[9] !== undefined)
          inodes.add(fields[9])
      }
    }
    catch {}
  }

  // An answer with no listener in the table means the table is not to be trusted.
  if (inodes.size === 0)
    return undefined

  const members = await membersOf(group)
  let unreadable = members.length === 0

  for (const pid of members) {
    const sockets = await socketsOf(pid)

    if (sockets === undefined)
      unreadable = true
    else if (sockets.some(inode => inodes.has(inode)))
      return true
  }

  return unreadable ? undefined : false
}

// The processes of the group and those they started, which may have left the group.
async function membersOf(group: number): Promise<string[]> {
  const stats = await readStats()
  const members = new Set<string>()

  for (const [pid, stat] of stats) {
    if (stat.group === String(group))
      members.add(pid)
  }

  for (let grew = true; grew;) {
    grew = false

    for (const [pid, stat] of stats) {
      if (!members.has(pid) && members.has(stat.parent)) {
        members.add(pid)
        grew = true
      }
    }
  }

  return [...members]
}

// The inodes of the sockets a process holds open, undefined when its descriptors cannot be listed; a descriptor that closes while it is read, the directory listing's own among them, is left out.
async function socketsOf(pid: string): Promise<string[] | undefined> {
  const inodes: string[] = []

  try {
    for (const fd of await readdir(`/proc/${pid}/fd`)) {
      try {
        const inode = SOCKET_LINK.exec(await readlink(`/proc/${pid}/fd/${fd}`))?.[1]

        if (inode !== undefined)
          inodes.push(inode)
      }
      catch {}
    }
  }
  catch {
    return undefined
  }

  return inodes
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
