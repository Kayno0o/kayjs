import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// What the environment loader and the commands that run without it share, apart from `./env` so `kay check` and the editor load no Elysia.
// On the global object, so a copy of kay the app loads beside the CLI's sees it too.
const BUILDING = Symbol.for('kay.building')

// `kay build` renders pages, and `kay check` reads content and messages, without the server's environment: from then on a variable missing or refused fails the page reading it rather than the module declaring it.
export function buildingWithoutEnv(): void {
  (globalThis as { [BUILDING]?: boolean })[BUILDING] = true
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

  // The frames above `declaredBy` are left out, so the first one left is whoever called it.
  const holder: { stack?: string } = {}

  Error.captureStackTrace(holder, declaredBy)

  const files = (holder.stack ?? '').split('\n').map(line => FRAME_FILE.exec(line.trim())?.[1])

  found.push({ schema, file: files.find(file => file !== undefined && !inLibrary(file)) })
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
