import type { HealthConfig } from '../config'
import { readdir, readlink } from 'node:fs/promises'
import process from 'node:process'
import { KayError } from '../compiler/errors'
import { HEALTH_PATH } from '../server/lifecycle'

const START_TIMEOUT_MS = 30_000
const POLL_MS = 50
const STOP_TIMEOUT_MS = 5_000
const OUTPUT_LINES = 40
const OUTPUT_GRACE_MS = 500
const SETTLE_MS = 250
const GROUP_POLL_MS = 25
// The process group id is the fifth field of /proc/<pid>/stat, after the command in parentheses and the state and parent id.
const STAT_GROUP = /^\d+ \(.*\) \S (\d+) (\d+)/s
const INTERRUPTS = { SIGINT: 130, SIGHUP: 129, SIGTERM: 143 } as const
const WHITESPACE = /\s+/
const DIGITS = /^\d+$/
const SOCKET_LINK = /^socket:\[(\d+)\]$/
const LISTENING = '0A'

// Starts the executable on a free port as a deploy would, waits until its health route answers 200, runs it again as `--health` the way a container's health check does, then stops it.
// A server that exits before it answers fails with its own output, one that never answers within 30 s with what it printed so far.
// An answer only counts when the socket answering it belongs to the server's own process group (where /proc says so, on Linux) and the server is still running a moment later, as another process that took the port between picking it and the server binding it would answer for a server that then exits.
// The server runs in a group of its own, which is stopped whole: nothing it spawned outlives the verify, an interrupted build included, as the group no longer gets the terminal's signals.
export async function verifyExecutable(executable: string, root: string, health: HealthConfig | false | undefined, startTimeoutMs = START_TIMEOUT_MS): Promise<number> {
  const started = performance.now()
  const port = String(await freePort())
  const env = { ...process.env, NODE_ENV: 'production', PORT: port }
  const server = Bun.spawn([executable], { cwd: root, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: true })
  const printed = capture(server)
  const running = () => server.exitCode === null && server.signalCode === null
  const live = new Set<Bun.Subprocess>([server])
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

  try {
    const url = `http://127.0.0.1:${port}${health === false ? '/' : health?.path ?? HEALTH_PATH}`
    let ready = false

    while (!ready && running() && performance.now() - started < startTimeoutMs) {
      ready = await answers(url, health === false) && await ownsPort(server.pid, Number(port)) !== false

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

      const [code, error] = await Promise.all([probe.exited, new Response(probe.stderr).text()])

      await stop(probe)
      live.delete(probe)

      if (code !== 0)
        throw new KayError('executable-failed', `kay: the executable run with --health exited with code ${code} though the server answered\n${tail(error)}`.trimEnd())
    }
  }
  finally {
    for (const { signal, handler } of interrupts)
      process.off(signal, handler)

    for (const child of live)
      await stop(child)

    await printed.close()
  }

  return performance.now() - started
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

  while (signalGroup(server, 0) && performance.now() < deadline)
    await Bun.sleep(GROUP_POLL_MS)

  if (!signalGroup(server, 'SIGKILL'))
    server.kill('SIGKILL')

  await server.exited
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
  const parents = new Map<string, string>()
  const members = new Set<string>()

  for (const pid of await readdir('/proc')) {
    if (!DIGITS.test(pid))
      continue

    try {
      const stat = STAT_GROUP.exec(await Bun.file(`/proc/${pid}/stat`).text())

      parents.set(pid, stat?.[1] ?? '')

      if (stat?.[2] === String(group))
        members.add(pid)
    }
    catch {}
  }

  for (let grew = true; grew;) {
    grew = false

    for (const [pid, parent] of parents) {
      if (!members.has(pid) && members.has(parent)) {
        members.add(pid)
        grew = true
      }
    }
  }

  return [...members]
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
