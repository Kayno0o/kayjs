import type { Subprocess } from 'bun'
import type { FSWatcher } from 'node:fs'
import { readdirSync, readFileSync, statSync, watch } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { IGNORED_DIRS } from '../build/files'
import { writeShadowTypes } from '../check'

export interface DevOptions {
  // The server entry, relative to the root.
  entry?: string
  // Page, public file and API directories relative to the root, for the regenerated `.kay/types`.
  routes?: string
  publicDir?: string
  api?: string
  // The app's modules for its libraries' settings, for the settings check in `.kay/types`.
  settings?: Record<string, string>
  // Called with each server process once it is spawned.
  onRestart?: (child: Subprocess) => void
}

// Long enough to gather the few events one save makes.
const DEBOUNCE_MS = 30
const SPARE = join(import.meta.dir, 'spare.ts')
// The root files Bun reads as a process starts.
const STARTUP_FILE = /^(?:\.env.*|package\.json|bunfig\.toml|tsconfig\.json)$/
const STYLESHEET = /\.css$/
const NEWLINE = /\r?\n/
const LEADING_SLASH = /^\//
const TRAILING_SLASH = /\/$/
// A pattern naming anything but one plain directory at the root.
const GLOB_OR_DEEPER = /[*?[\]/]/
// Past this, as after a checkout, the files changed are not passed on, and open pages reload.
const MAX_CHANGED_FILES = 200

// Runs the server entry in development and restarts it on every change; a fresh process is the only way to drop modules Bun has loaded.
// Resolves once watching, with a function stopping the watchers and the server.
export async function dev(projectRoot: string, options: DevOptions = {}): Promise<() => Promise<void>> {
  const root = resolve(projectRoot)
  const entry = resolve(root, options.entry ?? 'src/server.ts')
  let child: Subprocess<'pipe'> | undefined
  let spare: Subprocess<'pipe'> | undefined
  let timer: Timer | undefined
  let changed = false
  // Bun reads these as a process starts, so changing one needs a process started after it.
  let startupChanged = false
  let restarting: Promise<void> | undefined
  // Counts every change but a stylesheet's: an open page whose server comes back with the same count only needs its stylesheets again.
  let codeVersion = 0
  // The count the last server started with, and the files changed since: a page on that count may swap in what changed.
  let startedAt = 0
  let changedFiles = new Set<string>()

  const env = await environmentWithoutDotenv()
  const spawn = () => Bun.spawn([process.execPath, '--preload', SPARE, entry], { cwd: root, env: { ...env, NODE_ENV: 'development' }, stdin: 'pipe', stdout: 'inherit', stderr: 'inherit' })
  // Each restart takes the process waiting with kay loaded, and readies the next one.
  const start = () => {
    if (startupChanged || spare === undefined || spare.exitCode !== null) {
      spare?.kill()
      spare = spawn()
      startupChanged = false
    }

    child = spare
    void child.stdin.write(`start ${codeVersion} ${startedAt} ${JSON.stringify(changedFiles.size > MAX_CHANGED_FILES ? null : [...changedFiles])}\n`)
    startedAt = codeVersion
    changedFiles = new Set()
    void child.stdin.flush()
    spare = spawn()
    options.onRestart?.(child)
  }
  // The server never reads the generated types, only the editor and `kay check` do, so it starts before they are rewritten.
  const restart = async () => {
    child?.kill()
    await child?.exited
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

    clearTimeout(timer)
    timer = setTimeout(() => {
      changed = true
      restarting ??= drain()
    }, DEBOUNCE_MS)
  })

  await regenerateTypes(root, options)
  start()

  return async () => {
    clearTimeout(timer)
    stopWatching()
    await restarting
    child?.kill()
    spare?.kill()
    await Promise.all([child?.exited, spare?.exited])
  }
}

// Keeps editors and `tsgo` in step with the `.kay` sources; type errors themselves are `kay check`'s job.
async function regenerateTypes(root: string, { routes, publicDir, api, settings }: DevOptions) {
  try {
    await writeShadowTypes(root, { routes, publicDir, api, settings })
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

// A directory or file at the project root worth reacting to; dependencies, build output and hidden entries, `.env` files apart, are not.
function watchedName(name: string): boolean {
  return !IGNORED_DIRS.has(name) && (!name.startsWith('.') || name.startsWith('.env'))
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
      const watcher = watch(join(root, name), { recursive: true }, (_event, file) => onChange(`${name}/${file ?? ''}`))

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

    watchDirectory(name)
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
