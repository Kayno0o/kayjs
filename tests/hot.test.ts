import type { TestPage } from '../src/test'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { dev } from '../src/dev'
import { browse, browserPath } from '../src/test'

// CI installs Chromium and names it in BUN_CHROME_PATH, where a missing browser fails rather than skipping.
const browserInstalled = browserPath() !== undefined
// Edits reach the page after a rebuild, which takes longer than a page's usual wait.
const SLOW = 30_000
// Inside the repository, so the project resolves `kay` to it.
const scratch = join(import.meta.dir, '../node_modules/.cache')
const todos = (label: string) => `---\nimport { signal } from 'kay'\n\nconst items = signal(['a', 'b', 'c'])\n---\nbutton.drop(onClick={() => items.set(list => list.slice(1))}) ${label}\nul.todos\n  for item of items() key={item}\n    li {item}\n`
const counter = (label: string) => `---\nimport { signal } from 'kay'\n\nconst count = signal(0)\nconst note = signal('')\n---\nbutton.count(onClick={() => count.set(n => n + 1)}) ${label} {count()}\ninput.note(bind:value={note})\n`

const field = '---\nimport { signal } from \'kay\'\n\nconst taps = signal(0)\n---\nbutton.tap(type="button" onClick={() => taps.set(n => n + 1)}) Taps {taps()}\ninput.inner(name="inner")\n'
const FORM_FIELDS = ['input.who(name="who")', 'input.old(name="old")', 'input.gone(name="gone")', 'textarea.bio(name="bio")', 'input.agree(type="checkbox" name="agree")', 'select.pick(name="pick")\n    option(value="a") A\n    option(value="b") B']
// The form page: the server renders its fields, and one more sits inside an island.
const form = (label: string, fields = FORM_FIELDS) => `--- server\nimport Field from '../components/field.kay'\nimport { formTitle } from '../form-title'\n---\nh1.title {formTitle} ${label}\nform\n${fields.map(line => `  ${line}\n`).join('')}  Field\n`

const extra = '---\nimport { signal } from \'kay\'\n\nconst on = signal(false)\n---\nbutton.extra(onClick={() => on.set(!on())}) Extra {on() ? \'on\' : \'off\'}\n'
const home = (text: string, withExtra = false) => `---\nimport '../app.css'\nimport Counter from '../components/counter.kay'\n${withExtra ? 'import Extra from \'../components/extra.kay\'\n' : ''}import Panel from '../components/panel.kay'\nimport Todos from '../components/todos.kay'\n---\nh1 Home\ndiv.solo\n  Counter\nPanel\nTodos\np.static ${text}\n${withExtra ? 'Extra\n' : ''}div(style="height: 3000px")\n`

let root: string
let stop: () => Promise<void>
let page: TestPage

