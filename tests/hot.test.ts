import type { Browser, Page } from 'playwright-core'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { chromium } from 'playwright-core'
import { dev } from '../src/dev'

// CI installs Chromium and names it in BUN_CHROME_PATH, where a missing browser fails rather than skipping.
const executablePath = process.env.BUN_CHROME_PATH !== undefined && process.env.BUN_CHROME_PATH !== '' ? process.env.BUN_CHROME_PATH : chromium.executablePath()
const browserInstalled = existsSync(executablePath)
// Inside the repository, so the project resolves `kay` to it.
const scratch = join(import.meta.dir, '../node_modules/.cache')
const todos = (label: string) => `---\nimport { signal } from 'kay'\n\nconst items = signal(['a', 'b', 'c'])\n---\nbutton.drop(onClick={() => items.set(list => list.slice(1))}) ${label}\nul.todos\n  for item of items() key={item}\n    li {item}\n`
const counter = (label: string) => `---\nimport { signal } from 'kay'\n\nconst count = signal(0)\nconst note = signal('')\n---\nbutton.count(onClick={() => count.set(n => n + 1)}) ${label} {count()}\ninput.note(bind:value={note})\n`

const extra = '---\nimport { signal } from \'kay\'\n\nconst on = signal(false)\n---\nbutton.extra(onClick={() => on.set(!on())}) Extra {on() ? \'on\' : \'off\'}\n'
const home = (text: string, withExtra = false) => `---\nimport '../app.css'\nimport Counter from '../components/counter.kay'\n${withExtra ? 'import Extra from \'../components/extra.kay\'\n' : ''}import Panel from '../components/panel.kay'\nimport Todos from '../components/todos.kay'\n---\nh1 Home\ndiv.solo\n  Counter\nPanel\nTodos\np.static ${text}\n${withExtra ? 'Extra\n' : ''}div(style="height: 3000px")\n`

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

