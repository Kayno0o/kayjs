import { join, resolve } from 'node:path'
import process from 'node:process'
import { beforeAll, describe, expect, it } from 'bun:test'
import { outputDir } from '../src/build/assets'
import { takeDocsBuild } from './docs-build'

const CLI = resolve('src/cli.ts')
const CHUNK_NAME = /[\w-]+\.js/g
// A chunk reaching another, by a static import or a dynamic one.
const CHUNK_IMPORT = /["']\.\/([\w-]+\.js)["']/g
const DYNAMIC_IMPORT = /\bimport\("\.\/([\w-]+\.js)"\)/g
// The page's file, and its folder's index when the build writes both.
const CONVERTER_PAGES = ['migrating/from-html.html', 'migrating/from-html/index.html']

// A worker of `bun test --parallel` builds into `.kay/client-<id>`, which the spawned build inherits, so the folder comes from `outputDir`.
const CLIENT = outputDir(join(import.meta.dir, '../docs'))
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

// The converter of `kay fmt --from-html` is a chunk only the box on the converter page fetches, so the build is read for who can reach it.
describe('the docs converter chunk', () => {
  beforeAll(async () => {
    const release = await takeDocsBuild()

    try {
      await read()
    }
    finally {
      await release()
    }
  }, 300_000)

  async function read() {
    const child = Bun.spawn([process.execPath, CLI, 'build', 'docs', '--no-check'], { stdout: 'ignore', stderr: 'pipe' })
    const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

    if (code !== 0)
      throw new Error(errors)

    for await (const file of new Bun.Glob('*.js').scan(join(CLIENT, 'dist')))
      chunks.set(file, await Bun.file(join(CLIENT, 'dist', file)).text())

    for await (const file of new Bun.Glob('**/*.html').scan(join(CLIENT, 'pages')))
      pages.set(file, await Bun.file(join(CLIENT, 'pages', file)).text())
  }

  it('is fetched by the converter box alone and reached by no other page', () => {
    // The build also carries the chunks kept from earlier builds, which no page of this one links.
    const linked = reachable([...pages.values()].flatMap(chunksOf))
    const box = [...linked].filter(name => name.startsWith('html-converter-'))

    expect(box).toHaveLength(1)

    const [island] = box
    const converter = [...chunks.get(island!)!.matchAll(DYNAMIC_IMPORT)].map(([, name]) => name!)

    expect(converter).toHaveLength(1)
    expect(chunks.get(converter[0]!)).toContain('the HTML does not parse')
    expect(pages.has(CONVERTER_PAGES[0]!)).toBe(true)

    const reaching = [...chunks].filter(([name, code]) => linked.has(name) && name !== island && [...code.matchAll(CHUNK_IMPORT)].some(([, next]) => next === island || next === converter[0])).map(([name]) => name)

    expect(reaching).toEqual([])
    expect([...pages].filter(([, html]) => reachable(chunksOf(html)).has(converter[0]!)).map(([file]) => file)).toEqual(CONVERTER_PAGES.filter(page => pages.has(page)))
  })
})