// Picks the second option as a user does, firing what a pick fires.
function chooseB() {
  const select = document.querySelector<HTMLSelectElement>('select.pick')!

  select.value = 'b'
  select.dispatchEvent(new Event('input', { bubbles: true }))
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

async function until(condition: () => boolean | Promise<boolean>, timeout = 30_000) {
  for (const start = Date.now(); !await condition(); await Bun.sleep(50)) {
    if (Date.now() - start > timeout)
      throw new Error('timed out')
  }
}

// A file the dev server or the editor stub writes, once it holds something: Bun.write creates it before it writes it, so its existence alone does not mean it is complete.
async function written(path: string): Promise<string> {
  await until(async () => existsSync(path) && await Bun.file(path).text() !== '')

  return Bun.file(path).text()
}

// The dev tool's islands list, in the dev tool's shadow root, which the page's selectors do not reach.
async function islandsText(): Promise<string> {
  return page.evaluate(() => document.querySelector('kay-dev')?.shadowRoot?.querySelector('#kay-dev-islands')?.textContent ?? '')
}

async function islands(pattern: RegExp): Promise<void> {
  await page.waitUntil((source: string) => new RegExp(source).test(document.querySelector('kay-dev')?.shadowRoot?.querySelector('#kay-dev-islands')?.textContent ?? ''), {}, pattern.source)
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
      'src/components/field.kay': field,
      'src/form-title.ts': 'export const formTitle = \'Form\'\n',
      'src/routes/form.kay': form('one'),
      'src/live.ts': 'import { live } from \'kay\'\n\nexport const visitors = live(0)\n',
      'src/components/online.kay': '---\nimport { visitors } from \'../live\'\n---\np.online {visitors()} online\n',
      'src/routes/live.kay': '---\nimport Online from \'../components/online.kay\'\n---\nh1 Live\nOnline\n',
      'src/api/bump.ts': 'import { api } from \'kay/server\'\nimport { visitors } from \'../live\'\n\nexport default api().post(\'/\', () => {\n  visitors.set(n => n + 1)\n\n  return { visitors: visitors() }\n})\n',
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
    page = await browse(await origin(), { timeout: SLOW })
    await page.initScript(() => {
      (window as unknown as { builtSays: string[] }).builtSays = []
      addEventListener('kay-dev-built', (event) => {
        const build = JSON.parse((event as CustomEvent<string>).detail) as { changed: string, reloaded?: boolean, styles?: boolean, ms: number }

        const did = build.styles === true ? 'stylesheets swapped' : 'restarted'

        ;(window as unknown as { builtSays: string[] }).builtSays.push(`${build.changed}: ${build.reloaded === true ? 'reloaded' : did} in ${build.ms} ms`)
      })
    })
  }, 60_000)

  afterAll(async () => {
    delete process.env.KAY_EDITOR
    page?.close()
    await stop?.()
    await rm(root, { recursive: true, force: true })
  })

  async function origin(): Promise<string> {
    return `http://localhost:${await written(join(root, '.port'))}`
  }

  it('swaps an edited island into the open page, and the islands embedding it, their signals keeping their values', async () => {
    await page.goto(await origin())
    await page.click('.solo button.count')
    await page.click('.solo button.count')
    await page.click('.panel button.count')
    await page.click('button.open')
    await page.fill('.solo input.note', 'kept')
    await page.waitFor('.solo button.count', { text: 'Clicked 2' })
    await page.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true
    })

    await Bun.write(join(root, 'src/components/counter.kay'), counter('Pressed'))
    await page.waitFor('.solo button.count', { text: 'Pressed 2' })
    await page.waitFor('.panel button.count', { text: 'Pressed 1' })

    expect(await sameDocument()).toBe(true)
    expect(await page.value('.solo input.note')).toBe('kept')
    expect(await page.text('button.open')).toBe('Opened 1')

    await page.click('.solo button.count')
    await page.waitFor('.solo button.count', { text: 'Pressed 3' })
  }, 60_000)

  it('swaps again on the next edit, a list keeping its items rather than its rows\' order', async () => {
    await page.click('button.drop')
    await page.waitFor('ul.todos li', { text: 'a', gone: true })

    await Bun.write(join(root, 'src/components/todos.kay'), todos('Remove'))
    await page.waitFor('button.drop', { text: 'Remove' })

    expect(await sameDocument()).toBe(true)
    expect(await page.evaluate(() => [...document.querySelectorAll('ul.todos li')].map(item => item.textContent))).toEqual(['b', 'c'])
    expect(await page.text('.solo button.count')).toBe('Pressed 3')
  }, 60_000)

  it('refreshes the page through the swap for a page edit, the islands, their state and the scroll kept', async () => {
    await page.evaluate(() => window.scrollTo(0, 400))
    await Bun.write(join(root, 'src/routes/index.kay'), home('Edited'))
    await page.waitFor('p.static', { text: 'Edited' })

    expect(await sameDocument()).toBe(true)
    expect(await page.text('.solo button.count')).toBe('Pressed 3')
    expect(await page.value('.solo input.note')).toBe('kept')
    expect(await page.evaluate(() => window.scrollY)).toBe(400)
  }, 60_000)

  it('refreshes it the same for a change to a server module, the server reloaded', async () => {
    await Bun.write(join(root, 'src/greeting.ts'), 'export const greeting = \'Hello\'\n')
    await Bun.write(join(root, 'src/routes/index.kay'), `--- server\nimport { greeting } from '../greeting'\n---\n${home('{greeting}')}`)
    await page.waitFor('p.static', { text: 'Hello' })
    await Bun.write(join(root, 'src/greeting.ts'), 'export const greeting = \'Welcome\'\n')
    await page.waitFor('p.static', { text: 'Welcome' })
    // The live reload script announces what reloaded the server.
    await page.waitUntil(() => (window as unknown as { builtSays: string[] }).builtSays.some(text => (/^src\/greeting\.ts: reloaded in \d+ ms$/).test(text)))

    expect(await sameDocument()).toBe(true)
    expect(await page.text('.solo button.count')).toBe('Pressed 3')
  }, 60_000)

  it('keeps what was typed into a field the edit leaves in the page, for a template and for a server code edit, and drops it from one the edit removed or renamed', async () => {
    const typed = await browse(`${await origin()}/form`, { timeout: SLOW })

    try {
      await typed.click('button.tap')
      await typed.waitFor('button.tap', { text: 'Taps 1' })
      await typed.fill('input.who', 'Ada')
      await typed.fill('input.old', 'stale')
      await typed.fill('input.gone', 'stale')
      await typed.fill('textarea.bio', 'Hello')
      await typed.click('input.agree')
      await typed.evaluate(chooseB)
      await typed.fill('input.inner', 'in an island')
      await typed.evaluate(() => {
        (window as { kayAlive?: boolean }).kayAlive = true
      })

      const values = async () => typed.evaluate(() => ({
        alive: (window as { kayAlive?: boolean }).kayAlive === true,
        who: document.querySelector<HTMLInputElement>('input.who')?.value,
        old: document.querySelector<HTMLInputElement>('input.old')?.value,
        gone: document.querySelector<HTMLInputElement>('input.gone')?.value ?? null,
        bio: document.querySelector<HTMLTextAreaElement>('textarea.bio')?.value,
        agree: document.querySelector<HTMLInputElement>('input.agree')?.checked,
        pick: document.querySelector<HTMLSelectElement>('select.pick')?.value,
        inner: document.querySelector<HTMLInputElement>('input.inner')?.value,
      }))

      // A template edit: `gone` leaves the page and `old` is renamed in place.
      await Bun.write(join(root, 'src/routes/form.kay'), form('two', FORM_FIELDS.filter(line => !line.includes('.gone')).map(line => line.replace('name="old"', 'name="renamed"').replace('name="pick"', 'name="picked"'))))
      await typed.waitFor('h1.title', { text: 'two' })

      expect(await values()).toEqual({ alive: true, who: 'Ada', old: '', gone: null, bio: 'Hello', agree: true, pick: 'a', inner: 'in an island' })
      expect(await typed.text('button.tap')).toBe('Taps 1')

      // The select was renamed, so it shows the page's choice; typed into again, it is kept from here on.
      await typed.evaluate(chooseB)

      // A server code edit, which restarts the server.
      await Bun.write(join(root, 'src/form-title.ts'), 'export const formTitle = \'Changed\'\n')
      await typed.waitFor('h1.title', { text: 'Changed' })

      expect(await values()).toEqual({ alive: true, who: 'Ada', old: '', gone: null, bio: 'Hello', agree: true, pick: 'b', inner: 'in an island' })

      // A field whose rendered value the edit changes shows the new one, as a page loaded afresh does.
      await Bun.write(join(root, 'src/routes/form.kay'), form('three', FORM_FIELDS.filter(line => !line.includes('.gone')).map(line => line.replace('name="old"', 'name="renamed"').replace('name="pick"', 'name="picked"').replace('input.who(name="who")', 'input.who(name="who" value="Grace")'))))
      await typed.waitFor('h1.title', { text: 'three' })

      expect((await values()).who).toBe('Grace')
    }
    finally {
      typed.close()
    }
  }, 90_000)

  it('swaps an edited stylesheet into the open page, the server kept running and the page not reloaded', async () => {
    const color = async () => page.evaluate(() => getComputedStyle(document.querySelector('p.static')!).color)

    expect(await color()).toBe('rgb(255, 0, 0)')

    // Written again by a server starting.
    await rm(join(root, '.port'))
    await Bun.write(join(root, 'src/app.css'), 'p.static { color: rgb(0, 0, 255) }\n')
    await until(async () => await color() === 'rgb(0, 0, 255)')
    await page.waitUntil(() => (window as unknown as { builtSays: string[] }).builtSays.some(text => (/^src\/app\.css: stylesheets swapped in \d+ ms$/).test(text)))

    expect(await sameDocument()).toBe(true)
    expect(existsSync(join(root, '.port'))).toBe(false)
    expect(await page.text('.solo button.count')).toBe('Pressed 3')
  }, 60_000)

  it('tries again when the page cannot reach the server as an edit lands, rather than reloading', async () => {
    const color = async () => page.evaluate(() => getComputedStyle(document.querySelector('p.static')!).color)
    let refused = 0

    // The first two fetches of the page itself fail to connect, as a server announcing itself but not yet answering does.
    await page.route(url => url.pathname === '/', async (request) => {
      if (request.type === 'fetch' && refused++ < 2)
        await request.abort('connectionrefused')
    })

    try {
      await Bun.write(join(root, 'src/app.css'), 'p.static { color: rgb(0, 0, 200) }\n')
      await until(async () => await color() === 'rgb(0, 0, 200)')

      expect(refused).toBeGreaterThanOrEqual(2)
      expect(await sameDocument()).toBe(true)
    }
    finally {
      await page.unroute()
    }
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

    // A policy's refusal is logged by the browser rather than the page, which the page's errors do not hold.
    await page.cdp('Log.enable')
    page.view.addEventListener('Log.entryAdded', (event) => {
      const { text } = (event as MessageEvent<{ entry: { text: string } }>).data.entry

      if (text.includes('Content Security Policy'))
        refused.push(text)
    })

    for (let edit = 1; edit <= 8; edit++) {
      await Bun.write(join(root, 'src/greeting.ts'), `export const greeting = 'Edit ${edit}'\n`)
      await page.waitFor('p.static', { text: `Edit ${edit}` })
    }

    expect(await sameDocument()).toBe(true)
    // A reload in the running server keeps the connection the page opened, so it opens none again; at most one stays open when a server restarts.
    expect(await page.evaluate(() => (window as { kaySources?: EventSource[] }).kaySources!.filter(source => source.readyState !== EventSource.CLOSED).length)).toBeLessThanOrEqual(1)
    expect(await page.evaluate(() => [...document.scripts].filter(script => script.textContent.includes('/_kay/dev/events')).length)).toBe(1)
    expect(await page.count('meta[name=kay-boot]')).toBe(1)
    expect(refused).toEqual([])
  }, 180_000)

  it('loads the page fully when the swap cannot apply the edit, as when a new island makes a new browser build', async () => {
    await Bun.write(join(root, 'src/components/extra.kay'), extra)
    await Bun.write(join(root, 'src/routes/index.kay'), home('Grown', true))
    await page.waitFor('button.extra')

    expect(await sameDocument()).toBe(false)
    expect(await page.text('p.static')).toBe('Grown')

    await page.click('button.extra')
    await page.waitFor('button.extra', { text: 'Extra on' })
  }, 60_000)

  it('drops the stylesheets of the page left once an edited one swapped in, as the server served them', async () => {
    const color = async () => page.evaluate(() => getComputedStyle(document.querySelector('p.static')!).color)
    const go = async (href: string, heading: string) => {
      await page.evaluate((to) => {
        const link = document.createElement('a')

        link.href = to
        link.textContent = to
        document.body.prepend(link)
      }, href)
      await page.click(`a[href="${href}"]`)
      await page.waitFor('h1', { text: heading })
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
    await page.waitFor('button.extra', { text: 'Extra on' })
  }, 60_000)

  it('outlines the element under a resting pointer on Alt, over its exact box', async () => {
    await page.hover('h1')
    await page.cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, modifiers: 1 })

    try {
      const [outlined, heading] = await page.evaluate(() => {
        const outline = document.querySelector('kay-dev')!.shadowRoot!.querySelector('.outline')!

        return [outline, document.querySelector('h1')!].map(element => JSON.stringify(element.getBoundingClientRect()))
      })

      expect(outlined).toBe(heading)
    }
    finally {
      await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18 })
    }
  })

  it('opens the line an element came from on Alt+click, and lists the islands with the values of their signals', async () => {
    await page.click('h1', { modifiers: ['Alt'] })
    expect(JSON.parse(await written(join(root, '.opened')))).toEqual(['-g', `${join(root, 'src/routes/index.kay')}:8:1`])

    await page.evaluate(() => {
      const bar = [...document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll<HTMLButtonElement>('.bar > button')]

      bar.find(button => (/islands?$/).test(button.textContent))!.click()
    })
    await islands(/extra\.kay.*#1true/)
    await page.click('button.extra')
    await islands(/extra\.kay.*#1false/)
    expect(await islandsText()).toMatch(/counter\.kay.*#10number#2""string/)
    expect(await islandsText()).toMatch(/counter\.kay(?:props \d+ B)?hydrated in \d+(?:\.\d)? ms#1/)
  }, 60_000)

  it('reloads the open page into the error page when an edit does not compile, and back once it does', async () => {
    await Bun.write(join(root, 'src/routes/index.kay'), `${home('Grown', true)}else\n  p no\n`)
    await page.waitFor('h1', { text: '1 compile error' })

    expect(await page.text('pre')).toContain('src/routes/index.kay:')

    await Bun.write(join(root, 'src/routes/index.kay'), home('Grown', true))
    await page.waitFor('p.static', { text: 'Grown' })
  }, 60_000)

  it('keeps a live value, and the page following it, across an edit of its module', async () => {
    // Bumped from the test rather than the page, which reloads after the edit and would lose an evaluate in flight.
    const bump = async () => ((await (await fetch(`${await origin()}/api/bump`, { method: 'POST' })).json()) as { visitors: number }).visitors

    await page.goto(`${await origin()}/live`)
    await page.waitFor('p.online', { text: '0 online' })
    await bump()
    await page.waitFor('p.online', { text: '1 online', timeout: 10_000 })

    await Bun.write(join(root, 'src/live.ts'), 'import { live } from \'kay\'\n\nexport const visitors = live(0)\nexport const rooms = live((id: string) => id)\n')

    // The live reload script announces when the edit reached the server; the value it held is kept, so the next write counts on from it.
    await page.waitUntil(() => (window as unknown as { builtSays: string[] }).builtSays.some(text => (/^src\/live\.ts: reloaded in \d+ ms$/).test(text)))

    expect(await bump()).toBe(2)
    await page.waitFor('p.online', { text: '2 online', timeout: 10_000 })
    // The page reloaded with the server module, and follows again on its own.
    expect(await bump()).toBe(3)
    await page.waitFor('p.online', { text: '3 online', timeout: 10_000 })
  }, 90_000)
})
