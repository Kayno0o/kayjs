import { join, relative } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { DEV_TABS } from '../src/server/dev'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

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
    }
  })
})
