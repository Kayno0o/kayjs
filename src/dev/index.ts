import type { Subprocess } from 'bun'
import type { FSWatcher } from 'node:fs'
import type { I18nConfig, KayExtension } from '../config'
import { existsSync, readdirSync, readFileSync, statSync, watch } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { IGNORED_DIRS } from '../build/files'
import { writeShadowTypes } from '../check'

export interface DevOptions {
  // The server entry, relative to the root, `src/server.ts` by default; with no file there, a server of kay's own serves the pages.
  entry?: string | undefined
  // The `PORT` the server gets, over the shell's and the `.env`'s.
  port?: number | undefined
  // The debugger every server opens, as `BUN_INSPECT` takes it, such as `ws://localhost:6499/kay`.
  inspect?: string | undefined
  // Opens the address in the browser once the first server listens.
  open?: boolean | undefined
  // Page, public file and API directories relative to the root, for the regenerated `.kay/types`.
  routes?: string | undefined
  extensions?: KayExtension[] | undefined
  publicDir?: string | undefined
  // The locales, which prefix the routes links are checked against and type `t()`'s keys.
  i18n?: I18nConfig | undefined
  // The site's one language without `i18n`, whose catalogs type `t()`'s keys then.
  lang?: string | undefined
  api?: string | undefined
  // The app's modules for its libraries' settings, for the settings check in `.kay/types`.
  settings?: Record<string, string> | undefined
  // Called with each server process once it is spawned.
  onRestart?: ((child: Subprocess) => void) | undefined
  // Where the address, each restart and a server exiting on its own are reported, `console.log` by default.
  log?: ((line: string) => void) | undefined
}

// Long enough to gather the few events one save makes.
const DEBOUNCE_MS = 30
const SPARE = join(import.meta.dir, 'spare.ts')
const PAGES_ENTRY = join(import.meta.dir, 'pages.ts')
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
// Past this, as after a checkout, the files changed are not passed on, and open pages reload.
const MAX_CHANGED_FILES = 200
// The address of a server listening on the root path, as kay's do, reads better without its slash.
const ROOT_PATH = /(?<=\/\/[^/]+)\/$/
const STOP_SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGHUP'])
const WS_SCHEME = /^ws:\/\//

// Runs the server entry in development and restarts it on every change; a fresh process is the only way to drop modules Bun has loaded.
// Resolves once watching, with a function stopping the watchers and the server.
export async function dev(projectRoot: string, options: DevOptions = {}): Promise<() => Promise<void>> {
  const root = resolve(projectRoot)
  const entry = resolve(root, options.entry ?? 'src/server.ts')
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
  // What the last restart came from and when it began, for its report.
  let restartedFor: string[] = []
  let restartedAt = performance.now()
  let address: string | undefined
  // The port the first server asked for and the one it moved to, busy, which every next server takes first.
  let moved: string | undefined
  const log = options.log ?? console.log
  const color = options.log === undefined && process.stdout.isTTY && process.env.NO_COLOR === undefined
  const stamp = () => {
    const time = new Date().toLocaleTimeString('en-GB')

    return color ? `\x1B[2m${time}\x1B[22m` : time
  }
  // A server reports its address over IPC from the preload; only the one running counts, and only the first time it listens.
  const listened = (server: Subprocess, message: unknown) => {
    if (server !== child || typeof message !== 'object' || message === null || !('listening' in message) || typeof message.listening !== 'string')
      return

    const url = message.listening.replace(ROOT_PATH, '')
    const took = `${Math.round(performance.now() - restartedAt)} ms`
    const { asked, port } = message as Partial<Record<'asked' | 'port', number>>

    moved = asked !== undefined && port !== undefined && asked !== port ? `${asked}:${port}` : undefined

    if (address === undefined) {
      log(`kay dev: ${url} (ready in ${took}${moved === undefined ? '' : `, ${asked} was in use`})`)

      if (options.inspect !== undefined)
        log(`kay dev: debugger on ${options.inspect}, https://debug.bun.sh/#${options.inspect.replace(WS_SCHEME, '')}`)

      if (options.open === true)
        openBrowser(url, log)
    }
    else {
      log(`${stamp()} ${describe(restartedFor)}: restarted in ${took}${url === address ? '' : `, now on ${url}`}`)
    }

    address = url
  }

  // A server killed for a restart or by `kay dev` stopping exits as expected, as does one the terminal interrupted along with `kay dev`; one exiting on its own leaves nothing serving until the next change.
  const reportExit = async (server: Subprocess) => {
    const code = await server.exited

    if (server === child && !stopping && !STOP_SIGNALS.has(server.signalCode ?? ''))
      log(`${stamp()} the server exited with code ${code}, waiting for a change`)
  }

  const env = await environmentWithoutDotenv()
  // Chosen again for each process, so a `src/server.ts` written or deleted while running takes over at the next restart.
  const entryToRun = () => options.entry === undefined && !existsSync(entry) ? PAGES_ENTRY : entry
  const spawn = () => {
    spareEntry = entryToRun()

    return Bun.spawn([process.execPath, '--preload', SPARE, spareEntry], { cwd: root, env: { ...env, NODE_ENV: 'development', ...options.port === undefined ? {} : { PORT: String(options.port) }, ...options.inspect === undefined ? {} : { BUN_INSPECT: options.inspect } }, stdin: 'pipe', stdout: 'inherit', stderr: 'inherit', ipc: (message, server) => listened(server, message) })
  }
  // Each restart takes the process waiting with kay loaded, and readies the next one.
  const start = () => {
    if (startupChanged || spare === undefined || spare.exitCode !== null || spareEntry !== entryToRun()) {
      spare?.kill()
      spare = spawn()
      startupChanged = false
    }

    child = spare
    void child.stdin.write(`start ${codeVersion} ${moved ?? '-'} ${startedAt} ${JSON.stringify(changedFiles.size > MAX_CHANGED_FILES ? null : [...changedFiles])}\n`)
    startedAt = codeVersion
    changedFiles = new Set()
    void child.stdin.flush()
    // Two processes cannot hold the debugger's port, so under it each server starts once the last one exited.
    spare = options.inspect === undefined ? spawn() : undefined
    options.onRestart?.(child)
    void reportExit(child)
  }
  // The server never reads the generated types, only the editor and `kay check` do, so it starts before they are rewritten.
  const restart = async () => {
    restartedAt = performance.now()
    restartedFor = changedFilesNamed(root, [...touched])
    touched = new Set()

    const previous = child

    child = undefined
    previous?.kill()
    await previous?.exited
    start()
    await regenerateTypes(root, options)
  }
  // Changes landing during a restart trigger one more, never two restarts at once.
  const drain = async () => {
    while (changed) {
      changed = false
      await restart()
    }

    restarting = undefined
  }
  const stopWatching = watchProject(root, (file) => {
    startupChanged ||= STARTUP_FILE.test(file)

    if (!STYLESHEET.test(file)) {
      codeVersion++
      changedFiles.add(file)
    }

    touched.add(file)

    clearTimeout(timer)
    timer = setTimeout(() => {
      changed = true
      restarting ??= drain()
    }, DEBOUNCE_MS)
  })

  start()
  await regenerateTypes(root, options)

  return async () => {
    stopping = true
    clearTimeout(timer)
    stopWatching()
    await restarting
    child?.kill()
    spare?.kill()
    await Promise.all([child?.exited, spare?.exited])
  }
}

