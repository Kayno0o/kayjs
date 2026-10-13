import { join, relative } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { KayCompileError } from '../src/build/transform'
import { inlineScriptHashes, pages } from '../src/server'
import { bootFailure } from '../src/server/dev'
import { compileErrorPage, errorPage } from '../src/server/overlay'
import { scratchDir } from './scratch'

const SCRIPT_BODY = /<script[^>]*>([\s\S]*?)<\/script>/g
const code = process.env.KAY_DEV_CODE

afterEach(() => {
  if (code === undefined)
    delete process.env.KAY_DEV_CODE
  else
    process.env.KAY_DEV_CODE = code
})

// The stack of an error thrown at line 4 of `file`, called from kay and a dependency.
function stackAt(file: string): string {
  return `Error: no stock\n    at load (${file}:4:11)\n    at runLoad (${join(import.meta.dir, '../src/server/render.ts')}:264:12)\n    at handle (${join(process.cwd(), 'node_modules/elysia/dist/index.mjs')}:10:2)`
}

describe('the error page', () => {
  it('shows the project\'s frames, the lines around the first, and folds those of kay and the dependencies', async () => {
    const dir = await scratchDir('overlay-')
    const file = join(dir, 'stock.ts')
    const path = relative(process.cwd(), file)

    await Bun.write(file, 'export function load() {\n  const items = []\n\n  throw new Error(\'no stock\')\n}\n')
    delete process.env.KAY_DEV_CODE

    const html = errorPage({ status: 500, message: 'no stock', stack: stackAt(file) })

    expect(html).toContain('<h1>no stock</h1>')
    expect(html).toContain(`<h2><code>${path}:4:11</code></h2><pre class="excerpt"><span>1 | export function load() {</span><span>2 |   const items = []</span><span>3 | </span><span class="at">4 |   throw new Error(&#x27;no stock&#x27;)</span><span class="caret">  |           ^</span><span>5 | }</span>`)
    expect(html).toContain(`<h2>Stack</h2><ol class="frames"><li><code>${path}:4:11</code><span class="fn">load</span></li></ol><details><summary>2 frames in kay and dependencies</summary>`)
    expect(html).toContain('<button type="button" class="copy" data-kay-copy="kay-error-text">Copy</button>')
    expect(html).toContain(`<pre id="kay-error-text" hidden>Error: no stock\n    at load (${file}:4:11)`)
    expect(html).toContain('@media (prefers-color-scheme: dark)')
    // The page is static: what makes its buttons work comes with the dev tool, as a dev page's.
    expect([...html.matchAll(SCRIPT_BODY)]).toEqual([])

    process.env.KAY_DEV_CODE = 'test'
    expect(errorPage({ status: 500, message: 'no stock', stack: stackAt(file) })).toContain(`<li><button type="button" data-kay-open="${path}:4:11">${path}:4:11</button>`)
  })

  it('shows a stack none of whose frames is the project\'s as it is, and a compile error\'s positions as buttons under kay dev', () => {
    process.env.KAY_DEV_CODE = 'test'

    expect(errorPage({ status: 500, message: 'down', stack: 'Error: down\n    at connect (/elsewhere/db.ts:1:1)' })).toContain('<pre>Error: down\n    at connect (/elsewhere/db.ts:1:1)</pre>')

    const source = 'p ok\nelse\n  p no\n'
    const html = compileErrorPage([{ file: join(process.cwd(), 'src/routes/[id].kay'), source, start: 5, end: 9, message: '`else` must directly follow an `if`' }], undefined)

    expect(html).toContain('<h1>1 compile error</h1>')
    expect(html).toContain(' --&gt; <button type="button" data-kay-open="src/routes/[id].kay:2:1">src/routes/[id].kay:2:1</button>\n')
  })

  it('carries the dev tool on a page that failed to render and on a server that failed to boot, with scripts the policy allows', async () => {
    const dir = await scratchDir('overlay-routes-')

    await Bun.write(join(dir, 'index.kay'), '--- server\nthrow new Error(\'Kaboom\')\n---\np Never\n')

    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    let html: string

    try {
      const site = await pages({ routes: relative(process.cwd(), dir), dev: true })

      html = await (await site.handle(new Request('http://localhost/'))).text()
    }
    finally {
      logged.mockRestore()
    }

    const hashes = inlineScriptHashes({ dev: true })
    const inline = (page: string) => [...page.matchAll(SCRIPT_BODY)].map(match => match[1]!).filter(body => body !== '')

    expect(html).toContain('<h1>Kaboom</h1>')
    expect(html).toContain('<script type="module" src="/_kay/dev/tool.js"></script>')
    expect(inline(html).every(body => hashes.includes(`'sha256-${new Bun.CryptoHasher('sha256').update(body).digest('base64')}'`))).toBe(true)

    delete process.env.KAY_DEV_CODE

    const failed = bootFailure(new KayCompileError([]), process.cwd())
    const page = await (await failed.handle(new Request('http://localhost/'))).text()

    expect(page).toContain('<script type="module" src="/_kay/dev/tool.js"></script>')
    expect(page).not.toContain('/_kay/dev/inspector.js')
    expect(await (await failed.handle(new Request('http://localhost/_kay/dev/tool.js'))).text()).toContain('window.$kayDev = startDevTool()')

    process.env.KAY_DEV_CODE = 'test'

    const inspected = bootFailure(new Error('no port'), process.cwd())

    expect(await (await inspected.handle(new Request('http://localhost/'))).text()).toContain('<script type="module" src="/_kay/dev/inspector.js"></script>')
    expect((await inspected.handle(new Request('http://localhost/_kay/dev/open', { method: 'POST', body: '{}' }))).status).toBe(403)
  })
})
