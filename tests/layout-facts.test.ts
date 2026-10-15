import { join } from 'node:path'
import { describe, expect, it, spyOn } from 'bun:test'
import { actionClashes } from '../src/check/boot'
import { queryClashes } from '../src/check/queries'
import { layoutQueries } from '../src/check/shadow'
import * as script from '../src/compiler/script'
import { scanRoutes } from '../src/server/routes'
import { scratchDir } from './scratch'

const layout = 'import { s } from \'kay\'\n\nexport const page = { query: s.Object({ q: s.String() }) }\n\nexport const save = action(async () => {})\n'

describe('the layouts above a page', () => {
  it('are analysed once for shadows, action clashes and query clashes alike, and again only after a change', async () => {
    const dir = await scratchDir('layout-facts-')
    const routes = join(dir, 'src/routes')

    await Promise.all([
      Bun.write(join(routes, '_layout.kay'), `--- server\n${layout}---\nslot\n`),
      Bun.write(join(routes, 'a/_layout.kay'), `--- server\n${layout}---\nslot\n`),
      Bun.write(join(routes, 'a/one.kay'), 'p one\n'),
      Bun.write(join(routes, 'a/two.kay'), 'p two\n'),
    ])

    const analyse = spyOn(script, 'analyzeServer')

    try {
      const found = await scanRoutes(routes, [])

      for (const file of ['a/one.kay', 'a/two.kay'])
        layoutQueries(join(routes, file), 'p x\n', routes, [])

      await actionClashes(dir, [...new Set(found.flatMap(route => [...route.layouts, route.file]))])
      await queryClashes(found)

      const layouts = analyse.mock.calls.filter(([text]) => text.includes('export const page'))

      expect(layouts).toHaveLength(2)

      await Bun.write(join(routes, 'a/_layout.kay'), `--- server\n${layout}\nexport const other = 1\n---\nslot\n`)
      layoutQueries(join(routes, 'a/one.kay'), 'p x\n', routes, [])

      expect(analyse.mock.calls.filter(([text]) => text.includes('export const page'))).toHaveLength(3)
    }
    finally {
      analyse.mockRestore()
    }
  })
})
