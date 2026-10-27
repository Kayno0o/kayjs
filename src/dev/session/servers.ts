import type { Subprocess } from 'bun'
import type { DevOptions } from '../index'
import type { DevPorts, Phase } from './ports'
import type { Reporter } from './report'
import { rm } from 'node:fs/promises'
import { CONFIG_FILE } from '../../config'
import { writeDevAddress } from '../address'
import { inspectorProxy } from '../inspector'
import { stylesOnly } from '../sources'
import { MAX_CHANGED_FILES, tell } from './ports'

// How long a server gets to reload its modules before the change starts a new process: an entry stuck on top-level work, or a process that stopped answering.
const RELOAD_TIMEOUT_MS = 5000
// A process creeps by about 70 KB per reload, so it is replaced before that adds up.
const MAX_RELOADS = 200

// The address of a server listening on the root path, as kay's do, reads better without its slash.
const ROOT_PATH = /(?<=\/\/[^/]+)\/$/
const STOP_SIGNALS = new Set<Subprocess['signalCode']>(['SIGINT', 'SIGTERM', 'SIGHUP'])
// A server listening on every address is reached on this machine as localhost.
const ANY_ADDRESS = /(?<=\/\/)(?:0\.0\.0\.0|\[::\])(?=:)/

// What the supervisor is built with, and what the session hears of its servers.
export interface ServerSetup {
  root: string
  options: Pick<DevOptions, 'port' | 'host' | 'inspect' | 'onRestart'>
  env: Record<string, string | undefined>
  ports: DevPorts
  reporter: Reporter
  phase: () => Phase
  // Settled once the first types write, which tells a config that does not load, is over.
  verified: Promise<void>
  // When the session began, which the count of changes starts from.
  clock: number
  // The entry a new process runs, the config's as the types last read it.
  entry: () => string
  received: (server: Subprocess, message: unknown) => void
  // The running server exited on its own.
  exited: (code: number) => void
}

// What a reload carries, taken as it is sent: an edit arriving meanwhile belongs to the next one.
export interface Sent {
  code: number
  files: string[]
}

// A running server's report that it listens.
export interface Heard {
  url: string
  ms: number
  // The port asked for, when the server moved off it as it was busy.
  inUse: number | undefined
  // It listens on every address, so it may be reached from the network.
  anyAddress: boolean
}

// The server processes of the session: the one running, the one spawned ahead of its start line, which it loads kay while it waits for, the reloads the running one takes, and what each is told as it starts.
export class ServerSupervisor {
  child: Subprocess<'pipe'> | undefined
  // The entry the running process was started with, which a new entry ends.
  runningEntry: string | undefined
  // A process was started, as opposed to only spawned ahead of its start line.
  booted = false
  address: string | undefined
  readonly inspector: ReturnType<typeof inspectorProxy> | undefined
  // What the last restart came from and when it began, for its report, `r` pressed when nothing changed.
  restartedAt = performance.now()
  restartedFor: string[] = []
  restartAsked = false
  // Whether the running process has a server listening, so its first run of the entry is over and it can reload.
  private listening = false
  // Bun reads these as a process starts, so changing one needs a process started after it.
  private startupChanged = false
  private waiting: Subprocess<'pipe'> | undefined
  private waitingEntry: string | undefined
  // Answers a reload with how it ended: reloaded, why it needs a new process, or that the process exited meanwhile.
  private reloadAnswer: ((answer: string) => void) | undefined
  // The reloads the running process took, which bound its memory: Bun keeps some of every module it loaded again, so the process is replaced after MAX_RELOADS.
  private reloads = 0
  // Counts every change but a stylesheet's: an open page whose server comes back with the same count only needs its stylesheets again.
  // It starts from the clock, so a page left open across two `kay dev` runs never takes the new run's count for its own.
  private codeVersion: number
  // The count the last server started with, and the files changed since, each with the count of its last change, in the order they last changed: a page on that count may swap in what changed.
  private startedAt: number
  private changedFiles = new Map<string, number>()
  // The port the first server asked for and the one it moved to, busy, which every next server takes first.
  private moved: string | undefined
  // The port the running server's pages are on, the one origin besides debug.bun.sh a page may reach the debugger from.
  private pagePort: number | undefined
  // The inspector socket of each server process.
  private sockets = new Map<Subprocess, string>()

  constructor(private setup: ServerSetup) {
    const { clock, options } = setup

    this.codeVersion = clock
    this.startedAt = clock
    this.inspector = options.inspect === undefined ? undefined : inspectorProxy(options.inspect, () => this.child && this.sockets.get(this.child), () => this.pagePort)
  }

  // A file changed: one Bun reads as a process starts (`startup`) needs a new process, and one other than a stylesheet is swapped in by open pages.
  changed(file: string, startup: boolean) {
    this.startupChanged ||= startup

    if (stylesOnly(file))
      return

    this.codeVersion++
    this.changedFiles.delete(file)
    this.changedFiles.set(file, this.codeVersion)
  }

  // A change for no file: open pages load the page again.
  outdatePages() {
    this.codeVersion++
  }

  began(files: string[], asked: boolean) {
    this.restartedAt = performance.now()
    this.restartedFor = files
    this.restartAsked = asked
  }

  spawnWaiting() {
    this.waiting?.kill()
    this.waiting = this.spawn()
    this.waitingEntry = this.runningEntry
    this.startupChanged = false
  }

