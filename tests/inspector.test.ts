import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { compileKay } from '../src/compiler'
import { startInspector } from '../src/runtime/dev-inspector'
import { pages } from '../src/server'

const SOURCE = `---
const count = signal(0)
---
html
  head
    title Counter
  body
    div.card
      h1 Hello
      button(onclick={() => count(count() + 1)}) {count()}
`

describe('the source positions', () => {
  it('marks each element with its file, line and column in both outputs, the head and the document left out', () => {
    for (const output of ['html', 'dom'] as const) {
      const { tsx } = compileKay(SOURCE, '/p/src/routes/index.kay', { root: '/p', output, includeServer: output === 'html', inspect: true })
      const marked = [...tsx.matchAll(/data-kay-src=\\?"([^"\\]+)\\?"/g)].map(([, at]) => at)

      expect(marked).toEqual(['src/routes/index.kay:7:3', 'src/routes/index.kay:8:5', 'src/routes/index.kay:9:7', 'src/routes/index.kay:10:7'])
      expect(tsx).toContain('<h1 data-kay-src=')
    }
  })

  it('marks nothing unless asked', () => {
    for (const output of ['html', 'dom'] as const)
      expect(compileKay(SOURCE, '/p/src/routes/index.kay', { root: '/p', output, includeServer: output === 'html' }).tsx).not.toContain('data-kay-src')
  })
})

describe('the inspector', () => {
  const opened: string[] = []
  // Whether the editor opened, or 404 for a file the server refuses.
  let answer: boolean | 404 = true
  const realFetch = globalThis.fetch

  beforeAll(() => {
    GlobalRegistrator.register()
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      opened.push((JSON.parse(init.body as string) as { source: string }).source)

      return answer === 404 ? new Response(null, { status: 404 }) : Response.json({ opened: answer })
    }) as typeof fetch
  })

  afterAll(async () => {
    await GlobalRegistrator.unregister()
    globalThis.fetch = realFetch
  })

  const host = () => document.querySelector('[data-kay-inspector]')!.shadowRoot!

  it('opens the line an element came from on Alt+click, and only then, keeping the click from the page', async () => {
    document.body.innerHTML = '<a href="/away" data-kay-src="src/routes/index.kay:4:3"><span>Away</span></a>'
    const inspector = startInspector()
    const span = document.querySelector('span')!
    let reached = 0

    span.addEventListener('click', () => reached++)

    try {
      opened.length = 0
      span.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      expect(opened).toEqual([])
      expect(reached).toBe(1)

      const alt = new MouseEvent('click', { bubbles: true, cancelable: true, altKey: true })

      span.dispatchEvent(alt)
      expect(alt.defaultPrevented).toBe(true)
      expect(reached).toBe(1)
      expect(opened).toEqual(['src/routes/index.kay:4:3'])

      answer = false
      span.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, altKey: true }))
      await Bun.sleep(0)
      expect(host().textContent).toContain('src/routes/index.kay:4:3: no editor found, set KAY_EDITOR')

      answer = 404
      span.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, altKey: true }))
      await Bun.sleep(0)
      expect(host().textContent).toContain('src/routes/index.kay:4:3: not a .kay file of this project')
    }
    finally {
      answer = true
      inspector.stop()
    }
    expect(document.querySelector('[data-kay-inspector]')).toBeNull()
  })

  it('lists the islands with the values their signals hold now, behind a button showing only when there are some', async () => {
    document.body.innerHTML = '<p>static</p>'
    const values = new Map<Element, unknown[]>()

    ;(globalThis as { $kaySignals?: (element: HTMLElement) => unknown[] | undefined }).$kaySignals = element => values.get(element)
    const inspector = startInspector()

    try {
      const toggle = host().querySelector('button')!

      expect(toggle.hidden).toBe(true)

      document.body.innerHTML = '<slot data-component="src/islands/counter.kay"><button>1</button></slot><slot data-component="src/islands/late.kay"></slot>'
      values.set(document.querySelector('slot')!, [1, { open: true }])
      await Bun.sleep(600)
      expect(toggle.hidden).toBe(false)
      expect(toggle.textContent).toBe('2 islands')

      toggle.click()
      expect(toggle.getAttribute('aria-expanded')).toBe('true')

      const panel = host().querySelector('#kay-islands')!

      expect(panel.textContent).toBe('src/islands/counter.kay#1 1#2 {"open":true}src/islands/late.kaynot hydrated')

      // Unchanged, the rows stay, and a click or a selection in them with them.
      const row = panel.firstChild

      await Bun.sleep(600)
      expect(panel.firstChild).toBe(row)

      values.set(document.querySelector('slot')!, [2, { open: false }])
      await Bun.sleep(600)
      expect(panel.textContent).toContain('#1 2#2 {"open":false}')

      opened.length = 0
      panel.querySelector('button')!.click()
      expect(opened).toEqual(['src/islands/counter.kay:1:1'])
    }
    finally {
      inspector.stop()
    }
  })
})

describe('a dev server kay dev did not start', () => {
  it('marks no element, loads no inspector and opens nothing', async () => {
    const app = new Elysia().use(await pages({ routes: 'tests/fixtures/bare/src/routes', prebuilt: true, dev: true }))
    const page = await (await app.handle(new Request('http://localhost/'))).text()

    expect(page).toContain('/_kay/dev/events')
    expect(page).not.toContain('data-kay-src')
    expect(page).not.toContain('/_kay/dev/inspector.js')
    expect((await app.handle(new Request('http://localhost/_kay/dev/inspector.js'))).status).toBe(404)
    expect((await app.handle(new Request('http://localhost/_kay/dev/open', { method: 'POST', headers: { 'content-type': 'application/json', 'x-kay-dev': '1' }, body: JSON.stringify({ source: 'tests/fixtures/bare/src/routes/index.kay:1:1' }) }))).status).toBe(404)
  })
})
