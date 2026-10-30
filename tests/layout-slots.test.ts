import type { Elysia } from 'elysia'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'
import { kayBuildSpawned, kayCheck } from './check-helper'
import { fixtureCopy } from './scratch'
import { pages } from './shared-pages'

const ROOT = 'tests/fixtures/layout-slots'
const SIDE = /<aside class="side">([\s\S]*?)<\/aside>/
const MAIN = /<main>([\s\S]*?)<\/main>/

const app = await pages({ root: ROOT, prebuilt: false, security: false })
const based = await pages({ root: ROOT, prebuilt: false, security: false, base: '/repo', trailingSlash: 'always' })
const development = await pages({ root: ROOT, dev: true, security: false })
const localized = await pages({ root: ROOT, prebuilt: false, security: false, i18n: { locales: ['en', 'fr'], defaultLocale: 'en', messages: resolve(`${ROOT}/src/messages`) } })

async function get(server: Elysia, path: string): Promise<{ status: number, html: string, side: string, main: string }> {
  const response = await server.handle(new Request(`http://localhost${path}`))
  const html = await response.text()

  return { status: response.status, html, side: SIDE.exec(html)?.[1] ?? '', main: MAIN.exec(html)?.[1] ?? '' }
}

describe('a page filling its layout\'s named slot', () => {
  it('renders the page\'s block in the slot, in place, ahead of the page', async () => {
    const { html, side, main, status } = await get(app, '/project?only=open')

    expect(status).toBe(200)
    expect(side).toBe('<ul class="branches"><li>main (open)</li><li>next (open)</li></ul>')
    expect(side).not.toContain('Nothing here')
    expect(main).toContain('<h1>Project</h1>')
    expect(main).not.toContain('branches')
    expect(html.indexOf('branches')).toBeLessThan(html.indexOf('<h1>Project</h1>'))
  })

  it('leaves the slot\'s fallback to a page that fills nothing', async () => {
    const { side, main } = await get(app, '/')

    expect(side).toBe('<p class="fallback">Nothing here</p>')
    expect(main).toContain('<h1>Home</h1>')
  })

  it('renders an empty block as an empty slot, without the fallback', async () => {
    const { side, main } = await get(app, '/empty')

    expect(side).toBe('')
    expect(main).toContain('<h1>Empty</h1>')
  })

  it('keeps the layout\'s own server data beside the page\'s block', async () => {
    const { main } = await get(app, '/project')

    expect(main).toContain('<p class="path">/project</p>')
  })

  it('renders the same under a base, a trailing slash and a locale prefix', async () => {
    expect((await get(based, '/project/')).side).toContain('<li>main (all)</li>')
    expect((await get(based, '/')).side).toContain('Nothing here')
    expect((await get(localized, '/fr/project')).side).toContain('<li>next (all)</li>')
    expect((await get(localized, '/fr')).side).toContain('Nothing here')
  })

  it('renders the same in development', async () => {
    expect((await get(development, '/project')).side).toContain('<li>main (all)</li>')
    expect((await get(development, '/wrap')).side).toContain('<p class="page">Page nav</p>')
    expect((await get(development, '/')).side).toContain('Nothing here')
  })

  it('passes a block through a layout that does not declare the slot', async () => {
    const { side, main } = await get(app, '/docs/page')

    expect(side).toBe('<p class="toc">Contents</p>')
    expect(main).toContain('<div class="docs"><h1>Page</h1></div>')
  })

  it('takes an inner layout\'s block as the default of its pages, a page\'s own winning', async () => {
    expect((await get(app, '/team')).side).toBe('<p class="team">Team nav</p>')
    expect((await get(app, '/team/member')).side).toBe('<p class="member">Member nav</p>')
  })

  it('gives a layout declaring the slot again the page\'s block, and the outer slot that layout\'s', async () => {
    expect((await get(app, '/wrap')).side).toBe('<nav class="wrapped"><p class="own">Wrap</p><p class="page">Page nav</p></nav>')
    expect((await get(app, '/wrap/bare')).side).toBe('<nav class="wrapped"><p class="own">Wrap</p><p class="inner-fallback">No inner</p></nav>')
  })

  it('renders the error page for a page that fails, with the layout\'s fallback', async () => {
    const failed = await get(app, '/guard?boom')

    expect(failed.status).toBe(500)
    expect(failed.side).not.toContain('Guarded')
  })
})