// The files a change left in place, which leaves out the directories holding them and an editor's temporary files; a deletion names what is gone.
function changedFilesNamed(root: string, files: string[]): string[] {
  if (files.length > MAX_CHANGED_FILES)
    return files

  const kept = files.filter(file => statSync(join(root, file), { throwIfNoEntry: false })?.isFile() === true)

  return kept.length > 0 ? kept : files.filter(file => !files.some(other => other.startsWith(`${file}/`)))
}

// The system's browser, or the command `BROWSER` names; a machine without one says so.
function openBrowser(url: string, log: (line: string) => void): void {
  const command = process.env.BROWSER !== undefined && process.env.BROWSER !== '' ? [process.env.BROWSER] : process.platform === 'darwin' ? ['open'] : process.platform === 'win32' ? ['cmd', '/c', 'start', '""'] : ['xdg-open']

  try {
    Bun.spawn([...command, url], { stdio: ['ignore', 'ignore', 'ignore'] }).unref()
  }
  catch {
    log(`kay dev: no browser to open ${url} with: ${command[0]} is not installed`)
  }
}

// The files a restart came from, as its report names them.
function describe(files: string[]): string {
  const [first] = files

  if (first === undefined)
    return 'a change'

  return files.length === 1 ? first : `${first} and ${files.length - 1} more`
}

// Keeps editors and `tsgo` in step with the `.kay` sources; type errors themselves are `kay check`'s job.
async function regenerateTypes(root: string, { entry, routes, extensions, publicDir, api, settings, i18n, lang }: DevOptions) {
  try {
    await writeShadowTypes(root, { entry, routes, extensions, publicDir, api, settings, i18n, lang })
  }
  catch (error) {
    console.error(error)
  }
}

// What Bun loaded from the `.env` files of the directory this process started in, as it read them then: the child loads them again, but never over a variable already set.
// A variable the shell set to the very value its `.env` holds cannot be told from one the file set, and follows the file.
async function environmentWithoutDotenv(): Promise<Record<string, string | undefined>> {
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
// `onChange` gets the changed path relative to the root; the returned function stops watching.
export function watchProject(root: string, onChange: (file: string) => void): () => void {
  const ignored = gitIgnoredNames(root)
  const watched = (name: string) => watchedName(name) && !ignored.has(name)
  const directories = new Map<string, FSWatcher>()
  const watchDirectory = (name: string) => {
    directories.get(name)?.close()
    directories.delete(name)

    if (!isDirectory(join(root, name)))
      return

    // The directory may go between the check and the watch, or the system run out of watchers: `kay dev` keeps going without it.
    try {
      const watcher = watch(join(root, name), { recursive: true }, (_event, file) => {
        if (file === null || !TEST_FILE.test(file))
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
