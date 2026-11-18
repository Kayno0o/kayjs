import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

// What the environment loader and the commands that run without it share, apart from `./env` so `kay check` and the editor load no Elysia.
// On the global object, so a copy of kay the app loads beside the CLI's sees it too.
const BUILDING = Symbol.for('kay.building')
const LISTED = Symbol.for('kay.envListed')

// `kay build` renders pages, and `kay check` reads content and messages, without the server's environment: from then on a variable missing or refused fails the page reading it rather than the module declaring it.
export function buildingWithoutEnv(): void {
  const holder = globalThis as { [BUILDING]?: boolean, [LISTED]?: DeclaredEnv[] }

  holder[BUILDING] = true
  // The calls of `defineEnv` from here on are kept, so a module the config imports, which `kay env` cannot import again, still lists.
  holder[LISTED] ??= []
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

// The caller's file in a stack frame such as `at /app/src/env.ts:3:20` or `at env (file:///app/src/env.ts:3:20)`.
const FRAME_FILE = /^at (?:.*? \()?(?:file:\/\/)?(\/[^():]+):(\d+:\d+)\)?$/
// A library of kay declares its variables for the app that builds it, so the app's module is the one to list them under.
const KAY_LIBRARY = /^@kayjs\/(?!kay(?:\/|$))/
const libraries = new Map<string, boolean>()

// The part of a schema the listing reads, so this module loads no Elysia.
export type EnvSchemaRecord = object & { properties: Record<string, object> }

export interface DeclaredEnv {
  schema: EnvSchemaRecord
  // The file that called `defineEnv`, a library's call counted as its caller's, when the stack tells.
  file?: string | undefined
  // The call's place, `file:line:column`: a module read again declares at the same place, and its call replaces the earlier one.
  site?: string | undefined
}

// Every call of `defineEnv` since a command began building without the environment, the config's own imports included, as `kay env` cannot import a module the config already loaded again. The listing takes the calls of its project and reads the modules calling `defineEnv` that are left.
export function listingEnv(): DeclaredEnv[] {
  const holder = globalThis as { [LISTED]?: DeclaredEnv[] }

  return holder[LISTED] ??= []
}

export function recordEnv(schema: EnvSchemaRecord, declaredBy: (...args: never[]) => unknown): void {
  const found = (globalThis as { [LISTED]?: DeclaredEnv[] })[LISTED]

  if (found === undefined)
    return

  const { file, site } = callerFrame(declaredBy)
  const earlier = site === undefined ? -1 : found.findIndex(call => call.site === site)

  if (earlier === -1)
    found.push({ schema, file, site })
  else
    found[earlier] = { schema, file, site }
}

// The file that called `declaredBy`, a library of kay's call counted as its caller's: the frames above `declaredBy` are left out, so the first one left is whoever called it.
export function callerFile(declaredBy: (...args: never[]) => unknown): string | undefined {
  return callerFrame(declaredBy).file
}

function callerFrame(declaredBy: (...args: never[]) => unknown): { file?: string, site?: string } {
  const holder: { stack?: string } = {}

  Error.captureStackTrace(holder, declaredBy)

  for (const line of (holder.stack ?? '').split('\n')) {
    const [, file, position] = FRAME_FILE.exec(line.trim()) ?? []

    if (file !== undefined && !inLibrary(file))
      return { file, site: `${file}:${position}` }
  }

  return {}
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

export const PUBLIC_FIELD = /\bs\.[Pp]ublic\s*\(/
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
export function fileFormOf(name: string, type: unknown, isPublic: unknown, declared: ReadonlySet<string>): string | undefined {
  const file = `${name}_FILE`

  return (type === 'string' || (typeof type === 'string' && type.startsWith('string ('))) && isPublic !== true && !declared.has(file) ? file : undefined
}