  // A new process, taking the one spawned ahead of its start line when it is still right for it.
  start() {
    this.booted = true

    if (this.startupChanged || this.waiting === undefined || this.waiting.exitCode !== null || this.waitingEntry !== this.setup.entry())
      this.spawnWaiting()

    const started = this.waiting!

    this.child = started
    this.listening = false
    this.reloads = 0
    this.waiting = undefined
    void started.stdin.write(`start ${this.codeVersion} ${this.moved ?? '-'} ${this.startedAt} ${JSON.stringify(this.changedFiles.size > MAX_CHANGED_FILES ? null : [...this.changedFiles.keys()])}\n`)
    this.startedAt = this.codeVersion
    this.changedFiles = new Map()
    void started.stdin.flush()
    this.setup.options.onRestart?.(started)
    void this.reportExit(started)
  }

  // Whether the running process can take the change in: it is up, the environment and the entry are the ones it started with, and no key asked for a new one.
  reloadable(files: string[], asked: boolean): boolean {
    return !asked && !this.startupChanged && this.listening && this.reloads < MAX_RELOADS && this.child !== undefined && this.child.exitCode === null && this.runningEntry === this.setup.entry() && !files.includes(CONFIG_FILE)
  }

  sent(): Sent {
    return { code: this.codeVersion, files: [...this.changedFiles.keys()] }
  }

  // Asks the running process to import the modules the change reached again; answers 'reloaded', or why it needs a new process, or 'exited'. The entry waits for the client `building`, so the clock starts once it settled.
  async reload(server: Subprocess<'pipe'>, files: string[], sent: Sent, building: Promise<unknown> | undefined): Promise<string> {
    const answer = new Promise<string>((resolve) => {
      this.reloadAnswer = resolve
    })
    let timeout: ReturnType<typeof setTimeout> | undefined
    let answered = false

    try {
      server.send({ reload: { code: this.codeVersion, startedAt: this.startedAt, changed: JSON.stringify(sent.files.length > MAX_CHANGED_FILES ? null : sent.files), files: files.length > MAX_CHANGED_FILES ? null : files } })
    }
    catch {
      this.reloadAnswer?.('exited')
    }

    const armed = (async () => {
      try {
        await building
      }
      catch {}

      if (!answered)
        timeout = setTimeout(() => this.reloadAnswer?.('the server did not answer in time'), RELOAD_TIMEOUT_MS)
    })()

    try {
      return await answer
    }
    finally {
      answered = true
      void armed
      clearTimeout(timeout)
      this.reloadAnswer = undefined
    }
  }

  // The running process took the reload in: a file changed again since it was sent stays for the next one, as the page on this count has not seen that change.
  reloaded(sent: Sent) {
    this.startedAt = sent.code
    this.reloads++

    for (const [file, changedAt] of this.changedFiles) {
      if (changedAt <= sent.code)
        this.changedFiles.delete(file)
    }
  }

  // A new process loads kay while the one before ends, and starts once it has.
  async replace(previous: Subprocess | undefined) {
    this.spawnWaiting()
    this.child = undefined
    previous?.kill()
    await previous?.exited
    this.start()
  }

  // The running server listens, its first run of the entry over.
  heardListening() {
    this.listening = true
  }

  // The reload in flight ended: `reloaded`, why it needs a new process, or `exited`.
  endReload(how: string) {
    this.reloadAnswer?.(how)
  }

  // A server reports its address over IPC from the preload; only the one running counts.
  heard(server: Subprocess, message: unknown): Heard | undefined {
    if (server !== this.child || typeof message !== 'object' || message === null || !('listening' in message) || typeof message.listening !== 'string')
      return undefined

    const url = message.listening.replace(ROOT_PATH, '').replace(ANY_ADDRESS, 'localhost')
    const ms = Math.round(performance.now() - this.restartedAt)
    const { asked, port } = message as Partial<Record<'asked' | 'port', number>>

    this.moved = asked !== undefined && port !== undefined && asked !== port ? `${asked}:${port}` : undefined
    this.pagePort = port

    return { url, ms, inUse: this.moved === undefined ? undefined : asked, anyAddress: ANY_ADDRESS.test(message.listening) }
  }

  listenedOn(url: string) {
    this.address = url
    writeDevAddress(this.setup.root, url)
  }

  tellTypeErrors(problems: unknown[]) {
    if (this.child !== undefined)
      tell(this.child, { typeErrors: problems })
  }

  kill() {
    this.child?.kill()
    this.waiting?.kill()
  }

  exits(): (Promise<number> | undefined)[] {
    return [this.child?.exited, this.waiting?.exited]
  }

  private spawn() {
    const { root, options, env, ports, reporter } = this.setup
    const socket = this.inspector?.socketFor()

    this.runningEntry = this.setup.entry()

    const server = ports.spawnServer(root, this.runningEntry, { ...env, NODE_ENV: 'development', ...options.port === undefined ? {} : { PORT: String(options.port) }, KAY_DEV_HOST: options.host ?? 'localhost', ...reporter.collapses ? { KAY_DEV_REPORTS_OUTPUT: '1' } : {}, ...socket === undefined ? {} : { BUN_INSPECT: `ws+unix://${socket}` } }, reporter.output, (message, server) => this.setup.received(server, message))

    if (socket !== undefined) {
      this.sockets.set(server, socket)
      void this.forgetSocket(server, socket)
    }

    return server
  }

  // Bun leaves its socket behind as it exits.
  private async forgetSocket(server: Subprocess, socket: string) {
    await server.exited
    this.sockets.delete(server)
    await rm(socket, { force: true })
  }

  // A server killed for a restart or by `kay dev` stopping exits as expected, as does one the terminal interrupted along with `kay dev`; one exiting on its own leaves nothing serving until the next change.
  private async reportExit(server: Subprocess) {
    const code = await server.exited

    // A server dying with a config that does not load is the refusal's to report, once the first types say so.
    await this.setup.verified

    if (server === this.child && this.setup.phase() !== 'stopping' && !STOP_SIGNALS.has(server.signalCode))
      this.setup.exited(code)
  }
}
