import type { Mock } from 'bun:test'
import type { DevError } from '../src/server/dev-errors'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { clientDir, outputDir } from '../src/build/assets'
import { decodeBundleMappings, mapBundleToKay } from '../src/build/sourcemap'
import { DEV_ERRORS_FILE } from '../src/server/dev-errors'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

const saved = process.env.KAY_DEV_CODE
let root = ''
let logged: Mock<typeof console.error> | undefined

function listed(): DevError[] {
  const file = join(outputDir(root), DEV_ERRORS_FILE)

  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { errors: DevError[] }).errors : []
}

// The chunk of the island and a generated position the browser could report, one the source map ties to a `.kay` line.
async function reportable(): Promise<{ chunk: string, line: number, column: number }> {
  const dir = clientDir(root)

  for (const map of readdirSync(dir).filter(name => name.endsWith('.js.map'))) {
    // A segment the `.kay` source has no counterpart for is dropped as the map is pointed at it, so the position is read from the pointed map.
    await mapBundleToKay(join(dir, map))

    const { sources, mappings } = JSON.parse(readFileSync(join(dir, map), 'utf8')) as { sources: string[], mappings: string }

    for (const [line, segments] of decodeBundleMappings(mappings).entries()) {
      const segment = segments.find(candidate => candidate.length > 3 && sources[candidate[1]!]!.endsWith('counter.kay'))

      if (segment)
        return { chunk: map.slice(0, -'.map'.length), line: line + 1, column: segment[0]! + 1 }
    }
  }

  throw new Error('no chunk maps counter.kay')
}

async function report(app: Awaited<ReturnType<typeof pages>>, stack: string, path: string): Promise<void> {
  const body = JSON.stringify({ name: 'TypeError', message: 'count is undefined', url: `http://localhost${path}`, island: 'src/counter.kay', stack })

  expect((await app.handle(new Request('http://localhost/_kay/error', { method: 'POST', headers: { 'content-type': 'application/json', 'origin': 'http://localhost' }, body }))).status).toBe(204)
}

describe('the stack of a browser error under kay dev', () => {
  beforeAll(async () => {
    logged = spyOn(console, 'error').mockImplementation(() => undefined)
    process.env.KAY_DEV_CODE = 'test'
    root = await scratchDir('dev-browser-stack-')
    await Bun.write(join(root, 'src/counter.kay'), '---\nconst count = signal(0)\n---\nbutton(onClick={() => count.set(count() + 1)}) Count {count()}\n')
    await Bun.write(join(root, 'src/routes/index.kay'), '---\nimport Counter from \'../counter.kay\'\n---\nCounter\n')
  })

  afterAll(() => {
    logged?.mockRestore()

    if (saved === undefined)
      delete process.env.KAY_DEV_CODE
    else
      process.env.KAY_DEV_CODE = saved
  })

  it('is recorded on `.kay` lines with `at` filled, a frame no map covers staying as sent', async () => {
    const app = await pages({ root, dev: true, prebuilt: false })
    const { chunk, line, column } = await reportable()

    await report(app, `TypeError: count is undefined\n    at click (http://localhost/_kay/${chunk}:${line}:${column})\n    at other (http://localhost/_kay/unknown-aaaaaaaa.js:1:1)`, '/')

    const [error] = listed()

    expect(error!.report).toContain(join(root, 'src/counter.kay:'))
    expect(error!.report).not.toContain(chunk)
    expect(error!.report).toContain('http://localhost/_kay/unknown-aaaaaaaa.js:1:1')
    expect(error!.at).toEqual({ file: 'src/counter.kay', line: expect.any(Number), column: expect.any(Number), frame: expect.stringContaining('|') })
  })

  it('stays as sent for a chunk name that is no file of the build, whatever path it names', async () => {
    const app = await pages({ root, dev: true, prebuilt: false })
    const stack = 'Error: x\n    at x (http://localhost/_kay/..%2F..%2Fpackage.js:1:1)\n    at y (http://localhost/_kay/a/b.js:1:1)'

    await report(app, stack, '/hostile')

    expect(listed().find(error => error.request?.path === '/hostile')!.report).toContain('package.js:1:1')
  })
})

describe('the stack route of the dev tool', () => {
  it('maps a stack for the dev tool only, and refuses a request without its header or from another site', async () => {
    process.env.KAY_DEV_CODE = 'test'

    const own = await scratchDir('dev-browser-stack-route-')

    await Bun.write(join(own, 'src/routes/index.kay'), 'p ok\n')

    const app = await pages({ root: own, dev: true, prebuilt: false })
    const post = async (headers: Record<string, string>, body: string) => app.handle(new Request('http://localhost/_kay/dev/stack', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }))
    const stack = 'E\n    at f (http://localhost/_kay/none-aaaaaaaa.js:1:1)'

    expect((await post({}, JSON.stringify({ stack }))).status).toBe(403)
    expect((await post({ 'x-kay-dev': '1', 'origin': 'http://evil.example' }, JSON.stringify({ stack }))).status).toBe(403)
    expect((await post({ 'x-kay-dev': '1' }, '{"stack":1}')).status).toBe(400)
    expect((await post({ 'x-kay-dev': '1' }, 'x'.repeat(20_000))).status).toBe(400)
    expect(await (await post({ 'x-kay-dev': '1' }, JSON.stringify({ stack }))).json()).toEqual({ stack })
  })
})
