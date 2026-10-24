import { resolve } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { fixtureCopy } from './scratch'

interface Answer { method: string, path: string, status: number, html: string }

// A process of its own, as a server on disk loads its modules through the prebuilt loader, which the test process has not registered.
async function run(script: string): Promise<{ output: string, errors: string, code: number }> {
  const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { output: output.trim(), errors, code }
}

// The fixture's layout holds an island that renders a static component through its `?island` twin, so a failure page must load that twin like any page does.
describe('the pages a production server renders for a failure, inside a layout holding an island', () => {
  for (const base of [undefined, '/repo']) {
    it(`render the island's static components and log no error, base ${base ?? 'unset'}`, async () => {
      const root = resolve(await fixtureCopy('twin-failure'))

      const options = JSON.stringify({ root, prebuilt: true, security: false, inlineStyles: false, site: 'https://site.example', ...base !== undefined && { base } })
      const built = await run(`import { buildProject } from ${JSON.stringify(resolve('src/build/pipeline'))}\nconst options = ${options}\nconst built = await buildProject(options.root, { security: false, inlineStyles: false, site: options.site, base: options.base }, { check: false })\nif (built.failed) throw built.failed.error\n`)

      expect(built.code).toBe(0)

      const requests = [['GET', '/nope'], ['HEAD', '/nope'], ['GET', '/boom'], ['HEAD', '/boom'], ['GET', '/']]
      const served = await run(`const options = ${options}\nconst { pages } = await import(${JSON.stringify(resolve('src/server'))})\nconst app = await pages(options)\nconst answers = []\nfor (const [method, path] of ${JSON.stringify(requests)}) {\n  const response = await app.handle(new Request('http://localhost' + path, { method }))\n  answers.push({ method, path, status: response.status, html: await response.text() })\n}\nconsole.log(JSON.stringify(answers))\n`)
      const answers = JSON.parse(served.output.split('\n').at(-1)!) as Answer[]

      expect(answers.map(({ method, path, status }) => [method, path, status])).toEqual([['GET', '/nope', 404], ['HEAD', '/nope', 404], ['GET', '/boom', 500], ['HEAD', '/boom', 500], ['GET', '/', 200]])

      for (const answer of answers.filter(({ method }) => method === 'GET'))
        expect(answer.html).toContain('class="glyph"')

      // The one uncaught error is the page that throws, which the server logs for a GET and for a HEAD.
      expect(served.errors).not.toContain('KayHydrated')
      expect(served.errors.match(/TypeError/g) ?? []).toEqual([])
      expect(served.code).toBe(0)
    }, 120_000)
  }
})
