import type { Server } from 'bun'
import { join } from 'node:path'
import process from 'node:process'
import { loadTraverse } from '../compiler/rewrite'
import { CONFIG_FILE, loadConfig } from '../config'
import { reloadableFolders } from '../content/edit'
import { projectPaths } from '../project'
import { forgetModules } from '../server/bundle'
import { announceReload, stopRunning } from '../server/dev'
import { registerEarlyLoader } from '../server/loader'
import { disposeOwned, onReload } from '../server/reload'
import { loopbackTaken } from './loopback'
import { planReload } from './reload'
import '../server'
// The `.kay` loader's plugin loads now too: only registering it waits for the start line, as registering reads the app's config.
import '../build/plugin'

// Preloaded into the server process `kay dev` starts: kay and its compiler load while the first types are written, before anything waits on them.
// Bun runs the entry once this resolves, as the main module, when `kay dev` writes a line.
// The process then stays for the session: a change to what kay loads itself reloads the changed modules and runs the entry again, which takes over the server it started.
loadTraverse()
// The debugger `kay dev --inspect` opens is this process's: a Bun process the app starts would fail to open it again.
delete process.env.BUN_INSPECT

const START_LINE = /^start (\d+)(?: (?:(\d+):(\d+)|-) (\d+) ([^\n]*))?/
// The line an entry prints once it listens, as apps scaffolded before kay printed its own did: `kay dev` prints the address itself, once for every restart.
const LISTENING_LINE = /^Listening on https?:\/\/[^/\s]+:(\d+)\/?$/

// Output within this of a report is part of the same burst, which `kay dev` already knows of.
const OUTPUT_THROTTLE_MS = 20

// How many ports past a busy one a server tries before giving up.
const PORTS_TRIED = 100
// Where a server listens when the app names no hostname: this machine alone, unless `kay dev --host` opens it to the network.
const HOST = process.env.KAY_DEV_HOST ?? 'localhost'

// An exported or `.env` `HOST` is production's address and must not open the development server to the network, so the app's `process.env.HOST` is left unset here.
delete process.env.HOST

// The first server the entry starts is the one `kay dev` reports.
let port: number | undefined
// The port the last run asked for and the one it moved to, which this run takes first when it asks for the same.
let moved: [asked: number, to: number] | undefined
const serve = Bun.serve.bind(Bun)

// Every server the first run of the entry started, with what it asked for. A reload takes them over in the same order: each `Bun.serve` of the run that follows swaps its handlers into the server of the same turn.
const started: { server: Server<unknown>, asked: string }[] = []
// Which run of the entry the process is on, and how many servers it started so far.
let run = 0
let calls = 0
// Set while the entry runs again: the apps of the run before stop without stopping the servers, which the run after keeps.
let reloading = false
// Why the run being loaded cannot take over, as an entry asking for another port or a server fewer.
let mismatch: string | undefined
// How far the process may grow from its first reload before the next change starts a new one: Bun caches the code of the ES modules it evaluates again, up to 2000 of them, which adds up to about the size of the modules reloaded long before that.
const GROWTH_LIMIT = (Number(process.env.KAY_DEV_RELOAD_GROWTH_MB) || 64) * 1024 * 1024
let grownFrom: number | undefined

delete process.env.KAY_DEV_RELOAD_GROWTH_MB

Bun.serve = ((given: Parameters<typeof Bun.serve>[0]) => {
  const options = hosted(given)

  if (run > 0)
    return rejoin(options, calls++)

  const asked = askedPort(options)
  // `--port` and an exported or `.env` `PORT` are the visitor's word on the port, which a busy one is told rather than moved off.
  const named = asked !== undefined && [process.env.PORT, process.env.BUN_PORT, process.env.NODE_PORT].some(value => value !== undefined && Number(value) === asked)
  const local = 'hostname' in options && options.hostname === 'localhost'
  const first = moved !== undefined && moved[0] === asked ? moved[1] : asked
  let server: Server<unknown> | undefined

  // A busy port moves the server to the next free one, rather than another app or another `kay dev` holding it stopping this one.
  for (let tried = 0; server === undefined; tried++) {
    const next = asked === undefined || tried === 0 ? first : asked + tried

    try {
      if (local && next !== undefined && loopbackTaken(next))
        throw Object.assign(new Error(`port ${next} is taken on a loopback address`), { code: 'EADDRINUSE' })

      server = serve(next === asked ? options : { ...options, port: next } as typeof options)
    }
    catch (error) {
      if ((error as { code?: unknown }).code === 'EADDRINUSE' && named)
        throw new Error(`kay dev: port ${asked} is in use, and --port or PORT asked for it, so the server was not moved to another`, { cause: error })

      if (asked === undefined || tried === PORTS_TRIED || (error as { code?: unknown }).code !== 'EADDRINUSE')
        throw error
    }
  }

  if (port === undefined && server.port !== undefined) {
    port = server.port
    process.send?.({ listening: server.url.href, port, asked })
  }

  started.push({ server, asked: signature(options) })
  calls++

  return held(server, 0)
}) as typeof Bun.serve

