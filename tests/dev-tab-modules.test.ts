import { join, relative } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { DEV_TABS } from '../src/server/dev'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

const SRC = join(import.meta.dir, '..', 'src', 'runtime')
// A constant a module declares on one line at its top level, with its value as written.
const CONSTANT = /^(?:export )?const (\w+) = (.+)$/gm

describe('the dev tool tab modules', () => {
  it('serves each as browser code with no import left', async () => {
    const dir = await scratchDir('dev-tab-modules-')

    await Bun.write(join(dir, 'routes', 'index.kay'), 'p Home\n')

    const app = await pages({ root: relative(process.cwd(), dir), routes: 'routes', dev: true })

    for (const name of Object.keys(DEV_TABS)) {
      const response = await app.handle(new Request(`http://localhost/_kay/dev/tab/${name}.js`))
      const text = await response.text()

      expect(response.status).toBe(200)
      expect(text).toContain('export default')
      expect(text).not.toMatch(/^import /m)
      expect(text).not.toMatch(/\bimport\(/)
      // A bundled re-export is an import in all but its name.
      expect(text).not.toMatch(/\bexport\s*(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s*)?from\b/)
    }
  })

  it('keeps each constant a tab module copies the same as the one it is copied from', async () => {
    const constants = async (file: string) => new Map([...(await Bun.file(join(SRC, file)).text()).matchAll(CONSTANT)].map(match => [match[1]!, match[2]!]))
    const sources = [await constants('dev-tool.ts'), await constants('server-islands.ts')]
    const compared = new Set<string>()

    for (const file of new Bun.Glob('dev-tab-*.ts').scanSync({ cwd: SRC })) {
      for (const [name, value] of await constants(file)) {
        for (const source of sources) {
          if (!source.has(name))
            continue

          compared.add(name)
          expect(`${file} ${name} = ${value}`).toBe(`${file} ${name} = ${source.get(name)}`)
        }
      }
    }

    // The copies this guards, so a renamed constant does not leave the test comparing nothing.
    expect([...compared].sort()).toEqual(expect.arrayContaining(['ACTION_PATH', 'DEV_PATH', 'HEAD_HEADER', 'HOST', 'ISLAND_PARAM']))
  })
})
