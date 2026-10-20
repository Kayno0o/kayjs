import type { FSWatcher } from 'node:fs'
import { readdirSync, readFileSync, statSync, watch } from 'node:fs'
import { join, relative, sep } from 'node:path'
import process from 'node:process'
import { CSS_FILE, findProjectFiles, IGNORED_DIRS } from '../build/files'
import { TRAILING_SLASH } from '../runtime/base'

// What the project's sources are and how they are watched, apart from `./index` so `kay start` and `kay render` need none of the dev loop.
// The server of a project with no entry of its own, as a static site is.
export const PAGES_ENTRY = join(import.meta.dir, 'pages.ts')
const NEWLINE = /\r?\n/
const LEADING_SLASH = /^\//
// A pattern naming anything but one plain directory at the root.
const GLOB_OR_DEEPER = /[*?[\]/]/
// The root files a server reads: what Bun reads as it starts, the lockfile, and what a module can import. A README, a licence or a justfile is none of them.
const SERVER_ROOT_FILE = /^(?:\.env.*|bun\.lockb?)$|\.(?:[cm]?[jt]sx?|json[c5]?|toml|ya?ml|kay|css|txt|html|sql|graphql|gql|wasm|node)$/
// The root files no server reads but a stylesheet's pruning does: a class named in a README is kept.
const ROOT_NAMING_FILE = /\.(?:mdx?|htm)$/
// Tests, which no server imports: a root directory such as `tests`, `e2e`, `tests-e2e` or `e2e_tests`, a `.test`, `.spec` or `.e2e` file, and a test runner's own root config.
const TEST_DIR = /^(?:__tests__|(?:.+[-_.])?(?:tests?|e2e)(?:[-_.].+)?)$/
const TEST_FILE = /(?:^|\/)__tests__\/|\.(?:test|spec|e2e)\.[cm]?[jt]sx?$/
const TEST_CONFIG = /^(?:playwright|vitest|jest|cypress)\.config\.[cm]?[jt]s$/
// The files editors write beside a source while saving it, its backup, swap or temporary copy, Vim's `4913` and Emacs' `.#` lock included.
const EDITOR_SCRATCH = /(?:~|\.sw[opx]|\.tmp|___jb_(?:tmp|old)___|\.kate-swp)$|(?:^|\/)(?:4913|\.#[^/]*|#[^/]*#)$/
const ANY_FILE = /^/

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
      return SERVER_ROOT_FILE.test(path) && !path.startsWith('.env') && !TEST_CONFIG.test(path)

    return watchedName(top) && !ignored.has(top) && !TEST_FILE.test(path)
  })
}

// A directory or file at the project root worth reacting to; dependencies, build output, tests and hidden entries, `.env` files apart, are not.
function watchedName(name: string): boolean {
  return !IGNORED_DIRS.has(name) && !TEST_DIR.test(name) && (!name.startsWith('.') || name.startsWith('.env'))
}

// A change that needs no restart, only the stylesheets built again: a stylesheet, or a root file only the pruning of a library's classes reads. Nested paths are never one of the latter, as a Markdown entry below the root is content.
export function stylesOnly(file: string): boolean {
  return CSS_FILE.test(file) || (!file.includes('/') && ROOT_NAMING_FILE.test(file) && !SERVER_ROOT_FILE.test(file))
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
// `onChange` gets the changed path relative to the root, and `onScratch` hears of the files editors write beside a source instead; the returned function stops watching. `tests` watches the tests too, as `kay check` reads them, and `rootNaming` the root files only a stylesheet's pruning reads, as `kay dev` rebuilds them.
export function watchProject(root: string, onChange: (file: string) => void, { tests = false, onScratch, rootNaming = false }: { tests?: boolean, onScratch?: () => void, rootNaming?: boolean } = {}): () => void {
  const ignored = gitIgnoredNames(root)
  const watched = (name: string) => (watchedName(name) || (tests && TEST_DIR.test(name))) && !ignored.has(name)
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

    if (directory || isDirectory(join(root, name)) || (SERVER_ROOT_FILE.test(name) && (tests || !TEST_CONFIG.test(name))) || (rootNaming && ROOT_NAMING_FILE.test(name)))
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
