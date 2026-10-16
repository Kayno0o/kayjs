// What the environment loader and the commands that run without it share, apart from `./env` so `kay check` and the editor load no Elysia.
// On the global object, so a copy of kay the app loads beside the CLI's sees it too.
const BUILDING = Symbol.for('kay.building')

// `kay build` renders pages, and `kay check` reads content and messages, without the server's environment: from then on a variable missing or refused fails the page reading it rather than the module declaring it.
export function buildingWithoutEnv(): void {
  (globalThis as { [BUILDING]?: boolean })[BUILDING] = true
}

const LISTED = Symbol.for('kay.envListed')
// The caller's file in a stack frame such as `at /app/src/env.ts:3:20` or `at env (file:///app/src/env.ts:3:20)`.
const FRAME_FILE = /(?:file:\/\/)?(\/[^():]+):\d+:\d+\)?$/

// The part of a schema the listing reads, so this module loads no Elysia.
export type EnvSchemaRecord = object & { properties: Record<string, object> }

export interface DeclaredEnv {
  schema: EnvSchemaRecord
  // The file that called `defineEnv`, when the stack tells.
  file?: string | undefined
}

// `kay env` loads the modules calling `defineEnv` and takes each schema as it is declared: from then on every call is recorded.
export function listingEnv(): DeclaredEnv[] {
  const found: DeclaredEnv[] = []

  ;(globalThis as { [LISTED]?: DeclaredEnv[] })[LISTED] = found

  return found
}

export function recordEnv(schema: EnvSchemaRecord): void {
  const found = (globalThis as { [LISTED]?: DeclaredEnv[] })[LISTED]

  if (found === undefined)
    return

  const lines = (new Error('called from').stack ?? '').split('\n')
  const caller = lines[lines.findIndex(line => line.includes('defineEnv')) + 1]

  found.push({ schema, file: caller === undefined ? undefined : FRAME_FILE.exec(caller.trim())?.[1] })
}

export function building(): boolean {
  return (globalThis as { [BUILDING]?: boolean })[BUILDING] === true
}

// The module the island entry imports the public variables from, served from the environment the server runs in, so an executable or a prerendered page reads today's values rather than those of the build.
export const PUBLIC_ENV_PATH = '/_kay/env.js'