describe('what kay check reports of a block', () => {
  const layout = (names: string) => `.shell\n  ${names}\n  slot\n`

  it('reports a block naming a slot none of the layouts above declares', () => {
    const { diagnostics } = compileKay('@aside\n  p Hi\nh1 Page\n', 'src/routes/page.kay', { check: true, page: true, outerSlots: ['sidebar'] })

    expect(diagnostics.map(diagnostic => diagnostic.message)).toEqual(['No layout above this page has a `slot aside`'])
    expect(diagnostics[0]!.note).toContain('`sidebar`')
  })

  it('reports it on a layout as well, and accepts a declared name', () => {
    const wrong = compileKay('@aside\n  p Hi\n.x\n  slot\n', 'src/routes/_layout.kay', { check: true, outerSlots: [] })
    const right = compileKay('@sidebar\n  p Hi\n.x\n  slot\n', 'src/routes/_layout.kay', { check: true, outerSlots: ['sidebar'] })

    expect(wrong.diagnostics.map(diagnostic => diagnostic.message)).toEqual(['No layout above this layout has a `slot aside`'])
    expect(right.diagnostics).toEqual([])
  })

  it('types the slots of a layout and the block\'s own expressions', () => {
    expect(compileKay(layout('slot sidebar'), 'src/routes/_layout.kay', { check: true }).tsx).toContain('sidebar?: KayJSX.Element')
    expect(compileKay('--- server\nconst n = 1\n---\n@sidebar\n  p {n}\n', 'src/routes/page.kay', { check: true, page: true }).tsx).toContain('KayFill("sidebar", () => (<p>{__props.n}</p>))')
  })

  it('reports a block written twice, one with parameters and one outside the root', () => {
    expect(compileKay('@a\n  p x\n@a\n  p y\n', 'src/routes/page.kay', { page: true }).diagnostics.map(diagnostic => diagnostic.message)).toEqual(['`@a` is written twice in this page'])
    expect(compileKay('@a(x)\n  p y\n', 'src/routes/page.kay', { page: true }).diagnostics.map(diagnostic => diagnostic.message)).toEqual(['`@a` fills a slot, which takes no parameters'])
    expect(compileKay('.box\n  @a\n    p y\n', 'src/routes/page.kay', { page: true }).diagnostics.map(diagnostic => diagnostic.message)).toEqual(['`@a` must sit directly under a component, to pass it as that component\'s `a` prop'])
  })

  it('still refuses a block at the root of a component', () => {
    expect(compileKay('@a\n  p y\n', 'src/components/box.kay', { check: true, page: false }).diagnostics.map(diagnostic => diagnostic.message)).toEqual(['`@a` must sit directly under a component, to pass it as that component\'s `a` prop'])
  })
})

describe('kay check on a route tree with slots', () => {
  it('passes the fixture and reports a block no layout above declares, one a layout that leaves its parents out loses, and a layout slot misused', async () => {
    const root = await fixtureCopy('layout-slots')

    try {
      expect((await kayCheck([root])).output).not.toContain('slot')

      await Bun.write(join(root, 'src/routes/typo.kay'), '@sidbar\n  p Typo\nh1 Typo\n')
      await Bun.write(join(root, 'src/routes/alone/_layout.kay'), '--- server\nexport const page = { layouts: false }\n---\nslot\n')
      await Bun.write(join(root, 'src/routes/alone/page.kay'), '@sidebar\n  p Lost\nh1 Alone\n')
      const { code, output } = await kayCheck([root])

      expect(code).toBe(1)
      expect(output).toContain('No layout above this page has a `slot sidbar`')
      expect(output).toContain('typo.kay')
      expect(output).toContain('alone/page.kay')
      expect(output.match(/No layout above this page/g)).toHaveLength(2)
      expect(output).not.toContain('project.kay')
      expect(output).not.toContain('wrap/')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})

describe('a static export of pages filling a slot', () => {
  it('writes each page with its block in the layout\'s slot, and the fallback where a page fills none', async () => {
    const root = resolve(await fixtureCopy('layout-slots'))

    try {
      const { code, output } = await kayBuildSpawned([root, '--no-check', '--static', '--outdir', join(root, 'out')])

      expect({ code, output }).toEqual({ code: 0, output: '' })

      const written = async (name: string) => Bun.file(join(root, 'out', name)).text()

      expect(SIDE.exec(await written('project/index.html'))?.[1]).toContain('<li>main (all)</li>')
      expect(SIDE.exec(await written('index.html'))?.[1]).toBe('<p class="fallback">Nothing here</p>')
      expect(SIDE.exec(await written('wrap/index.html'))?.[1]).toContain('<p class="page">Page nav</p>')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)
})
