import type { Browser, Page } from 'playwright-core'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { chromium } from 'playwright-core'
import { dev } from '../src/dev'

const browserInstalled = existsSync(chromium.executablePath())
// Inside the repository, so the project resolves `kay` to it.
const scratch = join(import.meta.dir, '../node_modules/.cache')
const todos = (label: string) => `---\nimport { signal } from 'kay'\n\nconst items = signal(['a', 'b', 'c'])\n---\nbutton.drop(onClick={() => items.set(list => list.slice(1))}) ${label}\nul.todos\n  for item of items() key={item}\n    li {item}\n`
const counter = (label: string) => `---\nimport { signal } from 'kay'\n\nconst count = signal(0)\nconst note = signal('')\n---\nbutton.count(onClick={() => count.set(n => n + 1)}) ${label} {count()}\ninput.note(bind:value={note})\n`

const home = (text: string) => `---\nimport Counter from '../components/counter.kay'\nimport Panel from '../components/panel.kay'\nimport Todos from '../components/todos.kay'\n---\nh1 Home\ndiv.solo\n  Counter\nPanel\nTodos\np.static ${text}\n`

let root: string
let stop: () => Promise<void>
let browser: Browser
let page: Page

async function until(condition: () => boolean | Promise<boolean>, timeout = 30_000) {
  for (const start = Date.now(); !await condition(); await Bun.sleep(50)) {
    if (Date.now() - start > timeout)
      throw new Error('timed out')
  }
}

// Set on the window: still there after an edit means the page was not reloaded.
async function sameDocument(): Promise<boolean> {
  return page.evaluate(() => (window as { kayAlive?: boolean }).kayAlive === true)
}

describe.skipIf(!browserInstalled)('kay dev in Chromium', () => {
  beforeAll(async () => {
    await mkdir(scratch, { recursive: true })
    root = await mkdtemp(join(scratch, 'hot-'))

    const files = {
      'tsconfig.json': JSON.stringify({ compilerOptions: { jsx: 'preserve', jsxImportSource: 'kay', module: 'Preserve', moduleResolution: 'bundler', strict: true } }),
      // One port for every server `kay dev` restarts, which the page reconnects to; a hidden file, which the watcher ignores, says it is up.
      'src/server.ts': 'import { Elysia } from \'elysia\'\nimport { pages } from \'kay/server\'\n\nconst app = new Elysia().use(await pages()).listen(Number(process.env.KAY_HOT_PORT))\n\nawait Bun.write(\'.port\', String(app.server!.port))\n',
      'src/components/counter.kay': counter('Clicked'),
      // The panel embeds the counter, whose code Bun then moves to a chunk of its own.
      'src/components/panel.kay': '---\nimport { signal } from \'kay\'\nimport Counter from \'./counter.kay\'\n\nconst opened = signal(0)\n---\nsection.panel\n  button.open(onClick={() => opened.set(n => n + 1)}) Opened {opened()}\n  Counter\n',
      'src/components/todos.kay': todos('Drop'),
      'src/routes/index.kay': home('Static'),
    }

    await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))
    // A free port, handed to the servers through the environment `kay dev` passes on.
    const probe = Bun.listen({ hostname: 'localhost', port: 0, socket: { data: () => undefined } })

    process.env.KAY_HOT_PORT = String(probe.port)
    probe.stop(true)
    stop = await dev(root)
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage()
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    await stop?.()
    await rm(root, { recursive: true, force: true })
  })

  async function origin(): Promise<string> {
    await until(() => existsSync(join(root, '.port')))

    return `http://localhost:${await Bun.file(join(root, '.port')).text()}`
  }

  it('swaps an edited island into the open page, and the islands embedding it, their signals keeping their values', async () => {
    await page.goto(await origin())
    await page.click('.solo button.count')
    await page.click('.solo button.count')
    await page.click('.panel button.count')
    await page.click('button.open')
    await page.fill('.solo input.note', 'kept')
    await page.locator('.solo button.count', { hasText: 'Clicked 2' }).waitFor()
    await page.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true
    })

    await Bun.write(join(root, 'src/components/counter.kay'), counter('Pressed'))
    await page.locator('.solo button.count', { hasText: 'Pressed 2' }).waitFor({ timeout: 30_000 })
    await page.locator('.panel button.count', { hasText: 'Pressed 1' }).waitFor()

    expect(await sameDocument()).toBe(true)
    expect(await page.inputValue('.solo input.note')).toBe('kept')
    expect(await page.textContent('button.open')).toBe('Opened 1')

    await page.click('.solo button.count')
    await page.locator('.solo button.count', { hasText: 'Pressed 3' }).waitFor()
  }, 60_000)

  it('swaps again on the next edit, a list keeping its items rather than its rows\' order', async () => {
    await page.click('button.drop')
    await page.locator('ul.todos li', { hasText: 'a' }).waitFor({ state: 'detached' })

    await Bun.write(join(root, 'src/components/todos.kay'), todos('Remove'))
    await page.locator('button.drop', { hasText: 'Remove' }).waitFor({ timeout: 30_000 })

    expect(await sameDocument()).toBe(true)
    expect(await page.locator('ul.todos li').allTextContents()).toEqual(['b', 'c'])
    expect(await page.textContent('.solo button.count')).toBe('Pressed 3')
  }, 60_000)

  it('reloads the page for any other change', async () => {
    await Bun.write(join(root, 'src/routes/index.kay'), home('Edited'))
    await page.locator('p.static', { hasText: 'Edited' }).waitFor({ timeout: 30_000 })

    expect(await sameDocument()).toBe(false)
    expect(await page.textContent('.solo button.count')).toBe('Pressed 0')
  }, 60_000)
})
