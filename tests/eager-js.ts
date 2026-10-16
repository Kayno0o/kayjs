import { expect } from 'bun:test'

const SCRIPT_URL = /<(?:script type="module" src|link rel="modulepreload" href)="([^"]+)"/g
const STATIC_IMPORT = /(?:from|import)\s*"([^"]+\.js)"/g

// Asserts that the gzipped JS a page loads up front, before anything is clicked, stays within `budget`: what the page links, and what those import statically, a dynamic `import()` waiting for a visitor to need it.
// `read` returns the code served at a URL path.
export async function expectEagerJsWithin(budget: number, html: string, read: (url: string) => Promise<string>): Promise<void> {
  const pending = [...html.matchAll(SCRIPT_URL)].map(match => match[1]!)
  const loaded = new Map<string, number>()

  for (let url = pending.pop(); url !== undefined; url = pending.pop()) {
    if (loaded.has(url))
      continue

    const code = await read(url)

    loaded.set(url, Bun.gzipSync(code).length)
    pending.push(...[...code.matchAll(STATIC_IMPORT)].map(match => new URL(match[1]!, `http://x${url}`).pathname))
  }

  const total = loaded.values().reduce((sum, size) => sum + size, 0)

  expect(total, `${total} bytes of gzipped JS load up front, over the ${budget} budget: ${[...loaded].map(([url, size]) => `${url} ${size}`).join(', ')}`).toBeLessThanOrEqual(budget)
}
