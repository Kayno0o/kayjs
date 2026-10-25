import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'
import { DOCS_BUILT, takeDocsBuilt } from './docs-build'

const CHUNK_NAME = /[\w-]+\.js/g
// A chunk reaching another, by a static import or a dynamic one.
const CHUNK_IMPORT = /["']\.\/([\w-]+\.js)["']/g
const PLAYGROUND_PAGES = ['getting-started/playground.html', 'getting-started/playground/index.html']
// A message only the compiler's type stripper holds.
const COMPILER_URL = '/playground/compiler.js'
const COMPILER_MARK = 'does not run TypeScript enums'

// The build `takeDocsBuilt` shares between the workers of a run.
const CLIENT = DOCS_BUILT
const chunks = new Map<string, string>()
const pages = new Map<string, string>()

function reachable(start: Iterable<string>): Set<string> {
  const seen = new Set<string>()
  const queue = [...start]

  for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
    if (seen.has(name) || !chunks.has(name))
      continue

    seen.add(name)

    for (const [, next] of chunks.get(name)!.matchAll(CHUNK_IMPORT))
      queue.push(next!)
  }

  return seen
}

function chunksOf(html: string): string[] {
  return (html.match(CHUNK_NAME) ?? []).filter(name => chunks.has(name))
}

// kay's compiler in the browser is served by a route and fetched by the playground page alone, so the build is read for who can reach the island that fetches it: a docs page that never opens the playground loads none of its code.
describe('the docs playground chunk', () => {
  beforeAll(async () => {
    const release = await takeDocsBuilt()

    try {
      for await (const file of new Bun.Glob('*.js').scan(join(CLIENT, 'dist')))
        chunks.set(file, await Bun.file(join(CLIENT, 'dist', file)).text())

      for await (const file of new Bun.Glob('**/*.html').scan(join(CLIENT, 'pages')))
        pages.set(file, await Bun.file(join(CLIENT, 'pages', file)).text())
    }
    finally {
      await release()
    }
  }, 300_000)

  it('is reached by the playground page alone, and holds the address of the compiler, not the compiler', () => {
    const linked = reachable([...pages.values()].flatMap(chunksOf))
    const box = [...linked].filter(name => name.startsWith('playground-'))

    expect(box).toHaveLength(1)

    const [island] = box

    expect(PLAYGROUND_PAGES.some(page => pages.has(page))).toBe(true)
    expect(chunks.get(island!)).toContain('/playground/compiler.js')
    expect([...pages].filter(([, html]) => reachable(chunksOf(html)).has(island!)).map(([file]) => file)).toEqual(PLAYGROUND_PAGES.filter(page => pages.has(page)))
    // The compiler and the frame's runtime are served by routes of their own, so no chunk of the build carries them and no page loads them up front.
    expect([...chunks].filter(([, code]) => code.includes(COMPILER_MARK)).map(([name]) => name)).toEqual([])
    expect([...pages].filter(([, html]) => html.includes(COMPILER_URL) || html.includes('/playground/frame.html')).map(([file]) => file)).toEqual(PLAYGROUND_PAGES.filter(page => pages.has(page)))
  })
})
