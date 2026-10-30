import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'
import { DOCS_BUILT, takeDocsBuilt } from './docs-build'

const CHUNK_NAME = /[\w-]+\.js/g
// A chunk reaching another, by a static import or a dynamic one.
const CHUNK_IMPORT = /["']\.\/([\w-]+\.js)["']/g
const CONVERTER_URL = '/playground/converter.js'
// A message only the converter holds.
const CONVERTER_MARK = 'the HTML does not parse'
// The page's file, and its folder's index when the build writes both.
const CONVERTER_PAGES = ['migrating/from-html.html', 'migrating/from-html/index.html']

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

// The converter of `kay fmt --from-html` is served by a route with the parser's WebAssembly build and fetched by the box on the converter page alone, so the build is read for who can reach that box: no other page loads any of it.
describe('the docs converter chunk', () => {
  beforeAll(async () => {
    const release = await takeDocsBuilt()

    try {
      await read()
    }
    finally {
      await release()
    }
  }, 300_000)

  async function read() {
    for await (const file of new Bun.Glob('*.js').scan(join(CLIENT, 'dist')))
      chunks.set(file, await Bun.file(join(CLIENT, 'dist', file)).text())

    for await (const file of new Bun.Glob('**/*.html').scan(join(CLIENT, 'pages')))
      pages.set(file, await Bun.file(join(CLIENT, 'pages', file)).text())
  }

  it('is fetched by the converter box alone, which holds its address and not the converter', () => {
    // The build also carries the chunks kept from earlier builds, which no page of this one links and no check below reads.
    const linked = reachable([...pages.values()].flatMap(chunksOf))
    const box = [...linked].filter(name => name.startsWith('html-converter-'))

    expect(box).toHaveLength(1)

    const [island] = box

    expect(pages.has(CONVERTER_PAGES[0]!)).toBe(true)
    expect(chunks.get(island!)).toContain(CONVERTER_URL)
    expect([...pages].filter(([, html]) => reachable(chunksOf(html)).has(island!)).map(([file]) => file)).toEqual(CONVERTER_PAGES.filter(page => pages.has(page)))
    expect([...chunks].filter(([name, code]) => linked.has(name) && code.includes(CONVERTER_MARK)).map(([name]) => name)).toEqual([])
  })
})
