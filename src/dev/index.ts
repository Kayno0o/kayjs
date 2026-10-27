import type { Subprocess } from 'bun'
import type { Readable } from 'node:stream'
import type { KayConfig } from '../config'
import type { TypeProblem } from './refuse'
import type { DevPorts, Phase } from './session/ports'
import type { RestartBatch } from './session/queue'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { KAY_DIR, testWorker } from '../build/assets'
import { CONFIG_FILE } from '../config'
import { projectPaths } from '../project'
import { removeDevAddress } from './address'
import { startClientBuilder } from './client'
import { readConfigRecord, writeConfigRecord } from './config-record'
import { mentionsPackage } from './fingerprint'
import { ClientController } from './session/client'
import { MAX_CHANGED_FILES, tell } from './session/ports'
import { ChangeQueue } from './session/queue'
import { describe, networkAddress, openBrowser, Reporter } from './session/report'
import { ServerSupervisor } from './session/servers'
import { TypesController } from './session/types'
import { environmentWithoutDotenv, stylesOnly, watchProject } from './sources'
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
  // Stops the start with `ConfigRefusedError` when kay.config.ts does not load, as the process writing the first types finds out, rather than going on with the defaults as it does after an edit.
  refuseConfig?: boolean | undefined
  // Type-checks the project beside the server after each change and shows the errors, `true` by default; `false` is `--no-types`. A `config` given leaves it off, as the check loads kay.config.ts in a process of its own, and so does a project with no tsconfig.json.
  types?: boolean | undefined
}

// kay.config.ts does not load; the process that found out has printed why.
export class ConfigRefusedError extends Error {}

export type { DevPorts, TypesWorker } from './session/ports'

const PRELOAD = join(import.meta.dir, 'preload.ts')
// The root files Bun reads as a process starts.
const STARTUP_FILE = /^(?:\.env.*|package\.json|bunfig\.toml|tsconfig\.json)$/
const PACKAGE_FILE = 'package.json'
// The fields of package.json that no module resolves with or loads differently for: an edit of only these changes nothing a process or the client build reads.
const INERT_PACKAGE_FIELDS = new Set(['scripts', 'version', 'description', 'keywords', 'author', 'contributors', 'license', 'homepage', 'repository', 'bugs', 'funding', 'private', 'files', 'engines', 'packageManager', 'publishConfig'])
const CLEAR_SCREEN = '\x1B[2J\x1B[3J\x1B[H'
const CTRL_C = '\x03'
const ESCAPE = '\x1B'

const PORTS: DevPorts = {
  spawnServer: (root, entry, env, stdout, ipc) => Bun.spawn([process.execPath, '--preload', PRELOAD, entry], { cwd: root, env, stdin: 'pipe', stdout, stderr: 'inherit', ipc }),
  typesProcess: (root, entry, env, idleMs) => new TypesProcess(root, entry, env, idleMs),
  startClientBuilder,
  watchProject,
}

