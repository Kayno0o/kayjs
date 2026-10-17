import type { TestPage } from '../src/test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { chromium } from 'playwright-core'
import { BUILD_HEADER, buildOf } from '../src/runtime/swap'
import { browse, browserPath, testSite } from '../src/test'
import { fixtureCopy } from './scratch'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')
const path = browserPath() ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined)
const ENTRY = /<script type="module"[^>]* src="([^"]+)"/

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('a production server naming its build', () => {
  let site: Awaited<ReturnType<typeof testSite>>

  beforeAll(async () => {
    site = await testSite({ routes: 'tests/fixtures/navigation/src/routes', browser: { path } })
  }, 60_000)

  afterAll(async () => site?.close())

  it('puts the hash of the entry its pages load on every answer, a missing chunk, a missing action and a 404 page included', async () => {
    const page = await site.fetch('/')
    const entry = ENTRY.exec(await page.text())?.[1]
    const build = buildOf(entry)

    expect(build).toBeString()
    expect(page.headers.get(BUILD_HEADER)).toBe(build!)

    const chunk = await site.fetch(entry!.replace(/entry-\w+/, 'entry-gone'))

    expect(chunk.status).toBe(404)
    expect(chunk.headers.get(BUILD_HEADER)).toBe(build!)

    const action = await site.fetch('/_kay/action/dropped/module', { method: 'POST', headers: { 'x-kay-action': '1', 'content-type': 'application/json' }, body: '{}' })

    expect(action.status).toBe(404)
    expect(action.headers.get(BUILD_HEADER)).toBe(build!)
    expect((await site.fetch('/nowhere')).headers.get(BUILD_HEADER)).toBe(build!)
  })
})

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('a page of the build the server runs', () => {
  it('keeps swapping after a form post and an island\'s call, whose answers name its own build', async () => {
    const site = await testSite({ routes: 'tests/fixtures/navigation/src/routes', browser: { path } })

    try {
      const page = await site.open('/')

      await page.evaluate(() => {
        (window as { kayMark?: string }).kayMark = 'kept'
      })
      await page.click('a.second')
      await page.waitFor('h1', { text: 'Second' })
      await page.fill('input[name="title"]', 'abcd')
      await page.click('form button')
      await page.waitFor('p.done', { text: 'Added abcd' })
      await page.back()

      expect(await page.text('h1')).toBe('Home')
      expect(await page.evaluate(() => (window as { kayMark?: string }).kayMark)).toBe('kept')
    }
    finally {
      await site.close()
    }
  }, 60_000)
})

describe('kay dev', () => {
  it('names no build, as its entry changes with every edit', async () => {
    const site = await testSite({ routes: 'tests/fixtures/navigation/src/routes', dev: true })

    try {
      expect((await site.fetch('/')).headers.has(BUILD_HEADER)).toBe(false)
    }
    finally {
      await site.close()
    }
  })
})

interface Deploy {
  dir: string
  served: string
  server: ReturnType<typeof Bun.serve>
  build: (name: string) => Promise<string>
}

// A static host whose files `build` replaces, as a deploy does.
async function staticHost(): Promise<Deploy> {
  const root = await fixtureCopy('deploy')
  const deploy: Deploy = {
    dir: root,
    served: '',
    server: Bun.serve({
      port: 0,
      async fetch(request) {
        const { pathname } = new URL(request.url)

        for (const candidate of [pathname, `${pathname}.html`, join(pathname, 'index.html')]) {
          const file = Bun.file(join(deploy.served, candidate))

          if (!candidate.endsWith('/') && await file.exists())
            return new Response(file)
        }

        return new Response('Not found', { status: 404 })
      },
    }),
    async build(name) {
      const out = join(root, `out-${name}`)
      const child = Bun.spawn([process.execPath, CLI, 'build', root, '--no-check', '--static', '--outdir', out], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'development' } })
      const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

      expect({ code, errors }).toEqual({ code: 0, errors: '' })

      return out
    },
  }

  return deploy
}

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('a tab opened before a deploy', () => {
  let host: Deploy
  let before: string
  let after: string
  let tab: TestPage | undefined

  beforeAll(async () => {
    host = await staticHost()
    before = await host.build('before')
    await Bun.write(join(host.dir, 'src/components/counter.kay'), (await Bun.file(join(host.dir, 'src/components/counter.kay')).text()).replace('Count {', 'Total {'))
    after = await host.build('after')
  }, 120_000)

  afterAll(async () => {
    await host?.server.stop(true)
  })

  beforeEach(() => {
    host.served = before
  })

  afterEach(() => {
    tab?.close()
    tab = undefined
  })

  // A tab is only opened before a deploy once it has what it does about one, which it loads when idle.
  const open = async (): Promise<TestPage> => {
    tab = await browse(host.server.url.href, { path, strict: false })
    await tab.waitUntil(() => performance.getEntriesByType('resource').some(entry => entry.name.includes('/stale-')))

    return tab
  }

  it('reloads on the next island whose chunk the deploy dropped, which then hydrates, the scroll the browser keeps', async () => {
    const page = await open()

    await page.evaluate(() => {
      (window as { kayOld?: boolean }).kayOld = true
    })
    host.served = after
    await page.evaluate(() => {
      scrollTo(0, document.body.scrollHeight)
    })
    await page.waitUntil(() => !(window as { kayOld?: boolean }).kayOld)
    await page.waitFor('button.counter', { text: 'Total 0' })
    await page.click('button.counter')
    await page.waitFor('button.counter', { text: 'Total 1' })
  }, 30_000)

  it('keeps what was typed, loading the next page in full instead of reloading under the visitor', async () => {
    const page = await open()

    await page.fill('input[name="note"]', 'half a sentence')
    await page.evaluate(() => {
      (window as { kayOld?: boolean }).kayOld = true
    })
    host.served = after
    await page.evaluate(() => {
      scrollTo(0, document.body.scrollHeight)
    })
    await Bun.sleep(1500)

    expect(await page.evaluate(() => (window as { kayOld?: boolean }).kayOld)).toBe(true)
    expect(await page.value('input[name="note"]')).toBe('half a sentence')

    await page.click('a.other')
    await page.waitFor('h1', { text: 'Other' })

    expect(await page.evaluate(() => (window as { kayOld?: boolean }).kayOld)).toBeUndefined()
  }, 30_000)

  it('swaps pages as it did while no deploy happened', async () => {
    const page = await open()

    await page.evaluate(() => {
      (window as { kayOld?: boolean }).kayOld = true
    })
    await page.click('a.other')
    await page.waitFor('h1', { text: 'Other' })

    expect(await page.evaluate(() => (window as { kayOld?: boolean }).kayOld)).toBe(true)
  }, 30_000)
})
