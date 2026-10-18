import type { TestPage } from '../src/test'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { chromium } from 'playwright-core'
import { BUILD_HEADER } from '../src/runtime/swap'
import { browse, browserPath } from '../src/test'
import { fixtureCopy } from './scratch'
import { ready } from './skew-page'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')
const LISTENING = /listening (\d+)/
const SERVER = 'import process from \'node:process\'\nimport { Elysia } from \'elysia\'\nimport { pages } from \'kay/server\'\n\nconst app = new Elysia().use(await pages()).listen(Number(process.env.PORT ?? 0))\n\nconsole.log(`listening ${app.server?.port}`)\n'
const path = browserPath() ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined)

interface Running {
  origin: string
  stop: () => Promise<void>
}

// A compiled executable of the app, listening on a port of its own.
async function start(executable: string, root: string): Promise<Running> {
  const child = Bun.spawn([executable], { cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'production', PORT: '0' } })
  const reader = child.stdout.getReader()
  let output = ''

  while (!LISTENING.test(output)) {
    const { value, done } = await reader.read()

    expect(done).toBe(false)
    output += new TextDecoder().decode(value)
  }

  return {
    origin: `http://localhost:${LISTENING.exec(output)![1]}`,
    stop: async () => {
      child.kill()
      await child.exited
    },
  }
}

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('a tab of a compiled executable', () => {
  let root = ''
  let before: Running
  let after: Running
  // The server in front of the executables, as a proxy of a real deploy is: it points at one and records what the tab asked.
  let front: ReturnType<typeof Bun.serve>
  let upstream: Running
  let forged: string | undefined
  let seen: string[] = []
  let tab: TestPage | undefined

  async function compile(name: string): Promise<string> {
    const executable = join(root, `bin-${name}`)

    // A deploy from a fresh checkout: a `.kay` that survived would keep the last build's chunks, which the tab then still finds.
    await rm(join(root, '.kay'), { recursive: true, force: true })

    const child = Bun.spawn([process.execPath, CLI, 'build', root, '--no-check', '--compile', executable], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'development' } })
    const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

    expect({ code, errors }).toEqual({ code: 0, errors: '' })

    return executable
  }

  beforeAll(async () => {
    root = resolve(await fixtureCopy('stale-island'))
    await Bun.write(join(root, 'src/server.ts'), SERVER)

    const first = await compile('before')

    await Bun.write(join(root, 'src/components/counter.kay'), (await Bun.file(join(root, 'src/components/counter.kay')).text()).replace('Count {', 'Total {'))

    const second = await compile('after')

    before = await start(first, root)
    after = await start(second, root)
    front = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)

        seen.push(`${request.method} ${url.pathname}${url.search}`)

        const answer = await fetch(new URL(`${url.pathname}${url.search}`, upstream.origin), { method: request.method, headers: request.headers, redirect: 'manual', body: request.body })
        const headers = new Headers(answer.headers)

        headers.delete('content-encoding')
        headers.delete('content-length')

        if (forged !== undefined)
          headers.set(BUILD_HEADER, forged)

        return new Response(request.method === 'HEAD' ? null : answer.body, { status: answer.status, headers })
      },
    })
  }, 300_000)

  afterAll(async () => {
    await front?.stop(true)
    await before?.stop()
    await after?.stop()
    await rm(root, { recursive: true, force: true })
  })

  afterEach(() => {
    tab?.close()
    tab = undefined
    forged = undefined
    seen = []
    upstream = before
  })

  // A tab is only opened before a deploy once it has what it does about one, which it has once its scripts ran.
  const open = async (): Promise<TestPage> => {
    upstream = before
    tab = await browse(front.url.origin, { path, strict: false })
    await ready(tab)

    return tab
  }

  it('asks the executable for the build with a HEAD of its entry chunk, rendering no page, and reloads when a deploy dropped a chunk', async () => {
    const page = await open()

    await page.evaluate(() => {
      (window as { kayOld?: boolean }).kayOld = true
    })
    upstream = after
    seen = []
    await page.evaluate(() => {
      scrollTo(0, document.body.scrollHeight)
    })
    await page.waitUntil(() => !(window as { kayOld?: boolean }).kayOld)
    await page.waitFor('button.counter', { text: 'Total 0' })

    expect(seen.filter(request => request.startsWith('HEAD '))).toHaveLength(1)
    expect(seen.find(request => request.startsWith('HEAD '))).toContain('/_kay/')
    // The reload is the only request for the page.
    expect(seen.filter(request => request === 'GET /')).toHaveLength(1)
  }, 60_000)

  for (const other of [true, false]) {
    it(other ? 'loads the next link in full once a server island answered by another build is confirmed' : 'keeps swapping when a server island answers with the build the executable runs', async () => {
      forged = other ? 'otherbuild' : undefined

      const page = await open()

      await page.evaluate(() => {
        (window as { kayMark?: string }).kayMark = 'kept'
      })
      // The island is swapped in once the server confirmed the build, so the tab is marked by then.
      await page.waitUntil(() => document.querySelector('slot[data-kay-server]:not([inert]) .stamp') !== null)
      expect(seen.some(request => request.startsWith('HEAD '))).toBe(other)
      await page.click('a.second')
      await page.waitFor('h1', { text: 'Second' })

      expect(await page.evaluate(() => (window as { kayMark?: string }).kayMark)).toBe(other ? undefined : 'kept')
    }, 60_000)
  }
})