describe.skipIf(!browserInstalled && (process.env.CI ?? '') === '')('kay dev in Chromium', () => {
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
      'src/app.css': 'p.static { color: rgb(255, 0, 0) }\n',
      'src/routes/index.kay': home('Static'),
      'src/routes/other.kay': '---\nimport Counter from \'../components/counter.kay\'\n---\nh1 Other\np.static Other\nCounter\n',
    }

    await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))
    // A free port, handed to the servers through the environment `kay dev` passes on.
    const probe = Bun.listen({ hostname: 'localhost', port: 0, socket: { data: () => undefined } })

    process.env.KAY_HOT_PORT = String(probe.port)
    probe.stop(true)
    // An editor named as VS Code's, which takes the position as `-g file:line:column`, noting what it was asked to open in a hidden file.
    await Bun.write(join(root, 'bin/code'), `#!${process.execPath}\nawait Bun.write(${JSON.stringify(join(root, '.opened'))}, JSON.stringify(process.argv.slice(2)))\n`)
    await chmod(join(root, 'bin/code'), 0o755)
    process.env.KAY_EDITOR = join(root, 'bin/code')
    stop = await dev(root)
    browser = await chromium.launch({ headless: true, executablePath })
    page = await browser.newPage()
  }, 60_000)

  afterAll(async () => {
    delete process.env.KAY_EDITOR
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

  it('refreshes the page through the swap for a page edit, the islands, their state and the scroll kept', async () => {
    await page.evaluate(() => window.scrollTo(0, 400))
    await Bun.write(join(root, 'src/routes/index.kay'), home('Edited'))
    await page.locator('p.static', { hasText: 'Edited' }).waitFor({ timeout: 30_000 })

    expect(await sameDocument()).toBe(true)
    expect(await page.textContent('.solo button.count')).toBe('Pressed 3')
    expect(await page.inputValue('.solo input.note')).toBe('kept')
    expect(await page.evaluate(() => window.scrollY)).toBe(400)
  }, 60_000)

  it('refreshes it the same for a change to a server module, the server restarted', async () => {
    await Bun.write(join(root, 'src/greeting.ts'), 'export const greeting = \'Hello\'\n')
    await Bun.write(join(root, 'src/routes/index.kay'), `--- server\nimport { greeting } from '../greeting'\n---\n${home('{greeting}')}`)
    await page.locator('p.static', { hasText: 'Hello' }).waitFor({ timeout: 30_000 })
    await Bun.write(join(root, 'src/greeting.ts'), 'export const greeting = \'Welcome\'\n')
    await page.locator('p.static', { hasText: 'Welcome' }).waitFor({ timeout: 30_000 })
    // The dev tool's bar says what restarted the server.
    await page.locator('kay-dev .bar .built', { hasText: /^src\/greeting\.ts: restarted in \d+ ms$/ }).waitFor()

    expect(await sameDocument()).toBe(true)
    expect(await page.textContent('.solo button.count')).toBe('Pressed 3')
  }, 60_000)

  it('swaps an edited stylesheet into the open page, the server kept running and the page not reloaded', async () => {
    const color = async () => page.evaluate(() => getComputedStyle(document.querySelector('p.static')!).color)

    expect(await color()).toBe('rgb(255, 0, 0)')

    // Written again by a server starting.
    await rm(join(root, '.port'))
    await Bun.write(join(root, 'src/app.css'), 'p.static { color: rgb(0, 0, 255) }\n')
    await until(async () => await color() === 'rgb(0, 0, 255)')
    await page.locator('kay-dev .bar .built', { hasText: /^src\/app\.css: stylesheets swapped in \d+ ms$/ }).waitFor()

    expect(await sameDocument()).toBe(true)
    expect(existsSync(join(root, '.port'))).toBe(false)
    expect(await page.textContent('.solo button.count')).toBe('Pressed 3')
  }, 60_000)

  // Chromium holds six connections to a host: a live reload connecting again on every swap would leave none for the page by the seventh edit, and a copy the policy refuses logs an error each time.
  it('keeps one live reload connection open through many server restarts, each edit shown without a reload', async () => {
    // The page opens a connection again each time its server goes away, closing the one that failed.
    await page.evaluate(() => {
      const Source = window.EventSource
      const opened = window as { kaySources?: EventSource[] }

      opened.kaySources = []
      window.EventSource = class extends Source {
        constructor(...args: ConstructorParameters<typeof EventSource>) {
          super(...args)
          opened.kaySources!.push(this)
        }
      }
    })

    const refused: string[] = []

    page.on('console', (message) => {
      if (message.text().includes('Content Security Policy'))
        refused.push(message.text())
    })

    for (let edit = 1; edit <= 8; edit++) {
      await Bun.write(join(root, 'src/greeting.ts'), `export const greeting = 'Edit ${edit}'\n`)
      await page.locator('p.static', { hasText: `Edit ${edit}` }).waitFor({ timeout: 30_000 })
    }

    expect(await sameDocument()).toBe(true)
    expect(await page.evaluate(() => (window as { kaySources?: EventSource[] }).kaySources!.filter(source => source.readyState !== EventSource.CLOSED).length)).toBe(1)
    expect(await page.evaluate(() => [...document.scripts].filter(script => script.textContent.includes('/_kay/dev/events')).length)).toBe(1)
    expect(await page.locator('meta[name=kay-boot]').count()).toBe(1)
    expect(refused).toEqual([])
  }, 180_000)

  it('loads the page fully when the swap cannot apply the edit, as when a new island makes a new browser build', async () => {
    await Bun.write(join(root, 'src/components/extra.kay'), extra)
    await Bun.write(join(root, 'src/routes/index.kay'), home('Grown', true))
    await page.locator('button.extra').waitFor({ timeout: 30_000 })

    expect(await sameDocument()).toBe(false)
    expect(await page.textContent('p.static')).toBe('Grown')

    await page.click('button.extra')
    await page.locator('button.extra', { hasText: 'Extra on' }).waitFor()
  }, 60_000)

  it('drops the stylesheets of the page left once an edited one swapped in, as the server served them', async () => {
    const color = async () => page.evaluate(() => getComputedStyle(document.querySelector('p.static')!).color)
    const go = async (href: string, heading: string) => {
      await page.evaluate((to) => {
        const link = document.createElement('a')

        link.href = to
        link.textContent = to
        document.body.append(link)
      }, href)
      await page.click(`a[href="${href}"]`)
      await page.locator('h1', { hasText: heading }).waitFor()
      expect(await sameDocument()).toBe(true)
    }

    await page.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true
    })
    await rm(join(root, '.port'))
    await Bun.write(join(root, 'src/app.css'), 'p.static { color: rgb(0, 128, 0) }\n')
    await until(async () => await color() === 'rgb(0, 128, 0)')
    // The other page imports no stylesheet.
    await go('/other', 'Other')
    expect(await color()).toBe('rgb(0, 0, 0)')
    await go('/', 'Home')
    expect(await color()).toBe('rgb(0, 128, 0)')
    // Back on as the inspector's test expects it.
    await page.click('button.extra')
    await page.locator('button.extra', { hasText: 'Extra on' }).waitFor()
  }, 60_000)

  it('outlines the element under a resting pointer on Alt, over its exact box', async () => {
    await page.hover('h1')
    await page.keyboard.down('Alt')

    try {
      const [outlined, heading] = await page.evaluate(() => {
        const outline = document.querySelector('kay-dev')!.shadowRoot!.querySelector('.outline')!

        return [outline, document.querySelector('h1')!].map(element => JSON.stringify(element.getBoundingClientRect()))
      })

      expect(outlined).toBe(heading)
    }
    finally {
      await page.keyboard.up('Alt')
    }
  })

  it('opens the line an element came from on Alt+click, and lists the islands with the values of their signals', async () => {
    await page.click('h1', { modifiers: ['Alt'] })
    await until(() => existsSync(join(root, '.opened')))
    expect(JSON.parse(await Bun.file(join(root, '.opened')).text())).toEqual(['-g', `${join(root, 'src/routes/index.kay')}:8:1`])

    await page.locator('kay-dev .bar > button', { hasText: /islands?$/ }).click()
    await page.locator('#kay-dev-islands', { hasText: 'src/components/extra.kay#1 true' }).waitFor()
    await page.click('button.extra')
    await page.locator('#kay-dev-islands', { hasText: 'src/components/extra.kay#1 false' }).waitFor()
    expect(await page.textContent('#kay-dev-islands')).toContain('src/components/counter.kay#1 0#2 ""')
  }, 60_000)

  it('reloads the open page into the error page when an edit does not compile, and back once it does', async () => {
    await Bun.write(join(root, 'src/routes/index.kay'), `${home('Grown', true)}else\n  p no\n`)
    await page.locator('h1', { hasText: '1 compile error' }).waitFor({ timeout: 30_000 })

    expect(await page.textContent('pre')).toContain('src/routes/index.kay:')

    await Bun.write(join(root, 'src/routes/index.kay'), home('Grown', true))
    await page.locator('p.static', { hasText: 'Grown' }).waitFor({ timeout: 30_000 })
  }, 60_000)
})