// What a server cannot change once it listens: where it does.
function signature(options: Parameters<typeof Bun.serve>[0]): string {
  const { unix, hostname, tls } = options as { unix?: string, hostname?: string, tls?: unknown }

  return JSON.stringify([unix, hostname, askedPort(options), tls !== undefined])
}

// The run after the first asks for a server: the one of the same turn takes its handlers over, when it asks for the same address.
function rejoin(options: Parameters<typeof Bun.serve>[0], turn: number): Server<unknown> {
  const kept = started[turn]

  if (kept === undefined) {
    mismatch = 'the entry starts more servers than it did'

    return started[0]!.server
  }

  if (kept.asked !== signature(options)) {
    mismatch = 'the entry asks for another address than the server it started'

    return kept.server
  }

  kept.server.reload(options)

  return held(kept.server, run)
}

// What the app of a run gets for its server: it stops the server only while its run is the latest, so an app stopped for a reload leaves the server to the next, and a late `reload` of an earlier run does not undo the next one's handlers.
function held(server: Server<unknown>, owner: number): Server<unknown> {
  return new Proxy(server, {
    get(target, name): unknown {
      if (name === 'stop')
        return async (force?: boolean) => reloading || owner !== run ? undefined : target.stop(force)

      if (name === 'reload')
        return (options: Parameters<Server<unknown>['reload']>[0]) => owner === run ? target.reload(options) : target

      const value: unknown = Reflect.get(target, name, target)

      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
}

const log = console.log.bind(console)
// Set by `kay dev` only where it collapses repeated lines, so a piped, json or custom-log run leaves the app's console and streams untouched.
const reportsOutput = process.env.KAY_DEV_REPORTS_OUTPUT !== undefined

delete process.env.KAY_DEV_REPORTS_OUTPUT

let reported = -OUTPUT_THROTTLE_MS

// `kay dev` hears of the app's output, so it never rewrites a line the app printed after.
function noteOutput() {
  const now = performance.now()

  if (now - reported >= OUTPUT_THROTTLE_MS) {
    reported = now
    process.send?.({ output: true })
  }
}

console.log = (...data: unknown[]) => {
  if (data.length !== 1 || typeof data[0] !== 'string' || LISTENING_LINE.exec(data[0])?.[1] !== String(port)) {
    if (reportsOutput)
      noteOutput()

    log(...data)
  }
}

if (reportsOutput) {
  for (const method of ['info', 'warn', 'error', 'debug'] as const) {
    const print = console[method].bind(console)

    console[method] = (...data: unknown[]) => {
      noteOutput()
      print(...data)
    }
  }

  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (...args: unknown[]) => boolean

    stream.write = (...args: unknown[]) => {
      noteOutput()

      return write(...args)
    }
  }
}

const reader = Bun.stdin.stream().getReader()
const decoder = new TextDecoder()
let line = ''

// The whole line, which a long list of changed files spreads over several reads.
while (!line.includes('\n')) {
  const { done, value } = await reader.read()

  // Input closed without a line: `kay dev` is gone, so this server never starts.
  if (done)
    process.exit(0)

  line += decoder.decode(value, { stream: true })
}

// The line counts the changes so far other than to stylesheets, which pages compare to know whether reloading their styles is enough, then gives the count the last server started with and the files changed since, which a page on that count may swap in.
const [, codeVersion, movedFrom, movedTo, startedAt, changed] = START_LINE.exec(line) ?? []

if (movedFrom !== undefined && movedTo !== undefined)
  moved = [Number(movedFrom), Number(movedTo)]

if (codeVersion !== undefined)
  process.env.KAY_DEV_CODE = codeVersion

if (startedAt !== undefined && changed !== undefined) {
  process.env.KAY_DEV_FROM = startedAt
  process.env.KAY_DEV_CHANGED = changed
}

reader.releaseLock()

// The options with the hostname kay dev listens on, when they name none and no Unix socket.
function hosted(options: Parameters<typeof Bun.serve>[0]): Parameters<typeof Bun.serve>[0] {
  if (('unix' in options && options.unix !== undefined) || ('hostname' in options && options.hostname !== undefined))
    return options

  return { ...options, hostname: HOST } as typeof options
}

// The TCP port a server asks for, as Bun picks it when the options name none; none for a Unix socket or a port the system picks.
function askedPort(options: Parameters<typeof Bun.serve>[0]): number | undefined {
  if ('unix' in options && options.unix !== undefined)
    return undefined

  const asked = Number(('port' in options ? options.port : undefined) ?? process.env.BUN_PORT ?? process.env.PORT ?? process.env.NODE_PORT ?? 3000)

  return Number.isInteger(asked) && asked > 0 ? asked : undefined
}

// Once `KAY_DEV_CODE` is set, which turns the inspector on. A project that cannot load its config fails in `pages()`, which serves the error.
try {
  await registerEarlyLoader(process.cwd())
}
catch {}

interface ReloadRequest {
  code: number
  startedAt: number
  // The files changed since the run before, from the root, as the page swap reads them: a JSON list, or `null` for too many to name.
  changed: string
  // The files this change came from, which decide what to import again; null for all of them.
  files: string[] | null
}

// `kay dev` sends the next one once this answers.
process.on('message', (message: unknown) => {
  if (typeof message === 'object' && message !== null && 'reload' in message)
    void reload(message.reload as ReloadRequest)
})

// A `kay dev` that is gone, however it ended, takes its server with it: nothing else would stop a server that only an IPC channel ties to it.
process.on('disconnect', () => process.exit(0))

// An entry that ends on its own ends the process, as it does without a channel to `kay dev`.
;(process as { channel?: { unref?: () => void } }).channel?.unref?.()

// What the modules of the app open on their own, a listener on the process, an interval or a `Bun.SQL` pool, is let go of when the module runs again; what kay opens for them, as rooms and session stores, does the same itself.
for (const method of ['on', 'once', 'addListener', 'prependListener', 'prependOnceListener'] as const) {
  const add = process[method].bind(process) as (event: string | symbol, listener: (...args: unknown[]) => void) => typeof process

  process[method] = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
    add(event, listener)
    // A library adding `beforeExit` for the app, as Elysia does to stop its server, is the app's; its other listeners may be kept for every caller.
    onReload(() => removeListener(event, listener), event === 'beforeExit' ? 'through' : 'direct')

    return process
  }) as typeof process[typeof method]
}

