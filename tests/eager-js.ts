import { expect } from 'bun:test'

const SCRIPT_URL = /<(?:script type="module" src|link rel="modulepreload" href)="([^"]+)"/g
const STATIC_IMPORT = /(?:from|import)\s*"([^"]+\.js)"/g

// The gzipped size of each file a page loads up front, before anything is clicked: the URLs given and what those import statically, a dynamic `import()` waiting for a visitor to need it.
// `read` returns the code served at a URL path.
export async function eagerJs(urls: string[], read: (url: string) => Promise<string>): Promise<Map<string, { size: number, code: string }>> {
  const pending = [...urls]
  const loaded = new Map<string, { size: number, code: string }>()

  for (let url = pending.pop(); url !== undefined; url = pending.pop()) {
    if (loaded.has(url))
      continue

    const code = await read(url)

    loaded.set(url, { size: Bun.gzipSync(code).length, code })
    pending.push(...[...code.matchAll(STATIC_IMPORT)].map(match => new URL(match[1]!, `http://x${url}`).pathname))
  }

  return loaded
}

// Asserts that the gzipped JS a page loads up front stays within `budget`, and returns the code of each file.
export async function expectEagerJsWithin(budget: number, html: string, read: (url: string) => Promise<string>): Promise<string[]> {
  const loaded = await eagerJs([...html.matchAll(SCRIPT_URL)].map(match => match[1]!), read)
  const total = loaded.values().reduce((sum, { size }) => sum + size, 0)

  expect(total, `${total} bytes of gzipped JS load up front, over the ${budget} budget: ${[...loaded].map(([url, { size }]) => `${url} ${size}`).join(', ')}`).toBeLessThanOrEqual(budget)

  return [...loaded.values()].map(({ code }) => code)
}
