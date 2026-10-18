import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { setDefaultTimeout } from 'bun:test'

// Bun's 5 s default likely fails hooks that drop a database or stop a server whenever the machine is busy (#1139), and `[test] timeout` in bunfig.toml does not reach hooks, where `setDefaultTimeout` does.
const DEFAULT_TIMEOUT_MS = 20_000
const TIMEOUT_FLAG = /^--timeout(?:=(\d+))?$/

// The `--timeout` the test run was given, which Bun keeps out of `process.argv`: read from the process's command line where there is one (Linux).
function flagged(): number | undefined {
  try {
    const argv = readFileSync('/proc/self/cmdline', 'utf8').split('\0')

    for (const [index, argument] of argv.entries()) {
      const match = TIMEOUT_FLAG.exec(argument)

      if (match)
        return Number(match[1] ?? argv[index + 1])
    }
  }
  catch {}

  return undefined
}

// The `[test] timeout` of the bunfig.toml in the working directory, where Bun reads it from (a global bunfig or `--config` is not consulted).
function configured(): number | undefined {
  const bunfig = join(process.cwd(), 'bunfig.toml')

  try {
    const config = existsSync(bunfig) ? Bun.TOML.parse(readFileSync(bunfig, 'utf8')) as { test?: { timeout?: unknown } } : {}

    return typeof config.test?.timeout === 'number' ? config.test.timeout : undefined
  }
  catch {
    return undefined
  }
}

// Tests and hooks take the project's timeout when it set one, so a hook follows it too, else 20 s.
const timeout = flagged() ?? configured() ?? DEFAULT_TIMEOUT_MS

if (Number.isFinite(timeout))
  setDefaultTimeout(timeout)
