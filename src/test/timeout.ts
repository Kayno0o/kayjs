import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setDefaultTimeout } from 'bun:test'
import { testRoot } from './root'

// Bun's 5 s default fails hooks that drop a database or stop a server whenever the machine is busy, and `[test] timeout` in bunfig.toml does not reach hooks, where `setDefaultTimeout` does.
const LOADED_HOST_TIMEOUT_MS = 20_000

// A timeout the project named under `[test]` in its bunfig.toml stays as it chose.
function chosen(): boolean {
  const bunfig = join(testRoot(), 'bunfig.toml')

  try {
    const config = existsSync(bunfig) ? Bun.TOML.parse(readFileSync(bunfig, 'utf8')) as { test?: { timeout?: unknown } } : {}

    return config.test?.timeout !== undefined
  }
  catch {
    return false
  }
}

if (!chosen())
  setDefaultTimeout(LOADED_HOST_TIMEOUT_MS)
