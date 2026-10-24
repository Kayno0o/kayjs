import { resolve } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { outputDir } from '../src/build/assets'
import { fixtureCopy } from './scratch'

interface Answer { method: string, path: string, status: number, html: string }

// A process of its own, as a server on disk loads its modules through the prebuilt loader, which the test process has not registered.
async function run(script: string): Promise<{ output: string, errors: string, code: number }> {
  const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { output: output.trim(), errors, code }
}

const REQUESTS = [['GET', '/nope'], ['HEAD', '/nope'], ['GET', '/boom'], ['HEAD', '/boom'], ['GET', '/'], ['GET', '/dyn']]

// The server's own report of the one page that throws, which is the only line of its log the test expects.
const BOOM = /^kay: (?:GET|HEAD) \/boom\b/

// The fixture's layout holds an island that renders a static component through its `?island` twin, so every page, a failure page included, must load that twin.
describe('the pages a production server renders inside a layout holding an island', () => {
  for (const base of [undefined, '/repo']) {
    it(`render the island's static components from the build's record and log nothing else, base ${base ?? 'unset'}`, async () => {
      const root = resolve(await fixtureCopy('twin-failure'))
      const options = JSON.stringify({ root, prebuilt: true, security: false, inlineStyles: false, site: 'https://site.example', ...base !== undefined && { base } })

      const built = await run(`import { buildProject } from ${JSON.stringify(resolve('src/build/pipeline'))}\nconst options = ${options}\nconst built = await buildProject(options.root, { security: false, inlineStyles: false, site: options.site, base: options.base }, { check: false })\nif (built.failed) throw built.failed.error\n`)

      expect(built.code).toBe(0)

      const record = await Bun.file(resolve(outputDir(root), 'server-modules.json')).json() as { files: Record<string, unknown> }

      expect(Object.keys(record.files)).toContain('src/components/glyph.kay?island')

      const served = await run(`const options = ${options}\nconst { pages } = await import(${JSON.stringify(resolve('src/server'))})\nconst app = await pages(options)\nconst answers = []\nfor (const [method, path] of ${JSON.stringify(REQUESTS)}) {\n  const response = await app.handle(new Request('http://localhost' + path, { method }))\n  answers.push({ method, path, status: response.status, html: await response.text() })\n}\nconsole.log(JSON.stringify({ answers, loaded: Object.keys(require.cache).filter(key => key.includes('@babel/parser')).length }))\n`)

      expect(served.code).toBe(0)

      const { answers, loaded } = JSON.parse(served.output.split('\n').at(-1)!) as { answers: Answer[], loaded: number }

      expect(answers.map(({ method, path, status }) => [method, path, status])).toEqual([['GET', '/nope', 404], ['HEAD', '/nope', 404], ['GET', '/boom', 500], ['HEAD', '/boom', 500], ['GET', '/', 200], ['GET', '/dyn', 200]])

      for (const answer of answers.filter(({ method }) => method === 'GET'))
        expect(answer.html).toContain('class="glyph"')

      // Every line of the log is the report of the throwing route, with the stack under it.
      const lines = served.errors.split('\n').filter(line => line.startsWith('kay:'))

      expect(lines.length).toBeGreaterThan(0)
      expect(lines.filter(line => !BOOM.test(line))).toEqual([])
      expect(served.errors).not.toMatch(/TypeError|ReferenceError|SyntaxError|KayHydrated/)
      expect(loaded).toBe(0)
    }, 120_000)
  }
})

async function buildFixture(): Promise<{ root: string, options: string }> {
  const root = resolve(await fixtureCopy('twin-failure'))
  const options = JSON.stringify({ root, prebuilt: true, security: false, inlineStyles: false, site: 'https://site.example' })
  const built = await run(`import { buildProject } from ${JSON.stringify(resolve('src/build/pipeline'))}\nconst options = ${options}\nconst built = await buildProject(options.root, { security: false, inlineStyles: false, site: options.site }, { check: false })\nif (built.failed) throw built.failed.error\n`)

  expect(built.code).toBe(0)

  return { root, options }
}

async function serve(options: string, paths: string[]): Promise<{ answers: Answer[], errors: string, loaded: number }> {
  const served = await run(`const options = ${options}\nconst { pages } = await import(${JSON.stringify(resolve('src/server'))})\nconst app = await pages(options)\nconst answers = []\nfor (const path of ${JSON.stringify(paths)}) {\n  const response = await app.handle(new Request('http://localhost' + path))\n  answers.push({ method: 'GET', path, status: response.status, html: await response.text() })\n}\nconsole.log(JSON.stringify({ answers, loaded: Object.keys(require.cache).filter(key => key.includes('@babel/parser')).length }))\n`)

  expect(served.code).toBe(0)

  return { ...JSON.parse(served.output.split('\n').at(-1)!) as { answers: Answer[], loaded: number }, errors: served.errors }
}

describe('a twin on the prebuilt path', () => {
  it('is compiled again when its source changed after the build, with nothing logged', async () => {
    const { root, options } = await buildFixture()
    const glyph = resolve(root, 'src/components/glyph.kay')

    await Bun.write(glyph, (await Bun.file(glyph).text()).replace('span.glyph ', 'span.glyph.edited '))

    const { answers, errors, loaded } = await serve(options, ['/dyn'])

    expect(answers[0]!.status).toBe(200)
    expect(answers[0]!.html).toContain('class="glyph edited"')
    expect(errors).not.toMatch(/Error|kay:/)
    // The edited twin went through the compiler, so the parser probe of the tests above does see a load.
    expect(loaded).toBeGreaterThan(0)
  }, 120_000)

  it('shows the frames of a throwing render as the lines of its .kay file', async () => {
    const { options } = await buildFixture()
    const { answers, errors } = await serve(options, ['/crash'])

    expect(answers[0]!.status).toBe(500)
    expect(errors).toMatch(/twin crash/)
    // The throw is on line 5 of crash.kay, where the module the loader returns has it elsewhere.
    expect(errors).toMatch(/crash\.kay:5:/)
  }, 120_000)
})
