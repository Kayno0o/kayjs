import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { buildClient } from '../src/build/client'
import { fixtureCopy } from './scratch'

const SERVED_FONT = /url\("?(\/_kay\/assets\/[^")]+\.woff2?)"?\)/g

describe('a font file a stylesheet names', () => {
  it('is served as a content-named asset, never inlined as a data URL', async () => {
    const dir = resolve(await fixtureCopy('cards'))

    try {
      await Bun.write(join(dir, 'src/routes/index.kay'), '---\nimport \'@fontsource/inter/400.css\'\n---\nh1 Hello\n')

      const client = await buildClient(dir)
      const sheet = [...client.styles.values()].find(url => url.includes('index'))!
      const built = await Bun.file(join(client.dir, sheet.slice('/_kay/'.length))).text()
      const urls = [...built.matchAll(SERVED_FONT)].map(match => match[1]!)

      expect(built).not.toContain('data:')
      expect(urls.length).toBeGreaterThan(0)
      expect(built.length).toBeLessThan(20_000)

      for (const url of urls)
        expect(await Bun.file(join(client.dir, url.slice('/_kay/'.length))).exists()).toBe(true)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('links under the mount point of a base', async () => {
    const dir = resolve(await fixtureCopy('cards'))

    try {
      await Bun.write(join(dir, 'src/routes/index.kay'), '---\nimport \'@fontsource/inter/400.css\'\n---\nh1 Hello\n')

      const client = await buildClient(dir, { base: '/docs' })
      const sheet = [...client.styles.values()].find(url => url.includes('index'))!
      const built = await Bun.file(join(client.dir, sheet.slice('/_kay/'.length))).text()

      expect(built).not.toContain('data:')
      expect(built).toMatch(/url\("?\/docs\/_kay\/assets\/inter-latin-400-normal-\w+\.woff2"?\)/)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('links a file named with a query or a hash, and leaves a remote one alone', async () => {
    const dir = resolve(await fixtureCopy('cards'))

    try {
      await Bun.write(join(dir, 'src/routes/index.kay'), '---\nimport \'./icons.css\'\n---\nh1 Hello\n')
      await Bun.write(join(dir, 'src/routes/icons.css'), '@font-face { font-family: A; src: url(../fonts/archivo-black-latin-400-normal.woff2?v=1) format("woff2"), url("../fonts/archivo-black-latin-400-normal.woff#iefix") format("woff"), url(https://fonts.example/remote.woff2) }\n')

      const client = await buildClient(dir)
      const sheet = [...client.styles.values()].find(url => url.includes('index'))!
      const built = await Bun.file(join(client.dir, sheet.slice('/_kay/'.length))).text()

      expect(built).not.toContain('data:')
      expect(built).toMatch(/url\("?\/_kay\/assets\/archivo-black-latin-400-normal-\w+\.woff2\?v=1"?\)/)
      expect(built).toMatch(/url\("?\/_kay\/assets\/archivo-black-latin-400-normal-\w+\.woff#iefix"?\)/)
      expect(built).toContain('https://fonts.example/remote.woff2')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
