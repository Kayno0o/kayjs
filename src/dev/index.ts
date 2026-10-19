import type { Subprocess } from 'bun'
import type { Readable } from 'node:stream'
import type { KayConfig } from '../config'
import type { BuildOutcome } from './builder'
import type { ClientBuilder } from './client'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { join, resolve, sep } from 'node:path'
import process from 'node:process'
import { ASSET_EXTENSIONS, KAY_DIR, testWorker } from '../build/assets'
import { CONFIG_FILE, loadConfig } from '../config'
import { projectPaths, savedPublicDir } from '../project'
import { removeDevAddress, writeDevAddress } from './address'
import { startClientBuilder } from './client'
import { inspectorProxy } from './inspector'
import { CONFIG_REFUSED, LOAD, REFUSE } from './refuse'
import { environmentWithoutDotenv, PAGES_ENTRY, stylesOnly, watchProject } from './sources'
import { TypesProcess } from './types-process'

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
  // The config the types are written from, in this process, instead of kay.config.ts as it is by a process of their own: for a test or a caller with a config of its own.
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
  // Stops the start with `ConfigRefused` when kay.config.ts does not load, as the process writing the first types finds out, rather than going on with the defaults as it does after an edit.
  refuseConfig?: boolean | undefined
}

// kay.config.ts does not load; the process that found out has printed why.
export class ConfigRefused extends Error {}

// Long enough to gather the few events one save makes, which come within a millisecond.
const DEBOUNCE_MS = 10
// How long a source an editor's save left missing is waited for, as saving by renaming it away and writing it anew leaves it, on a machine busy enough to stretch the save.
const GONE_WAIT_MS = 200
const PRELOAD = join(import.meta.dir, 'preload.ts')
// How long a server gets to reload its modules before the change starts a new process: an entry stuck on top-level work, or a process that stopped answering.
const RELOAD_TIMEOUT_MS = 5000
// A process creeps by about 70 KB per reload, so it is replaced before that adds up.
const MAX_RELOADS = 200
// How long stopping waits for the types being written before it kills the process writing them.
const TYPES_GRACE_MS = 2000
// How long a restart for an edited config waits for the types to say its entry, a config that does not load being none to wait for.
const ENTRY_WAIT_MS = 3000
// How long the first tree waits for the first server to listen before it is written anyway, as for a server that never does.
const FIRST_TREE_WAIT_MS = 3000

