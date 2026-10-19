import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { nativePlatformDir } from './native-typescript'

const DECLARED_GLOBAL = /^declare (?:var|function) ([\w$]+)/gm
const NOT_DEFINED = /^(\S+) is not defined$/

const LIST_GLOBALS = [process.execPath, '-e', 'console.log(JSON.stringify(Object.getOwnPropertyNames(globalThis)))']
const LIST_TIMEOUT_MS = 5000

let globals: Set<string> | undefined

// Bun's globals, read from a process of its own that is killed after the timeout, so one that spins never outlives the wait for it.
export function bunGlobalNames(command: string[] = LIST_GLOBALS, timeout = LIST_TIMEOUT_MS): Set<string> {
  const own = Bun.spawnSync(command, { cwd: tmpdir(), timeout, killSignal: 'SIGKILL' })

  return new Set(JSON.parse(own.stdout.toString()) as string[])
}

// What lib.dom declares as globals and Bun's own globalThis lacks: reading one on the server throws.
// Bun's globals come from a process of its own, as a test registering a DOM, or a preload, would add some to this one.
export function browserGlobals(): ReadonlySet<string> {
  if (globals)
    return globals

  globals = new Set()

  try {
    const lib = readFileSync(join(nativePlatformDir(), 'lib', 'lib.dom.d.ts'), 'utf8')
    const bun = bunGlobalNames()

    for (const match of lib.matchAll(DECLARED_GLOBAL)) {
      if (!bun.has(match[1]!))
        globals.add(match[1]!)
    }
  }
  catch {}

  return globals
}

// The browser-only global an error says is not defined, as Bun words a read of it on the server.
export function browserGlobalMissing(error: unknown): string | undefined {
  const { name, message } = (error ?? {}) as { name?: unknown, message?: unknown }
  const missing = name === 'ReferenceError' && typeof message === 'string' ? NOT_DEFINED.exec(message)?.[1] : undefined

  return missing !== undefined && browserGlobals().has(missing) ? missing : undefined
}
