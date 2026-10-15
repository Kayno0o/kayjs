import type { Subprocess } from 'bun'
import type { FSWatcher } from 'node:fs'
import type { Readable } from 'node:stream'
import type { KayConfig } from '../config'
import type { BuildOutcome } from './builder'
import type { ClientBuilder } from './client'
import { existsSync, readdirSync, readFileSync, statSync, watch } from 'node:fs'
import { rm } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { findProjectFiles, IGNORED_DIRS } from '../build/files'
import { configCheckOptions, writeShadowTypes } from '../check'
import { CONFIG_FILE, loadConfig } from '../config'
import { projectPaths } from '../project'
import { startClientBuilder } from './client'
import { inspectorProxy } from './inspector'

export interface DevOptions {
  // The server entry, relative to the root, `src/server.ts` by default; with no file there, a server of kay's own serves the pages.
  entry?: string | undefined
  // The `PORT` the server gets, over the shell's and the `.env`'s.
  port?: number | undefined
  // The address a server listens on when the app names none, `localhost` by default, so nothing past this machine reaches it; `0.0.0.0` opens it to the network.
  host?: string | undefined
  // The address of the debugger every server opens, such as `ws://localhost:6499/kay`.
  inspect?: string | undefined
  // Opens the address in the browser once the first server listens.
  open?: boolean | undefined
  // The project's kay.config.ts, which `.kay/types` is written from as `kay check` writes it.
  config?: KayConfig | undefined
  // Called with each server process once it is spawned.
  onRestart?: ((child: Subprocess) => void) | undefined
  // Where the address, each restart and a server exiting on its own are reported, `console.log` by default.
  log?: ((line: string) => void) | undefined
  // `json` reports each as one JSON object per line, the errors the servers meet included, and sends the servers' own output to stderr.
  format?: 'text' | 'json' | undefined
  // The terminal's keys, read once the first server listens: `o` opens the address, `r` restarts, `c` clears the screen, `q` or Ctrl+C calls `onQuit`.
  keys?: Readable | undefined
  // Leaves out the line per restart and stylesheet swap, and the keys' hint: the ready line, the addresses, a restart moving the address and the errors stay.
  quiet?: boolean | undefined
  onQuit?: (() => void) | undefined
}

// Long enough to gather the few events one save makes, which come within a millisecond.
const DEBOUNCE_MS = 10
// How long a source an editor's save left missing is waited for, as saving by renaming it away and writing it anew leaves it, on a machine busy enough to stretch the save.
const GONE_WAIT_MS = 200
const SPARE = join(import.meta.dir, 'spare.ts')
// When a server never says it is up, as one that never serves, the next process starts anyway after this: a guess, which also starts it beside a server that takes longer to boot.
const SPARE_FALLBACK_MS = 2000

