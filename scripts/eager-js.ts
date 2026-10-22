const SCRIPT_URL = /<(?:script type="module" src|link rel="modulepreload" href)="([^"]+)"/g
const DYNAMIC_IMPORT = /import\("\.\/([\w.-]+?)-[a-z0-9]{8}\.js"\)/g
const STATIC_IMPORT = /(?:from|import)\s*"([^"]+\.js)"/g

// The script and modulepreload URLs of a page.
export function scriptUrls(html: string): string[] {
  return [...html.matchAll(SCRIPT_URL)].map(match => match[1]!)
}

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

// The chunks the code of a page can load on demand, by name without the hash: a new one is a file that may load on idle or on every page, so the list that pins them is edited on purpose.
export function lazyChunks(code: string[]): string[] {
  return [...new Set(code.flatMap(text => [...text.matchAll(DYNAMIC_IMPORT)].map(match => match[1]!)))].sort()
}