// Runs the server entry in development and keeps its process through the changes to templates, islands and API modules: the process imports the modules they reached again and runs the entry once more, whose server takes over the one listening.
// A change to anything else, such as the config, the environment or code kay does not load itself, starts a new process.
// The client is built beside it, by a process kept from one change to the next, which a stylesheet edit alone needs no restart for.
// The session drives a controller each for the servers, the types, the client build and the reports, from one queue of changes and one phase.
// Resolves once watching, with a function stopping the watchers and the server.
export async function dev(projectRoot: string, options: DevOptions = {}, ports: DevPorts = PORTS): Promise<() => Promise<void>> {
  const clock = Date.now()
  const root = resolve(projectRoot)
  // Where the client build of `kay dev` and what it keeps of the config are written.
  const devDir = join(root, KAY_DIR, `dev${testWorker()}`)
  let phase: Phase = 'starting'
  const currentPhase = () => phase
  const env = await environmentWithoutDotenv(root)
  const reporter = new Reporter(options.log, options.format, options.quiet)
  // Settled once the first types write, which tells a config that does not load, is over.
  const verified = Promise.withResolvers<void>()
  const types = new TypesController(root, options, env, ports, reporter, currentPhase, tellTypeErrors)
  const servers = new ServerSupervisor(root, options, env, ports, reporter, currentPhase, verified.promise, { entry: () => types.entry(), received, exited: serverExited }, clock)
  const client = new ClientController(root, env, ports, reporter, currentPhase)

  function tellTypeErrors(problems: TypeProblem[]) {
    servers.tellTypeErrors(problems)
  }

  // The running server exited on its own: nothing serves until the next change, and the first tree waits for it no more.
  function serverExited(code: number) {
    types.writeFirstTree()
    servers.answer('exited')
    reporter.exit(code)
  }

  // A restart or a reload is over, its report the terminal's and the open pages'; `reloaded` says the running process took the change in, where a restart is a new one.
  function restarted(server: Subprocess, url: string | undefined, reloaded = false) {
    const ms = Math.round(performance.now() - servers.restartedAt)
    const changed = servers.restartAsked ? 'r pressed' : describe(servers.restartedFor)

    reporter.restarted(servers.restartedFor, changed, ms, url, url !== undefined && url !== servers.address, reloaded)
    tell(server, { built: { changed, ms, ...reloaded && { reloaded } } })
  }

  // Only the running server's report counts, and only the first time it listens.
  function listened(server: Subprocess, message: unknown) {
    const heard = servers.heard(server, message)

    if (heard === undefined)
      return

    const { url, ms, inUse, anyAddress } = heard

    if (servers.address === undefined) {
      types.writeFirstTree()

      const network = anyAddress ? networkAddress() : undefined

      reporter.ready(url, ms, inUse, network === undefined ? undefined : url.replace('//localhost', `//${network}`), servers.inspector?.url)

      if (options.open === true)
        openBrowser(url, command => reporter.noBrowser(url, command))

      if (options.keys !== undefined) {
        if (!reporter.quiet)
          reporter.keys()

        readKeys(options.keys)
      }
    }
    else {
      restarted(server, url)
    }

    servers.listenedOn(url)
  }

  function received(server: Subprocess, message: unknown) {
    if (typeof message !== 'object' || message === null)
      return

    if ('wantsClient' in message)
      client.asked(server)

    if ('ownClient' in message)
      client.ownAsked()

    if ('output' in message)
      reporter.endRepeat()

    if ('followsStyles' in message)
      client.follows(server)

    if (server === servers.child && 'listening' in message) {
      servers.heardListening()

      const told = types.toldOnListen()

      if (told !== undefined)
        tell(server, { typeErrors: told })
    }

    if (server === servers.child && 'reloaded' in message)
      servers.answer('reloaded')

    if (server === servers.child && 'restart' in message && typeof message.restart === 'string')
      servers.answer(message.restart)

    // The server logged it already; only `json` repeats it, as an event.
    if ('devError' in message && reporter.json && typeof message.devError === 'object')
      reporter.say('error', message.devError ?? {}, '')

    listened(server, message)
  }

  // A running server that reads the build takes the stylesheets of an edit to stylesheets alone; false when it needs a restart instead, as when the build failed.
  const swapStylesheets = async (files: string[]) => {
    const server = servers.child

    if (files.length === 0 || !files.every(stylesOnly) || server === undefined || !client.swappable(server))
      return false

    const started = performance.now()
    const outcome = await client.buildStyles()

    if (!outcome || outcome.failed || server !== servers.child)
      return false

    // A root Markdown file naming no pruned class leaves the stylesheets as they are.
    if (outcome.styles === undefined)
      return true

    const named = changedFilesNamed(root, files)
    const changed = describe(named)
    const ms = Math.round(performance.now() - started)

    tell(server, { styles: outcome.styles, built: { changed, ms, styles: true } })
    reporter.styles(named, changed, ms)

    return true
  }
  // The server never reads the generated types, only the editor and `kay check` do, so it starts before they are rewritten.
  // The client builds while the last server stops and the next one boots, which waits for it only once it asks.
  const restart = async ({ files, asked, askedFor }: RestartBatch) => {
    if (!asked && await swapStylesheets(files))
      return

    servers.began(askedFor !== undefined && files.length === 0 ? [askedFor] : changedFilesNamed(root, files), asked && files.length === 0 && askedFor === undefined)
    client.rebuild()

    // The entry is the config's, which the types read: the new process starts on the one known, and another process follows once the types tell the config now names another.
    const configEdited = files.includes(CONFIG_FILE)

    types.checkFor(files, configEdited)

    let entryWrite: Promise<void> | undefined

    if (configEdited) {
      await types.readConfig()
      entryWrite = types.writeFresh()
    }

    const previous = servers.child
    const server = servers.reloadable(files, asked) ? previous : undefined
    const sent = servers.sent()
    const answer = server === undefined ? undefined : await servers.reload(server, files, sent, client.building)

    if (answer === 'reloaded') {
      servers.reloaded(sent)
      restarted(server!, undefined, true)
    }
    // The server exited on its own while it reloaded, which the exit report says: nothing runs until the next change.
    else if (answer !== 'exited') {
      await servers.replace(previous)
    }

    if (entryWrite !== undefined) {
      void (async () => {
        await entryWrite

        if (phase !== 'stopping' && servers.child !== undefined && types.entry() !== servers.runningEntry)
          restartNow(CONFIG_FILE)
      })()
    }

    if (!configEdited && types.read(files))
      types.followEdit(files)
  }
  const queue = new ChangeQueue(root, restart)
  // What package.json says of the modules a process resolves, as of the last edit seen: an edit of its scripts or version leaves it as it is.
  let packageSeen = packageSignature(join(root, PACKAGE_FILE))
  const packageResolves = () => {
    const signature = packageSignature(join(root, PACKAGE_FILE))
    const resolves = signature !== packageSeen

    packageSeen = signature

    return resolves
  }
  // `inert` is an edit of package.json that changes nothing a process resolves, which still counts when a module imports the file for its version or scripts.
  const changedFile = (file: string, inert: boolean) => {
    const startup = !inert && STARTUP_FILE.test(file)

    servers.changed(file, startup)
    client.changed(file, startup)
    queue.changed(file)
  }
  let packageScan: Promise<void> | undefined
  let packageScanAgain = false
  const stopWatching = ports.watchProject(root, (file) => {
    if (queue.tookIn(file))
      return

    if (file !== PACKAGE_FILE || packageResolves()) {
      changedFile(file, false)

      return
    }

    // A burst of edits is answered by one scan, and one more once it ends when an edit came in meanwhile.
    if (packageScan !== undefined) {
      packageScanAgain = true

      return
    }

    packageScan = (async () => {
      do {
        packageScanAgain = false

        if (await mentionsPackage(root))
          changedFile(file, true)
      } while (packageScanAgain)
    })().finally(() => {
      packageScan = undefined
    })
  }, {
    rootNaming: true,
    onScratch: () => queue.scratch(),
  })

  // A terminal in raw mode hands over each key as it is pressed, Ctrl+C included, which no longer interrupts; an escape sequence, as Alt+key or an arrow sends, is none of them.
  const onKey = (chunk: Buffer | string) => {
    const keys = String(chunk)

    if (keys.startsWith(ESCAPE))
      return

    for (const key of keys) {
      if (key === 'o' && servers.address !== undefined) {
        const address = servers.address

        openBrowser(address, command => reporter.log(`kay dev: no browser to open ${address} with: ${command} is not installed`))
      }
      else if (key === 'r') {
        restartNow()
      }
      else if (key === 'c') {
        reporter.endRepeat()
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

  // As a change does, but for no file: open pages load the page again.
  function restartNow(file?: string) {
    servers.bump()
    queue.ask(file)
  }

  const stop = async () => {
    phase = 'stopping'

    if (options.keys !== undefined) {
      options.keys.off('data', onKey)
      options.keys.pause()
      restoreTerminal()
      process.off('exit', restoreTerminal)
    }

    queue.close()
    types.cancelFirstTree()
    stopWatching()
    removeDevAddress(root)
    await queue.idle
    types.cancelReruns()
    servers.kill()
    await types.settle()
    types.close()
    await Promise.all([types.checking, ...servers.exits(), client.stop()])
    await servers.inspector?.stop()
  }

  // A project with pages, or one an earlier run left a client build of, starts its builder beside the first types and server instead of once the server asks; a server that never asks, as one with no pages, starts none.
  if (client.building === undefined && (existsSync(join(devDir, 'manifest.json')) || existsSync(projectPaths(root).routes)))
    client.startEarly()

  // A config that loaded, with every file it read as it is now, has told the entry already: the first server need not wait for the types to read it again.
  // Should the config not load after all, as one reading an environment variable would, the first types say so and the start ends, though the server's own failure may print before the types' error.
  const recorded = options.config === undefined && options.entry === undefined ? await readConfigRecord(devDir, root) : undefined

  if (recorded !== undefined)
    types.process.configuredEntry = recorded

  // Asked to refuse a config that does not load, the first server waits for the first types: its own boot failure would print the same error again. The process it will run in loads kay meanwhile.
  // The same holds while the config is still to be read for its `entry`, which the types do.
  if (recorded === undefined && (options.refuseConfig === true || (options.config === undefined && options.entry === undefined)))
    servers.spawnWaiting()
  else
    servers.start()

  try {
    if (options.config === undefined) {
      const loadedAt = Date.now()

      await types.load()

      if (!types.refused) {
        const modules = types.process.loadedModules()

        if (types.process.configuredEntry !== undefined && modules !== undefined)
          void writeConfigRecord(devDir, root, types.process.configuredEntry, modules, loadedAt)

        // The first server started on the entry the last run's config named.
        if (servers.booted && servers.child !== undefined && types.entry() !== servers.runningEntry)
          restartNow(CONFIG_FILE)
      }

      types.armFirstTree()

      // A server started ahead of the answer may be listening already.
      if (servers.address !== undefined)
        types.writeFirstTree()
    }
    else {
      await types.write()
    }
  }
  finally {
    if (phase === 'starting')
      phase = 'running'

    client.settled(types.refused)
    verified.resolve()
  }

  if (!servers.booted && !types.refused)
    servers.start()

  if (types.refused) {
    await stop()

    throw new ConfigRefusedError()
  }

  return stop
}

// The fields of a package.json that decide what a process resolves and loads, as text; a file that is missing or does not parse is a signature of its own.
function packageSignature(path: string): string {
  let text: string

  try {
    text = readFileSync(path, 'utf8')
  }
  catch {
    return 'missing'
  }

  try {
    const fields = Object.entries(JSON.parse(text) as Record<string, unknown>).filter(([name]) => !INERT_PACKAGE_FIELDS.has(name)).toSorted(([a], [b]) => a < b ? -1 : 1)

    return JSON.stringify(fields)
  }
  catch {
    return `invalid ${Bun.hash(text)}`
  }
}

// The files a change left in place, which leaves out the directories holding them and an editor's temporary files; a deletion names what is gone.
function changedFilesNamed(root: string, files: string[]): string[] {
  if (files.length > MAX_CHANGED_FILES)
    return files

  const kept = files.filter(file => statSync(join(root, file), { throwIfNoEntry: false })?.isFile() === true)

  return kept.length > 0 ? kept : files.filter(file => !files.some(other => other.startsWith(`${file}/`)))
}

export { networkAddress } from './session/report'
export { environmentWithoutDotenv, PAGES_ENTRY, serverSources, watchProject } from './sources'
