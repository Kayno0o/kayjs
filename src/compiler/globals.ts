import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'

const DECLARED_GLOBAL = /^declare (?:var|function) ([\w$]+)/gm
const NOT_DEFINED = /^(\S+) is not defined$/

let globals: Set<string> | undefined

// What lib.dom declares as globals and Bun's own globalThis lacks: reading one on the server throws.
// Bun's globals come from a process of its own, as a test registering a DOM, or a preload, would add some to this one.
export function browserGlobals(): ReadonlySet<string> {
  if (globals)
    return globals

  globals = new Set()

  try {
    const preview = dirname(Bun.resolveSync('@typescript/native-preview/package.json', import.meta.dir))
    const platform = dirname(Bun.resolveSync(`@typescript/native-preview-${process.platform}-${process.arch}/package.json`, preview))
    const lib = readFileSync(join(platform, 'lib', 'lib.dom.d.ts'), 'utf8')
    const own = Bun.spawnSync([process.execPath, '-e', 'console.log(JSON.stringify(Object.getOwnPropertyNames(globalThis)))'], { cwd: tmpdir() })
    const bun = new Set(JSON.parse(own.stdout.toString()) as string[])

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