// The root files Bun reads as a process starts.
const STARTUP_FILE = /^(?:\.env.*|package\.json|bunfig\.toml|tsconfig\.json)$/
// The code files, which the process writing the types keeps running through an edit it did not load.
const CODE_FILE = /\.[cm]?[jt]sx?$/
// The files no type reads the contents of: a stylesheet, a markdown entry of a collection, an image, a font or any media an import takes the URL of.
const TYPE_FREE = new RegExp(`\\.(?:css|mdx?|${ASSET_EXTENSIONS.join('|')})$`, 'i')
// The backups Vim, Emacs and JetBrains IDEs move a source to while they write it anew.
const SAVE_BACKUPS = ['~', '___jb_old___', '___jb_tmp___']
// Past this, as after a checkout, the files changed are not passed on, and open pages reload.
const MAX_CHANGED_FILES = 200
// The address of a server listening on the root path, as kay's do, reads better without its slash.
const ROOT_PATH = /(?<=\/\/[^/]+)\/$/
const STOP_SIGNALS = new Set<Subprocess['signalCode']>(['SIGINT', 'SIGTERM', 'SIGHUP'])
const WS_SCHEME = /^ws:\/\//
// A server listening on every address is reached on this machine as localhost.
const ANY_ADDRESS = /(?<=\/\/)(?:0\.0\.0\.0|\[::\])(?=:)/
const CLEAR_SCREEN = '\x1B[2J\x1B[3J\x1B[H'
const CTRL_C = '\x03'
const ESCAPE = '\x1B'
// The interfaces of containers, bridges and VPNs, whose address a phone on the network does not reach.
const VIRTUAL_INTERFACE = /^(?:docker|br-|bridge|veth|virbr|vmnet|vboxnet|tun|utun|tap|wg|tailscale|zt|lxc|lxd|cni|flannel)/
const STDERR = 2
// eslint-disable-next-line no-control-regex -- escape sequences are what it strips
const ANSI_STYLE = /\x1B\[[\d;]*m/g

// Runs the server entry in development and keeps its process through the changes to templates, islands and API modules: the process imports the modules they reached again and runs the entry once more, whose server takes over the one listening.
// A change to anything else, such as the config, the environment or code kay does not load itself, starts a new process.
// The client is built beside it, by a process kept from one change to the next, which a stylesheet edit alone needs no restart for.
// Resolves once watching, with a function stopping the watchers and the server.
export async function dev(projectRoot: string, options: DevOptions = {}): Promise<() => Promise<void>> {
  const root = resolve(projectRoot)
  let child: Subprocess<'pipe'> | undefined
  // Spawned ahead of its start line, which it loads kay while it waits for: the first server when the config is to be checked first.
  let waiting: Subprocess<'pipe'> | undefined
  let waitingEntry: string | undefined
  // The entry the running process was started with, which a new entry ends.
  let runningEntry: string | undefined
  // Answers a reload with how it ended: reloaded, why it needs a new process, or that the process exited meanwhile.
  let reloadAnswer: ((answer: string) => void) | undefined
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
  // Whether the running process has a server listening, so its first run of the entry is over and it can reload.
  let listening = false
  // The reloads the running process took, which bound its memory: Bun keeps some of every module it loaded again, so the process is replaced after MAX_RELOADS.
  let reloads = 0
  // Every file changed since the last restart began, stylesheets included.
  let touched = new Set<string>()
  // The content each file had when a restart took it in, so a late second event of the same save, its content unchanged, restarts nothing.
  const taken = new Map<string, number | bigint>()
  // The config the types are written from, read again once kay.config.ts changes.
  let typesConfig = options.config
  // The types are written beside the restarts, one run at a time and one more once it ends when changes came meanwhile.
  let typesWriting: Promise<void> | undefined
  let typesAgain = false
  // The code files edited while a write ran, whose module the process may have loaded by then.
  const editedWhileWriting: string[] = []
  // The process writing them is kept between writes; only a change to something but `.kay` sources boots a new one, as the config or a module it imports may be what changed.
  const typesProcess = new TypesProcess(root, options.entry)
  let typesFresh = true
  let startedTypes = false
  // Writes the first tree, which waits for the first server to listen so the page comes first; the editors need it, the page does not.
  let writeFirstTree: (() => void) | undefined
  let treeTimer: Timer | undefined
  // The shadow tree and the declarations read the project's sources, config and the names of its public files, so an edit of the contents of a stylesheet, a markdown entry or a media file leaves them as they are.
  const typesRead = (files: string[]) => {
    if (files.length === 0 || files.some(file => !TYPE_FREE.test(file)))
      return true

    const publicDir = savedPublicDir(root) + sep

    return files.some(file => join(root, file).startsWith(publicDir))
  }
  let configRefused = false
  const writeTypes = async () => {
    // Any write of the tree is the first one, so none is left waiting for a server.
    writeFirstTree = undefined
    clearTimeout(treeTimer)
    typesAgain = true
    typesWriting ??= (async () => {
      while (typesAgain) {
        typesAgain = false
        const fresh = typesFresh

        typesFresh = false
        configRefused ||= await regenerateTypes(root, { ...options, config: typesConfig }, options.refuseConfig === true && !startedTypes, typesProcess, fresh)
        startedTypes = true

        if (editedWhileWriting.splice(0).some(file => typesProcess.loaded(file))) {
          typesFresh = true
          typesAgain = true
        }
      }

      typesWriting = undefined
    })()

    return typesWriting
  }
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
  const print = options.log ?? console.log
  // The last rebuild line, kept to be rewritten when the next is the same; anything printed after it, by kay dev or the app, ends it.
  let repeatable: { key: string, count: number, rows: number } | undefined
  const log = (line: string) => {
    repeatable = undefined
    print(line)
  }
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
  const collapses = options.log === undefined && !json && process.stdout.isTTY
  // A rebuild line the one before said already is rewritten with a count, on a terminal only: elsewhere every line stays.
  const sayRebuild = (event: string, fields: object, key: string, line: string) => {
    if (!collapses) {
      say(event, fields, line)

      return
    }

    const count = repeatable?.key === key ? repeatable.count + 1 : 1
    const shown = count > 1 ? `${line} (x${count})` : line

    if (repeatable !== undefined && count > 1)
      process.stdout.write(`\x1B[${repeatable.rows}A\x1B[J`)

    print(shown)
    repeatable = { key, count, rows: Math.max(1, Math.ceil(shown.replace(ANSI_STYLE, '').length / (process.stdout.columns || 80))) }
  }
  const stamp = () => dim(new Date().toLocaleTimeString('en-GB'))
  // A restart or a reload is over, its report the terminal's and the open pages'; `reloaded` says the running process took the change in, where a restart is a new one.
  const restarted = (server: Subprocess, url: string | undefined, reloaded = false) => {
    const ms = Math.round(performance.now() - restartedAt)
    const changed = restartAsked ? 'r pressed' : describe(restartedFor)
    const moved = url !== undefined && url !== address
    const verb = reloaded ? 'reloaded' : 'restarted'

    // Quiet, a restart is said only when it moved the address.
    if (options.quiet !== true || moved)
      sayRebuild('restart', { changed: restartedFor, ms, ...reloaded && { reloaded }, ...url !== undefined && { url } }, `${changed}: ${verb}${moved ? `, now on ${url}` : ''}`, `${stamp()} ${changed}: ${verb} in ${ms} ms${moved ? `, now on ${url}` : ''}`)

    tell(server, { built: { changed, ms, ...reloaded && { reloaded } } })
  }
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
      writeFirstTree?.()

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
      restarted(server, url)
    }

    address = url
    writeDevAddress(root, url)
  }

  // Settled once the first types write, which tells a config that does not load, is over.
  const verified = Promise.withResolvers<void>()
  // A server killed for a restart or by `kay dev` stopping exits as expected, as does one the terminal interrupted along with `kay dev`; one exiting on its own leaves nothing serving until the next change.
  const reportExit = async (server: Subprocess) => {
    const code = await server.exited

    // A server dying with a config that does not load is the refusal's to report, once the first types say so.
    await verified.promise

    if (server === child && !stopping && !STOP_SIGNALS.has(server.signalCode)) {
      writeFirstTree?.()
      reloadAnswer?.('exited')
      say('exit', { code }, `${stamp()} the server exited with code ${code}, waiting for a change`)
    }
  }

  const env = await environmentWithoutDotenv()
  // Set once the first types settled, which say a config that does not load: until then a builder started ahead of them stays quiet about its own exit.
  let typesSettled = false
  // The builder exited before the types settled, so its notice waits for them.
  let builderExitHeld = false
  const sayBuilderExit = () => {
    if (!builderExitSaid)
      say('builder-exit', {}, `${stamp()} the process building the client exited; each change starts it again, the servers building their own until one build succeeds`)

    builderExitSaid = true
  }
  const buildClientNow = async (): Promise<BuildOutcome | undefined> => {
    if (ownClient || stopping)
      return undefined

    if (builderStale || builder?.gone() === true) {
      await builder?.stop()
      builder = startClientBuilder(root, env, json ? STDERR : 'inherit', !typesSettled)
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
      if (typesSettled)
        sayBuilderExit()
      else
        builderExitHeld = true
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

    let state: 'none' | 'failed' | 'built' = 'none'

    if (outcome !== undefined)
      state = outcome.failed ? 'failed' : 'built'

    try {
      server.send({ client: state })
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

    if ('output' in message)
      repeatable = undefined

    if ('followsStyles' in message)
      follower = server

    if (server === child && 'listening' in message)
      listening = true

    if (server === child && 'reloaded' in message)
      reloadAnswer?.('reloaded')

    if (server === child && 'restart' in message && typeof message.restart === 'string')
      reloadAnswer?.(message.restart)

    // The server logged it already; only `json` repeats it, as an event.
    if ('devError' in message && json && typeof message.devError === 'object')
      say('error', message.devError ?? {}, '')

    listened(server, message)
  }
  // A running server that reads the build takes the stylesheets of an edit to stylesheets alone; false when it needs a restart instead, as when the build failed.
  const swapStylesheets = async (files: string[]) => {
    if (files.length === 0 || !files.every(stylesOnly) || child === undefined || follower !== child || builder === undefined || builderStale)
      return false

    const server = child
    const started = performance.now()
    const outcome = await (building = buildClient())

    if (!outcome || outcome.failed || server !== child)
      return false

    // A root Markdown file naming no pruned class leaves the stylesheets as they are.
    if (outcome.styles === undefined)
      return true

    const named = changedFilesNamed(root, files)
    const changed = describe(named)
    const ms = Math.round(performance.now() - started)

    tell(server, { styles: outcome.styles, built: { changed, ms, styles: true } })

    if (options.quiet !== true)
      sayRebuild('styles', { changed: named, ms }, `${changed}: stylesheets swapped`, `${stamp()} ${changed}: stylesheets swapped in ${ms} ms`)

    return true
  }
  // Chosen again for each process, so a `src/server.ts` written or deleted while running takes over at the next restart.
  // The config's `entry` comes from the process writing the types, which loads the config; `--entry` wins.
  const entryToRun = () => {
    const entry = projectPaths(root, { ...typesConfig, entry: options.entry ?? typesConfig?.entry }).entry
    const file = options.entry === undefined ? typesProcess.configuredEntry ?? entry : entry

    return options.entry === undefined && !existsSync(file) ? PAGES_ENTRY : file
  }
  const spawn = () => {
    const socket = inspector?.socketFor()

    runningEntry = entryToRun()

    const server = Bun.spawn([process.execPath, '--preload', PRELOAD, runningEntry], { cwd: root, env: { ...env, NODE_ENV: 'development', ...options.port === undefined ? {} : { PORT: String(options.port) }, KAY_DEV_HOST: options.host ?? 'localhost', ...collapses ? { KAY_DEV_REPORTS_OUTPUT: '1' } : {}, ...socket === undefined ? {} : { BUN_INSPECT: `ws+unix://${socket}` } }, stdin: 'pipe', stdout: json ? STDERR : 'inherit', stderr: 'inherit', ipc: (message, server) => received(server, message) })

    if (socket !== undefined) {
      sockets.set(server, socket)
      void forgetSocket(server, socket)
    }

    return server
  }

  const spawnWaiting = () => {
    waiting?.kill()
    waiting = spawn()
    waitingEntry = runningEntry
    startupChanged = false
  }

  // A new process, taking the one spawned ahead of its start line when it is still right for it.
  let booted = false
  const start = () => {
    booted = true

    if (startupChanged || waiting === undefined || waiting.exitCode !== null || waitingEntry !== entryToRun())
      spawnWaiting()

    const started = waiting!

    child = started
    listening = false
    reloads = 0
    waiting = undefined
    void started.stdin.write(`start ${codeVersion} ${moved ?? '-'} ${startedAt} ${JSON.stringify(changedFiles.size > MAX_CHANGED_FILES ? null : [...changedFiles])}\n`)
    startedAt = codeVersion
    changedFiles = new Set()
    void started.stdin.flush()
    options.onRestart?.(started)
    void reportExit(started)
  }
  // Whether the running process can take the change in: it is up, the environment and the entry are the ones it started with, and no key asked for a new one.
  const reloadable = (files: string[], asked: boolean) => !asked && !startupChanged && listening && reloads < MAX_RELOADS && child !== undefined && child.exitCode === null && runningEntry === entryToRun() && !files.includes(CONFIG_FILE)
  // Asks the running process to import the modules the change reached again; answers 'reloaded', or why it needs a new process, or 'exited'.
  const reload = async (server: Subprocess<'pipe'>, files: string[], sent: string): Promise<string> => {
    const answer = new Promise<string>((resolve) => {
      reloadAnswer = resolve
    })
    let timeout: ReturnType<typeof setTimeout> | undefined
    let answered = false

    try {
      server.send({ reload: { code: codeVersion, startedAt, changed: sent, files: files.length > MAX_CHANGED_FILES ? null : files } })
    }
    catch {
      reloadAnswer?.('exited')
    }

    // The entry waits for the client build, so the clock starts once it settled.
    const armed = (async () => {
      try {
        await building
      }
      catch {}

      if (!answered)
        timeout = setTimeout(() => reloadAnswer?.('the server did not answer in time'), RELOAD_TIMEOUT_MS)
    })()

    try {
      return await answer
    }
    finally {
      answered = true
      void armed
      clearTimeout(timeout)
      reloadAnswer = undefined
    }
  }
  // The server never reads the generated types, only the editor and `kay check` do, so it starts before they are rewritten; an edited config is the exception, as the types tell its entry.
  // The client builds while the last server stops and the next one boots, which waits for it only once it asks.
  const restart = async () => {
    const files = [...touched]

    const asked = forced

    touched = new Set()
    forced = false

    for (const file of files) {
      const hash = contentHash(join(root, file))

      if (hash === undefined)
        taken.delete(file)
      else
        taken.set(file, hash)
    }

    if (!asked && await swapStylesheets(files))
      return

    restartedAt = performance.now()
    restartedFor = changedFilesNamed(root, files)
    restartAsked = asked && files.length === 0
    building = wantsClient ? buildClient() : undefined

    // The entry is the config's, which the types read: they are written first for an edited config, so the process starts on the entry just saved rather than the one before.
    // A config that never loads must not hold the restart, so the wait is bounded, and a write ending later with another entry restarts again.
    const configEdited = files.includes(CONFIG_FILE)
    let entryWrite: Promise<void> | undefined

    if (configEdited) {
      if (typesConfig !== undefined)
        typesConfig = await reloadConfig(root, typesConfig)

      typesFresh = true
      entryWrite = writeTypes()
      const gave = Promise.withResolvers<void>()
      const giveUp = setTimeout(gave.resolve, ENTRY_WAIT_MS)

      await Promise.race([entryWrite, gave.promise])
      clearTimeout(giveUp)
    }

    const previous = child
    const server = reloadable(files, asked) ? previous : undefined
    // What the reload carries, taken as it is sent: an edit arriving meanwhile belongs to the next one.
    const sentCode = codeVersion
    const sentFiles = new Set(changedFiles)
    const answer = server === undefined ? undefined : await reload(server, files, JSON.stringify(sentFiles.size > MAX_CHANGED_FILES ? null : [...sentFiles]))

    if (answer === 'reloaded') {
      startedAt = sentCode
      reloads++

      for (const file of sentFiles)
        changedFiles.delete(file)

      restarted(server!, undefined, true)
    }
    // The server exited on its own while it reloaded, which `reportExit` says: nothing runs until the next change.
    else if (answer !== 'exited') {
      // A new process loads kay while the one before ends, and starts once it has.
      spawnWaiting()
      child = undefined
      previous?.kill()
      await previous?.exited
      start()
    }

    if (entryWrite !== undefined) {
      void (async () => {
        await entryWrite

        if (!stopping && child !== undefined && entryToRun() !== runningEntry)
          restartNow()
      })()
    }

    if (!configEdited && typesRead(files)) {
      // A code file the process did not load is read from disk by the write, so only the others need a new process.
      typesFresh ||= files.length === 0 || files.some(file => !file.endsWith('.kay') && (!CODE_FILE.test(file) || typesProcess.loaded(file)))

      // A write in flight may load a module this edit touched, which its answer reports: checked once it ends.
      if (typesWriting !== undefined)
        editedWhileWriting.push(...files.filter(file => CODE_FILE.test(file)))

      void writeTypes()
    }
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
    if (taken.has(file) && contentHash(join(root, file)) === taken.get(file))
      return

    startupChanged ||= STARTUP_FILE.test(file)

    if (STARTUP_FILE.test(file) || file === CONFIG_FILE || builder?.loaded(file) === true) {
      builderStale = true
      ownClient = false
    }

    unbuilt?.add(file)

    if (!stylesOnly(file)) {
      codeVersion++
      changedFiles.add(file)
    }

    touched.add(file)

    clearTimeout(timer)
    timer = setTimeout(settle, DEBOUNCE_MS)
  }, {
    rootNaming: true,
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
      if (key === 'o' && address !== undefined) {
        openBrowser(address, command => log(`kay dev: no browser to open ${address} with: ${command} is not installed`))
      }
      else if (key === 'r') {
        restartNow()
      }
      else if (key === 'c') {
        repeatable = undefined
        process.stdout.write(CLEAR_SCREEN)
      }
      else if (key === 'q' || key === CTRL_C) {
        options.onQuit?.()
      }
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

  const stop = async () => {
    stopping = true

    if (options.keys !== undefined) {
      options.keys.off('data', onKey)
      options.keys.pause()
      restoreTerminal()
      process.off('exit', restoreTerminal)
    }

    clearTimeout(timer)
    clearTimeout(treeTimer)
    stopWatching()
    removeDevAddress(root)
    await restarting
    typesAgain = false
    child?.kill()
    waiting?.kill()

    // A types process stuck importing the config is killed rather than waited for.
    if (typesWriting !== undefined) {
      const grace = setTimeout(() => typesProcess.close(), TYPES_GRACE_MS)

      try {
        await typesWriting
      }
      finally {
        clearTimeout(grace)
      }
    }

    typesProcess.close()
    await Promise.all([child?.exited, waiting?.exited, builder?.stop()])
    await inspector?.stop()
  }

  // An earlier run left a client build: its builder starts beside the first types and server instead of once the server asks, and stays quiet until the types settle.
  if (building === undefined && existsSync(join(root, KAY_DIR, `dev${testWorker()}`, 'manifest.json'))) {
    wantsClient = true

    const early = buildClient()

    building = early
    // A failure shows where a server awaits it.
    void (async () => {
      try {
        await early
      }
      catch {}
    })()
  }

  // Asked to refuse a config that does not load, the first server waits for the first types: its own boot failure would print the same error again. The process it will run in loads kay meanwhile.
  // The same holds while the config is still to be read for its `entry`, which the types do.
  if (options.refuseConfig === true || (options.config === undefined && options.entry === undefined))
    spawnWaiting()
  else
    start()

  // Given no config, the process writing the types reads it first, which is all the first server waits for.
  const deferred = options.config === undefined

  try {
    if (deferred) {
      configRefused = await typesProcess.write(false, options.refuseConfig === true ? REFUSE : '', LOAD) === CONFIG_REFUSED
      typesFresh = false
      startedTypes = true
      writeFirstTree = () => {
        writeFirstTree = undefined
        clearTimeout(treeTimer)

        if (!stopping)
          void writeTypes()
      }
      treeTimer = setTimeout(() => writeFirstTree?.(), FIRST_TREE_WAIT_MS)
      treeTimer.unref()

      // A server started ahead of the answer may be listening already.
      if (address !== undefined)
        writeFirstTree()
    }
    else {
      await writeTypes()
    }
  }
  finally {
    typesSettled = true
    // A config that does not load is the types' to report, once; any other crash of the builder shows its error and the notice.
    builder?.release(!configRefused)

    if (builderExitHeld && !configRefused && !stopping)
      sayBuilderExit()

    verified.resolve()
  }

  if (!booted && !configRefused && !stopping)
    start()

  if (configRefused) {
    await stop()

    throw new ConfigRefused()
  }

  return stop
}

// The hash of a file's content, or none for a file that is missing or a directory.
function contentHash(path: string): number | bigint | undefined {
  try {
    return Bun.hash(readFileSync(path))
  }
  catch {
    return undefined
  }
}

// The files a change left in place, which leaves out the directories holding them and an editor's temporary files; a deletion names what is gone.
function changedFilesNamed(root: string, files: string[]): string[] {
  if (files.length > MAX_CHANGED_FILES)
    return files

  const kept = files.filter(file => statSync(join(root, file), { throwIfNoEntry: false })?.isFile() === true)

  return kept.length > 0 ? kept : files.filter(file => !files.some(other => other.startsWith(`${file}/`)))
}

// The system's browser, or the command `BROWSER` names.
function browserCommand(): string[] {
  if (process.env.BROWSER !== undefined && process.env.BROWSER !== '')
    return [process.env.BROWSER]

  if (process.platform === 'darwin')
    return ['open']

  return process.platform === 'win32' ? ['cmd', '/c', 'start', '""'] : ['xdg-open']
}

// `missing` hears of a machine without a browser.
function openBrowser(url: string, missing: (command: string) => void): void {
  const command = browserCommand()

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
// Without a `config` it is written by a process of its own from kay.config.ts as it is now, which keeps the checker out of this one and reads again every module the config imports.
// Whether, asked to `refuse`, the process found kay.config.ts does not load.
async function regenerateTypes(root: string, { entry, config }: DevOptions, refuse: boolean, types: TypesProcess, fresh: boolean): Promise<boolean> {
  try {
    if (config === undefined)
      return await types.write(fresh, refuse ? REFUSE : '') === CONFIG_REFUSED

    const { configCheckOptions, writeShadowTypes } = await import('../check')

    await writeShadowTypes(root, { ...configCheckOptions(config), entry: entry ?? config.entry, typesOnly: true })
  }
  catch (error) {
    console.error(error)
  }

  return false
}

export { environmentWithoutDotenv, PAGES_ENTRY, serverSources, watchProject } from './sources'
