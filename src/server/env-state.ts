import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

// What the environment loader and the commands that run without it share, apart from `./env` so `kay check` and the editor load no Elysia.
// On the global object, so a copy of kay the app loads beside the CLI's sees it too.
const BUILDING = Symbol.for('kay.building')

// `kay build` renders pages, and `kay check` reads content and messages, without the server's environment: from then on a variable missing or refused fails the page reading it rather than the module declaring it.
export function buildingWithoutEnv(): void {
  (globalThis as { [BUILDING]?: boolean })[BUILDING] = true
}

const LOADING = Symbol.for('kay.loading')

// An executable run as `--load` loads every module of the app without its environment, and no page is rendered: a variable missing or refused reads as a placeholder there rather than failing the module that reads it at load.
export function loadingWithoutEnv(): void {
  buildingWithoutEnv()
  ;(globalThis as { [LOADING]?: boolean })[LOADING] = true
}

export function loading(): boolean {
  return (globalThis as { [LOADING]?: boolean })[LOADING] === true
}

const LISTED = Symbol.for('kay.envListed')
// The caller's file in a stack frame such as `at /app/src/env.ts:3:20` or `at env (file:///app/src/env.ts:3:20)`.
const FRAME_FILE = /^at (?:.*? \()?(?:file:\/\/)?(\/[^():]+):\d+:\d+\)?$/
// A library of kay declares its variables for the app that builds it, so the app's module is the one to list them under.
const KAY_LIBRARY = /^@kaynooo\/kayjs-/
const libraries = new Map<string, boolean>()

// The part of a schema the listing reads, so this module loads no Elysia.
export type EnvSchemaRecord = object & { properties: Record<string, object> }

export interface DeclaredEnv {
  schema: EnvSchemaRecord
  // The file that called `defineEnv`, a library's call counted as its caller's, when the stack tells.
  file?: string | undefined
}

// `kay env` loads the modules calling `defineEnv` and takes each schema as it is declared: from then on every call is recorded.
export function listingEnv(): DeclaredEnv[] {
  const found: DeclaredEnv[] = []

  ;(globalThis as { [LISTED]?: DeclaredEnv[] })[LISTED] = found

  return found
}

export function recordEnv(schema: EnvSchemaRecord, declaredBy: (...args: never[]) => unknown): void {
  const found = (globalThis as { [LISTED]?: DeclaredEnv[] })[LISTED]

  if (found === undefined)
    return

  found.push({ schema, file: callerFile(declaredBy) })
}

// The file that called `declaredBy`, a library of kay's call counted as its caller's: the frames above `declaredBy` are left out, so the first one left is whoever called it.
export function callerFile(declaredBy: (...args: never[]) => unknown): string | undefined {
  const holder: { stack?: string } = {}

  Error.captureStackTrace(holder, declaredBy)

  const files = (holder.stack ?? '').split('\n').map(line => FRAME_FILE.exec(line.trim())?.[1])

  return files.find(file => file !== undefined && !inLibrary(file))
}

// Whether `file` belongs to a package of kay's libraries, by the name in the nearest package.json.
function inLibrary(file: string): boolean {
  let dir = dirname(file)

  for (let parent = dirname(dir); ; dir = parent, parent = dirname(dir)) {
    const known = libraries.get(dir)

    if (known !== undefined)
      return known

    const manifest = join(dir, 'package.json')

    if (existsSync(manifest)) {
      const name = (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }).name
      const result = typeof name === 'string' && KAY_LIBRARY.test(name)

      libraries.set(dir, result)

      return result
    }

    if (parent === dir)
      return false
  }
}

export function building(): boolean {
  return (globalThis as { [BUILDING]?: boolean })[BUILDING] === true
}

// The module the island entry imports the public variables from, served from the environment the server runs in, so an executable or a prerendered page reads today's values rather than those of the build.
export const PUBLIC_ENV_PATH = '/_kay/env.js'

export const PUBLIC_FIELD = /\bs\.Public\s*\(/
export const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/
// What each file read last held, by its size and time, so a command asking for the files several times reads each one once.
const scanned = new Map<string, { stamp: string, declares: boolean }>()

// What a `.kay` file declaring `s.Public` is refused with: its fence cannot give the browser a value.
export function publicInFenceMessage(file: string): string {
  return `kay: ${file} declares an s.Public field, which a .kay file cannot give the browser: declare it in a .ts module under src`
}

// The `.ts` modules among those declaring `s.Public`, the only ones that can give the browser a value.
export function publicEnvModules(root: string): string[] {
  return publicEnvFiles(root).filter(file => file.endsWith('.ts'))
}

// The files under `src` declaring a field with `s.Public`, found by reading them as text so `kay build`, `kay check` and `kay routes` know the project sends the browser an environment without loading its modules.
export function publicEnvFiles(root: string): string[] {
  return [...new Bun.Glob('src/**/*.{ts,kay}').scanSync({ cwd: root })].sort().filter((file) => {
    if (TEST_FILE.test(file))
      return false

    const path = join(root, file)
    const { size, mtimeMs } = statSync(path)
    const stamp = `${size}:${mtimeMs}`
    const known = scanned.get(path)

    if (known?.stamp === stamp)
      return known.declares

    const declares = PUBLIC_FIELD.test(readFileSync(path, 'utf8'))

    scanned.set(path, { stamp, declares })

    return declares
  })
}

// The name of the file form of a variable, `<NAME>_FILE`, when it has one: a string field that is not public (a visitor reads those) and whose file form the app does not declare itself.
// `type` is the schema's own, or the text `kay env` lists, which adds a format in brackets.
export function fileFormOf(name: string, type: unknown, isPublic: unknown, declared: ReadonlySet<string> | readonly string[]): string | undefined {
  const file = `${name}_FILE`
  const own = Array.isArray(declared) ? declared.includes(file) : (declared as ReadonlySet<string>).has(file)

  return (type === 'string' || (typeof type === 'string' && type.startsWith('string ('))) && isPublic !== true && !own ? file : undefined
}