// Removes a listener however it was added, a `once` one included, which `process.off` takes by the function given.
function removeListener(event: string | symbol, listener: (...args: unknown[]) => void) {
  for (const raw of process.rawListeners(event)) {
    if (raw === listener || (raw as { listener?: unknown }).listener === listener)
      process.off(event, raw as (...args: unknown[]) => void)
  }
}

const forgetters = new WeakMap<object, () => void>()
const startInterval = globalThis.setInterval

globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
  const timer = startInterval(...args)
  const forget = onReload(() => clearInterval(timer), 'direct')

  if (forget !== undefined)
    forgetters.set(timer, forget)

  return timer
}) as typeof setInterval

const stopInterval = globalThis.clearInterval

globalThis.clearInterval = ((timer: Parameters<typeof clearInterval>[0]) => {
  if (typeof timer === 'object' && timer !== null)
    forgetters.get(timer)?.()

  stopInterval(timer)
}) as typeof clearInterval

try {
  Bun.SQL = new Proxy(Bun.SQL, {
    construct(target, args, newTarget) {
      return opened(Reflect.construct(target, args, newTarget) as InstanceType<typeof Bun.SQL>)
    },
    apply(target, self, args) {
      return opened(Reflect.apply(target, self, args) as InstanceType<typeof Bun.SQL>)
    },
  })
}
catch {}

function opened(sql: InstanceType<typeof Bun.SQL>): InstanceType<typeof Bun.SQL> {
  // Without a timeout, closing waits for the queries still pending.
  onReload(async () => sql.close({ timeout: 0 }), 'direct')

  return sql
}

// Imports again the modules the change left stale and runs the entry once more, its servers taking over the ones listening; answers `kay dev` that it did, or that this change needs a new process.
async function reload(request: ReloadRequest): Promise<void> {
  let answer: Awaited<ReturnType<typeof reloaded>>

  try {
    answer = await reloaded(request)
  }
  catch {
    answer = { restart: 'the reload failed' }
  }

  process.send?.(answer)
}

async function reloaded({ code, startedAt, changed, files }: ReloadRequest): Promise<{ reloaded: true } | { restart: string }> {
  const root = process.cwd()
  let paths: ReturnType<typeof projectPaths>

  try {
    paths = projectPaths(root, await loadConfig(root))
  }
  catch {
    return { restart: 'the config does not load' }
  }

  const collectionFolders = reloadableFolders()
  const plan = files === null ? { restart: 'too many files changed' } : planReload({ root, changed: files, loaded: Object.keys(require.cache), owned: [paths.routes, paths.api], content: collectionFolders === undefined ? undefined : { file: paths.content, folders: collectionFolders }, config: join(root, CONFIG_FILE), entry: Bun.main })

  if ('restart' in plan)
    return plan

  if (started.length === 0)
    return { restart: 'the entry started no server' }

  const rss = process.memoryUsage.rss()

  grownFrom ??= rss

  if (rss - grownFrom > GROWTH_LIMIT)
    return { restart: 'the server process grew with its reloads' }

  process.env.KAY_DEV_CODE = String(code)
  process.env.KAY_DEV_FROM = String(startedAt)
  process.env.KAY_DEV_CHANGED = changed
  reloading = true

  try {
    await stopRunning()
    await disposeOwned(new Set(plan.evict))

    forgetModules()

    for (const file of plan.evict)
      delete require.cache[file]

    run++
    calls = 0
    mismatch = undefined
    await import(Bun.main)
  }
  catch (error) {
    // The entry threw, which a new process would have too.
    console.error(error)
    process.exit(1)
  }
  finally {
    reloading = false
  }

  if (mismatch !== undefined)
    return { restart: mismatch }

  if (calls !== started.length)
    return { restart: 'the entry starts fewer servers than it did' }

  announceReload()

  return { reloaded: true }
}