// The server of a project with no entry of its own, as a static site is.
export const PAGES_ENTRY = join(import.meta.dir, 'pages.ts')
// The root files Bun reads as a process starts.
const STARTUP_FILE = /^(?:\.env.*|package\.json|bunfig\.toml|tsconfig\.json)$/
const STYLESHEET = /\.css$/
const NEWLINE = /\r?\n/
const LEADING_SLASH = /^\//
const TRAILING_SLASH = /\/$/
// A pattern naming anything but one plain directory at the root.
const GLOB_OR_DEEPER = /[*?[\]/]/
// The root files a server reads: what Bun reads as it starts, the lockfile, and what a module can import. A README, a licence or a justfile is none of them.
const SERVER_ROOT_FILE = /^(?:\.env.*|bun\.lockb?)$|\.(?:[cm]?[jt]sx?|json[c5]?|toml|ya?ml|kay|css|txt|html|sql|graphql|gql|wasm|node)$/
// Tests, which no server imports.
const TEST_DIRS = new Set(['tests', 'test', '__tests__', 'e2e'])
const TEST_FILE = /(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/
// The backups Vim, Emacs and JetBrains IDEs move a source to while they write it anew.
const SAVE_BACKUPS = ['~', '___jb_old___', '___jb_tmp___']
// The files editors write beside a source while saving it, its backup, swap or temporary copy, Vim's `4913` and Emacs' `.#` lock included.
const EDITOR_SCRATCH = /(?:~|\.sw[opx]|\.tmp|___jb_(?:tmp|old)___|\.kate-swp)$|(?:^|\/)(?:4913|\.#[^/]*|#[^/]*#)$/
// Past this, as after a checkout, the files changed are not passed on, and open pages reload.
const MAX_CHANGED_FILES = 200
// The address of a server listening on the root path, as kay's do, reads better without its slash.
const ROOT_PATH = /(?<=\/\/[^/]+)\/$/
const STOP_SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGHUP'])
const WS_SCHEME = /^ws:\/\//
// A server listening on every address is reached on this machine as localhost.
const ANY_ADDRESS = /(?<=\/\/)(?:0\.0\.0\.0|\[::\])(?=:)/
const ANY_FILE = /^/
const CLEAR_SCREEN = '\x1B[2J\x1B[3J\x1B[H'
const CTRL_C = '\x03'
const ESCAPE = '\x1B'
// The interfaces of containers, bridges and VPNs, whose address a phone on the network does not reach.
const VIRTUAL_INTERFACE = /^(?:docker|br-|bridge|veth|virbr|vmnet|vboxnet|tun|utun|tap|wg|tailscale|zt|lxc|lxd|cni|flannel)/
const STDERR = 2

// Runs the server entry in development and restarts it on every change; a fresh process is the only way to drop modules Bun has loaded.
// The client is built beside it, by a process kept from one change to the next, which a stylesheet edit alone needs no restart for.
// Resolves once watching, with a function stopping the watchers and the server.
export async function dev(projectRoot: string, options: DevOptions = {}): Promise<() => Promise<void>> {
  const root = resolve(projectRoot)
  const entry = projectPaths(root, options).entry
  let child: Subprocess<'pipe'> | undefined
  let spare: Subprocess<'pipe'> | undefined
  let spareEntry: string | undefined
  let timer: Timer | undefined
  let changed = false
  // Bun reads these as a process starts, so changing one needs a process started after it.
  let startupChanged = false
  let restarting: Promise<void> | undefined
  let stopping = false
  // Counts every change but a stylesheet's: an open page whose server comes back with the same count only needs its stylesheets again.
  // It starts from the clock, so a page left open across two `kay dev` runs never takes the new run's count for its own.
  let codeVersion = Date.now()
  // The count the last server started with, and the files changed since: a page on that count may swap in what changed.
  let startedAt = codeVersion
  let changedFiles = new Set<string>()
  // Every file changed since the last restart began, stylesheets included.
  let touched = new Set<string>()
  // The config the types are written from, read again once kay.config.ts changes.
  let typesConfig = options.config
  // What the last restart came from and when it began, for its report, `r` pressed when nothing changed.
  let restartedFor: string[] = []
  let restartAsked = false
  // `r` was pressed since the last restart began, which restarts even when only stylesheets changed.
  let forced = false
  let restartedAt = performance.now()
  let address: string | undefined
  // The port the first server asked for and the one it moved to, busy, which every next server takes first.
  let moved: string | undefined
  // Started once a server asks for the client, and again once a file it loaded changes or it is gone.
  let builder: ClientBuilder | undefined
  let builderStale = true
  // One build at a time, so a restart never starts a second process while the last build still waits on the first.
  let lastBuild: Promise<unknown> = Promise.resolve()
  // Said once until a build succeeds again, as the process's own error already shows.
  let builderExitSaid = false
  // A server asked for the client, so the next ones will: each restart starts building it at once.
  let wantsClient = false
  // `pages()` was given other options than kay.config.ts holds, so the servers bundle their own until the config changes.
  let ownClient = false
  // The build the running server reads, and the files changed since the last one began, null for all of them.
  let building: Promise<BuildOutcome | undefined> | undefined
  let unbuilt: Set<string> | null = null
  // The server swapping in the stylesheets of a stylesheet edit, once it said it reads the build.
  let follower: Subprocess | undefined
  const log = options.log ?? console.log
  // The inspector socket of each server process.
  const sockets = new Map<Subprocess, string>()
  // The port the running server's pages are on, the one origin besides debug.bun.sh a page may reach the debugger from.
  let pagePort: number | undefined
  const inspector = options.inspect === undefined ? undefined : inspectorProxy(options.inspect, () => child && sockets.get(child), () => pagePort)
  // Bun leaves its socket behind as it exits.
  const forgetSocket = async (server: Subprocess, socket: string) => {
    await server.exited
    sockets.delete(server)
    await rm(socket, { force: true })
  }
  const json = options.format === 'json'
  // One event, as a line of text, or as a JSON object of its fields under `json`.
  const say = (event: string, fields: object, line: string) => log(json ? JSON.stringify({ event, time: new Date().toISOString(), ...fields }) : line)
  const color = options.log === undefined && !json && process.stdout.isTTY && process.env.NO_COLOR === undefined
  const dim = (text: string) => color ? `\x1B[2m${text}\x1B[22m` : text
  const stamp = () => dim(new Date().toLocaleTimeString('en-GB'))
  // A server reports its address over IPC from the preload; only the one running counts, and only the first time it listens.
  const listened = (server: Subprocess, message: unknown) => {
    if (server !== child || typeof message !== 'object' || message === null || !('listening' in message) || typeof message.listening !== 'string')
      return

    const url = message.listening.replace(ROOT_PATH, '').replace(ANY_ADDRESS, 'localhost')
    const ms = Math.round(performance.now() - restartedAt)
    const took = `${ms} ms`
    const { asked, port } = message as Partial<Record<'asked' | 'port', number>>

    moved = asked !== undefined && port !== undefined && asked !== port ? `${asked}:${port}` : undefined
    pagePort = port

    if (address === undefined) {
      const network = ANY_ADDRESS.test(message.listening) ? networkAddress() : undefined
      const reached = network === undefined ? undefined : url.replace('//localhost', `//${network}`)

      say('ready', { url, ms, ...moved !== undefined && { inUse: asked }, ...reached !== undefined && { network: reached } }, `kay dev: ${url} (ready in ${took}${moved === undefined ? '' : `, ${asked} was in use`})`)

      if (reached !== undefined && !json)
        log(`kay dev: ${reached} on the network`)

      if (inspector !== undefined)
        say('debugger', { url: inspector.url }, `kay dev: debugger on ${inspector.url}, https://debug.bun.sh/#${inspector.url.replace(WS_SCHEME, '')}`)

      if (options.open === true)
        openBrowser(url, command => say('no-browser', { command }, `kay dev: no browser to open ${url} with: ${command} is not installed`))

      if (options.keys !== undefined) {
        if (options.quiet !== true)
          log(`kay dev: ${dim('press o to open it in the browser, r to restart, c to clear the screen, q to quit')}`)

        readKeys(options.keys)
      }
    }
    else {
      const changed = restartAsked ? 'r pressed' : describe(restartedFor)

      // Quiet, a restart is said only when it moved the address.
      if (options.quiet !== true || url !== address)
        say('restart', { changed: restartedFor, ms, url }, `${stamp()} ${changed}: restarted in ${took}${url === address ? '' : `, now on ${url}`}`)

      tell(server, { built: { changed, ms } })
    }

    address = url
    readySpare()
  }

  // A server killed for a restart or by `kay dev` stopping exits as expected, as does one the terminal interrupted along with `kay dev`; one exiting on its own leaves nothing serving until the next change.
  const reportExit = async (server: Subprocess) => {
    const code = await server.exited

    if (server === child && !stopping && !STOP_SIGNALS.has(server.signalCode ?? '')) {
      say('exit', { code }, `${stamp()} the server exited with code ${code}, waiting for a change`)
      readySpare()
    }
  }

  const env = await environmentWithoutDotenv()
  const buildClientNow = async (): Promise<BuildOutcome | undefined> => {
    if (ownClient || stopping)
      return undefined

    if (builderStale || builder?.gone() === true) {
      await builder?.stop()
      builder = startClientBuilder(root, env, json ? STDERR : 'inherit')
      builderStale = false
      unbuilt = null
    }

    const files = unbuilt === null || unbuilt.size > MAX_CHANGED_FILES ? null : [...unbuilt]
    const current = builder

    unbuilt = new Set()

    const outcome = await current?.build(files)

    if (outcome) {
      builderExitSaid = false

      return outcome
    }

    // Gone on its own while building, as when the config failed to load: the next build starts it again.
    if (current !== undefined && current === builder && !stopping && !ownClient) {
      if (!builderExitSaid)
        say('builder-exit', {}, `${stamp()} the process building the client exited; each change starts it again, the servers building their own until one build succeeds`)

      builderExitSaid = true
    }

    return undefined
  }
  const buildClient = async (): Promise<BuildOutcome | undefined> => {
    const previous = lastBuild
    const build = (async () => {
      try {
        await previous
      }
      catch {}

      return buildClientNow()
    })()

    lastBuild = build

    return build
  }
  const answerClient = async (server: Subprocess) => {
    const outcome = await (building ??= buildClient())

    try {
      server.send({ client: outcome === undefined ? 'none' : outcome.failed ? 'failed' : 'built' })
    }
    // Killed for a restart meanwhile.
    catch {}
  }
  const received = (server: Subprocess, message: unknown) => {
    if (typeof message !== 'object' || message === null)
      return

    if ('wantsClient' in message) {
      wantsClient = true
      void answerClient(server)
    }

    if ('ownClient' in message) {
      ownClient = true
      void builder?.stop()
      builder = undefined
    }

    if ('followsStyles' in message)
      follower = server

    if ('serving' in message && server === child)
      readySpare()

    // The server logged it already; only `json` repeats it, as an event.
    if ('devError' in message && json && typeof message.devError === 'object')
      say('error', message.devError ?? {}, '')

    listened(server, message)
  }
  // A running server that reads the build takes the stylesheets of an edit to stylesheets alone; false when it needs a restart instead, as when the build failed.
  const swapStylesheets = async (files: string[]) => {
    if (files.length === 0 || !files.every(file => STYLESHEET.test(file)) || child === undefined || follower !== child || builder === undefined || builderStale)
      return false

    const server = child
    const started = performance.now()
    const outcome = await (building = buildClient())

    if (!outcome || outcome.failed || server !== child)
      return false

    const named = changedFilesNamed(root, files)
    const changed = describe(named)
    const ms = Math.round(performance.now() - started)

    tell(server, { ...outcome.styles && { styles: outcome.styles }, built: { changed, ms, styles: true } })

    if (options.quiet !== true)
      say('styles', { changed: named, ms }, `${stamp()} ${changed}: stylesheets swapped in ${ms} ms`)

    return true
  }
  // Chosen again for each process, so a `src/server.ts` written or deleted while running takes over at the next restart.
  const entryToRun = () => options.entry === undefined && !existsSync(entry) ? PAGES_ENTRY : entry
  const spawn = () => {
    const socket = inspector?.socketFor()

    spareEntry = entryToRun()

    const server = Bun.spawn([process.execPath, '--preload', SPARE, spareEntry], { cwd: root, env: { ...env, NODE_ENV: 'development', ...options.port === undefined ? {} : { PORT: String(options.port) }, KAY_DEV_HOST: options.host ?? 'localhost', ...socket === undefined ? {} : { BUN_INSPECT: `ws+unix://${socket}` } }, stdin: 'pipe', stdout: json ? STDERR : 'inherit', stderr: 'inherit', ipc: (message, server) => received(server, message) })

    if (socket !== undefined) {
      sockets.set(server, socket)
      void forgetSocket(server, socket)
    }

    return server
  }

  // The next process waits with kay loaded, started once the running server is up or exits, so it never competes with that server's boot.
  function readySpare() {
    if (spare === undefined && !stopping)
      spare = spawn()
  }

  // Each restart takes the process waiting with kay loaded, or a fresh one when none is ready yet.
  const start = () => {
    if (startupChanged || spare === undefined || spare.exitCode !== null || spareEntry !== entryToRun()) {
      spare?.kill()
      spare = spawn()
      startupChanged = false
    }

    child = spare
    spare = undefined
    void child.stdin.write(`start ${codeVersion} ${moved ?? '-'} ${startedAt} ${JSON.stringify(changedFiles.size > MAX_CHANGED_FILES ? null : [...changedFiles])}\n`)
    startedAt = codeVersion
    changedFiles = new Set()
    void child.stdin.flush()
    options.onRestart?.(child)
    void reportExit(child)

    const started = child

    setTimeout(() => started === child && readySpare(), SPARE_FALLBACK_MS).unref()
  }
  // The server never reads the generated types, only the editor and `kay check` do, so it starts before they are rewritten.
  // The client builds while the last server stops and the next one boots, which waits for it only once it asks.
  const restart = async () => {
    const files = [...touched]

    const asked = forced

    touched = new Set()
    forced = false

    if (!asked && await swapStylesheets(files))
      return

    restartedAt = performance.now()
    restartedFor = changedFilesNamed(root, files)
    restartAsked = asked && files.length === 0
    building = wantsClient ? buildClient() : undefined

    const previous = child

    child = undefined
    previous?.kill()
    await previous?.exited
    start()

    if (typesConfig !== undefined && files.includes(CONFIG_FILE))
      typesConfig = await reloadConfig(root, typesConfig)

    await regenerateTypes(root, { ...options, config: typesConfig })
  }
  // Changes landing during a restart trigger one more, never two restarts at once.
  const drain = async () => {
    while (changed) {
      changed = false
      await restart()
    }

    restarting = undefined
  }
  let scratchWritten = -Infinity
  let waitingSince: number | undefined
  let waited = false
  // A deleted source restarts at once, while one a save left missing a moment, its backup beside it or the editor's scratch files just written, is waited for.
  const settle = () => {
    const now = performance.now()
    const saving = (file: string) => !existsSync(join(root, file)) && (now - scratchWritten < GONE_WAIT_MS || SAVE_BACKUPS.some(suffix => existsSync(join(root, file + suffix))))

    waitingSince ??= now
    const wait = now - waitingSince < GONE_WAIT_MS && [...touched].some(saving)

    // A file seen back on disk has its event still to come, which one more tick gathers instead of restarting again for it.
    if (wait || waited) {
      waited = wait
      timer = setTimeout(settle, DEBOUNCE_MS)

      return
    }

    waitingSince = undefined
    changed = true
    restarting ??= drain()
  }
  const stopWatching = watchProject(root, (file) => {
    startupChanged ||= STARTUP_FILE.test(file)

    if (STARTUP_FILE.test(file) || file === CONFIG_FILE || builder?.loaded(file) === true) {
      builderStale = true
      ownClient = false
    }

    unbuilt?.add(file)

    if (!STYLESHEET.test(file)) {
      codeVersion++
      changedFiles.add(file)
    }

    touched.add(file)

    clearTimeout(timer)
    timer = setTimeout(settle, DEBOUNCE_MS)
  }, {
    onScratch: () => {
      scratchWritten = performance.now()
    },
  })

  // A terminal in raw mode hands over each key as it is pressed, Ctrl+C included, which no longer interrupts; an escape sequence, as Alt+key or an arrow sends, is none of them.
  const onKey = (chunk: Buffer | string) => {
    const keys = String(chunk)

    if (keys.startsWith(ESCAPE))
      return

    for (const key of keys) {
      if (key === 'o' && address !== undefined)
        openBrowser(address, command => log(`kay dev: no browser to open ${address} with: ${command} is not installed`))
      else if (key === 'r')
        restartNow()
      else if (key === 'c')
        process.stdout.write(CLEAR_SCREEN)
      else if (key === 'q' || key === CTRL_C)
        options.onQuit?.()
    }
  }
  const rawMode = (on: boolean) => {
    const keys = options.keys as Readable & { setRawMode?: (mode: boolean) => void }

    keys.setRawMode?.(on)
  }
  const restoreTerminal = () => rawMode(false)

  function readKeys(keys: Readable) {
    rawMode(true)
    process.once('exit', restoreTerminal)
    keys.on('data', onKey)
  }

  // As a change does, but for no file: open pages load the page again. A change still waiting on the debounce goes with it, its timer cleared so it does not restart again for nothing.
  function restartNow() {
    clearTimeout(timer)
    waitingSince = undefined
    waited = false
    forced = true
    codeVersion++
    changed = true
    restarting ??= drain()
  }

  start()
  await regenerateTypes(root, options)

  return async () => {
    stopping = true

    if (options.keys !== undefined) {
      options.keys.off('data', onKey)
      options.keys.pause()
      restoreTerminal()
      process.off('exit', restoreTerminal)
    }

    clearTimeout(timer)
    stopWatching()
    await restarting
    child?.kill()
    spare?.kill()
    await Promise.all([child?.exited, spare?.exited, builder?.stop()])
    await inspector?.stop()
  }
}

// The files a change left in place, which leaves out the directories holding them and an editor's temporary files; a deletion names what is gone.
function changedFilesNamed(root: string, files: string[]): string[] {
  if (files.length > MAX_CHANGED_FILES)
    return files

  const kept = files.filter(file => statSync(join(root, file), { throwIfNoEntry: false })?.isFile() === true)

  return kept.length > 0 ? kept : files.filter(file => !files.some(other => other.startsWith(`${file}/`)))
}

// The system's browser, or the command `BROWSER` names; `missing` hears of a machine without one.
function openBrowser(url: string, missing: (command: string) => void): void {
  const command = process.env.BROWSER !== undefined && process.env.BROWSER !== '' ? [process.env.BROWSER] : process.platform === 'darwin' ? ['open'] : process.platform === 'win32' ? ['cmd', '/c', 'start', '""'] : ['xdg-open']

  try {
    Bun.spawn([...command, url], { stdio: ['ignore', 'ignore', 'ignore'] }).unref()
  }
  catch {
    missing(command[0]!)
  }
}

// The address of this machine others on its network reach it by: the first of an interface no container, bridge or VPN made, else the first.
export function networkAddress(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string | undefined {
  const external = Object.entries(interfaces).flatMap(([name, entries]) => (entries ?? []).filter(entry => entry.family === 'IPv4' && !entry.internal).map(entry => ({ name, address: entry.address })))

  return (external.find(entry => !VIRTUAL_INTERFACE.test(entry.name)) ?? external[0])?.address
}

// A server killed for a restart meanwhile takes no message.
function tell(server: Subprocess, message: object): void {
  try {
    server.send(message)
  }
  catch {}
}

// The files a restart came from, as its report names them.
function describe(files: string[]): string {
  const [first] = files

  if (first === undefined)
    return 'a change'

  return files.length === 1 ? first : `${first} and ${files.length - 1} more`
}

// A config that fails to load, halfway through an edit say, leaves the last one in place; the server reports why.
async function reloadConfig(root: string, last: KayConfig): Promise<KayConfig> {
  try {
    return await loadConfig(root, true)
  }
  catch {
    return last
  }
}

// Keeps editors and `tsgo` in step with the `.kay` sources; type errors themselves are `kay check`'s job.
async function regenerateTypes(root: string, { entry, config }: DevOptions) {
  try {
    await writeShadowTypes(root, { ...configCheckOptions(config ?? {}), entry })
  }
  catch (error) {
    console.error(error)
  }
}

// What Bun loaded from the `.env` files of the directory this process started in, as it read them then: the child loads them again, but never over a variable already set.
// A variable the shell set to the very value its `.env` holds cannot be told from one the file set, and follows the file.
export async function environmentWithoutDotenv(): Promise<Record<string, string | undefined>> {
  const probe = Bun.spawn([process.execPath, '-e', 'console.log(JSON.stringify(process.env))'], { cwd: process.cwd(), env: process.env.NODE_ENV === undefined ? {} : { NODE_ENV: process.env.NODE_ENV }, stdout: 'pipe', stderr: 'ignore' })
  const [output, code] = await Promise.all([new Response(probe.stdout).text(), probe.exited])

  if (code !== 0)
    return process.env

  const loaded = JSON.parse(output) as Record<string, string>

  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => loaded[key] !== value))
}

// The root directories the project itself ignores: a service writing its data into the repository, as a bind-mounted database does, must not restart the server on every write.
// Only the plain names a `.gitignore` holds, which is what such a directory is listed as; a pattern reaching deeper or holding a glob is left to the walk.
function gitIgnoredNames(root: string): Set<string> {
  const names = new Set<string>()
  let lines: string[]

  try {
    lines = readFileSync(join(root, '.gitignore'), 'utf8').split(NEWLINE)
  }
  catch {
    return names
  }

  for (const line of lines) {
    const name = line.trim().replace(LEADING_SLASH, '').replace(TRAILING_SLASH, '')

    if (name !== '' && !name.startsWith('#') && !name.startsWith('!') && !GLOB_OR_DEEPER.test(name))
      names.add(name)
  }

  return names
}

// The files the server and its build read, as `kay dev` watches them; `.env` files are read as the server starts, not built.
export async function serverSources(root: string): Promise<string[]> {
  const ignored = gitIgnoredNames(root)

  return (await findProjectFiles(root, ANY_FILE, { project: true })).filter((file) => {
    const path = relative(root, file)
    const [top = path] = path.split(sep)

    if (top === path)
      return SERVER_ROOT_FILE.test(path) && !path.startsWith('.env')

    return watchedName(top) && !ignored.has(top) && !TEST_FILE.test(path)
  })
}

// A directory or file at the project root worth reacting to; dependencies, build output, tests and hidden entries, `.env` files apart, are not.
function watchedName(name: string): boolean {
  return !IGNORED_DIRS.has(name) && !TEST_DIRS.has(name) && (!name.startsWith('.') || name.startsWith('.env'))
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false
  }
  catch {
    return false
  }
}

