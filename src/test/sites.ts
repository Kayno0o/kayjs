import { afterAll } from 'bun:test'

const sites = new Set<() => Promise<void>>()

// Every site `testSite()` made that is still open is closed once the tests ran, so a file leaves no server, socket, stream or browser behind without closing its site by hand.
// A site made in a test or a hook cannot register its own `afterAll`, as Bun runs one made there when that test ends, so the registry is closed after the whole run, or each file of an isolated or parallel one, from a preload such as kay/test/preload, else after the file that loaded kay/test first.
try {
  afterAll(closeSites)
}
catch {}

export function closeAfterTests(close: () => Promise<void>): void {
  sites.add(close)
}

async function closeSites(): Promise<void> {
  const open = [...sites]

  sites.clear()
  await Promise.all(open.map(async close => close()))
}
