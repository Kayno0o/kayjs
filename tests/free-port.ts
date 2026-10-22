import { closeSync, mkdirSync, openSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Below Linux's ephemeral range (32768 and up), where the kernel hands out the ports of its own sockets and of a `port: 0` bind.
const FIRST = 20_000
const LAST = 32_000
const CLAIM_MS = 10 * 60_000
const claims = join(tmpdir(), 'kay-test-ports')

function bindable(port: number): boolean {
  try {
    Bun.listen({ hostname: '127.0.0.1', port, socket: { data: () => undefined } }).stop(true)

    return true
  }
  catch {
    return false
  }
}

// Writes the claim file of a port, false when another test process holds a live one.
function claimed(port: number): boolean {
  const file = join(claims, String(port))

  try {
    const held = statSync(file, { throwIfNoEntry: false })

    if (held !== undefined && Date.now() - held.mtimeMs > CLAIM_MS)
      unlinkSync(file)
  }
  catch {}

  try {
    closeSync(openSync(file, 'wx'))

    return true
  }
  catch {
    return false
  }
}

// A port that no other test process asked this helper for in the last minutes and that nothing listens on, outside the ephemeral range, so it is still free when a child binds it later.
export function freePort(): number {
  mkdirSync(claims, { recursive: true })

  for (let tries = 0; tries < 200; tries++) {
    const port = FIRST + Math.floor(Math.random() * (LAST - FIRST))

    if (claimed(port) && bindable(port))
      return port
  }

  throw new Error('no free port found')
}