// The root is watched for the entries it gains and loses, each top-level directory recursively, and a directory created again gets a new watcher, the old one staying on the inode that is gone.
// `onChange` gets the changed path relative to the root, and `onScratch` hears of the files editors write beside a source instead; the returned function stops watching. `tests` watches the tests too, as `kay check` reads them.
export function watchProject(root: string, onChange: (file: string) => void, { tests = false, onScratch }: { tests?: boolean, onScratch?: () => void } = {}): () => void {
  const ignored = gitIgnoredNames(root)
  const watched = (name: string) => (watchedName(name) || (tests && TEST_DIRS.has(name))) && !ignored.has(name)
  const directories = new Map<string, FSWatcher>()
  const watchDirectory = (name: string) => {
    directories.get(name)?.close()
    directories.delete(name)

    if (!isDirectory(join(root, name)))
      return

    // The directory may go between the check and the watch, or the system run out of watchers: `kay dev` keeps going without it.
    try {
      const watcher = watch(join(root, name), { recursive: true }, (_event, file) => {
        if (file !== null && EDITOR_SCRATCH.test(file))
          onScratch?.()
        else if (file === null || tests || !TEST_FILE.test(file))
          onChange(`${name}/${file ?? ''}`)
      })

      watcher.on('error', () => undefined)
      directories.set(name, watcher)
    }
    catch (error) {
      console.error(error)
    }
  }
  const rootWatcher = watch(root, (_event, name) => {
    if (name !== null && EDITOR_SCRATCH.test(name)) {
      onScratch?.()

      return
    }

    if (name === null || !watched(name))
      return

    // A directory gone is still one the server read from.
    const directory = directories.has(name)

    watchDirectory(name)

    if (directory || isDirectory(join(root, name)) || SERVER_ROOT_FILE.test(name))
      onChange(name)
  })

  rootWatcher.on('error', error => console.error(error))

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && watched(entry.name))
      watchDirectory(entry.name)
  }

  return () => {
    rootWatcher.close()
    for (const watcher of directories.values())
      watcher.close()
  }
}
