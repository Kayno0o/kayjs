import type { DevTool } from '../src/runtime/dev-tool'
import type { DevHead, DevResponse } from '../src/server/dev'
import { join, relative } from 'node:path'
import process from 'node:process'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { t } from 'elysia'
import { startDevTool } from '../src/runtime/dev-tool'
import { PUBLIC_ENV } from '../src/runtime/env'
import { reportError } from '../src/runtime/reactive'
import { pages } from '../src/server'
import { DEV_BOOT, problemsBlock } from '../src/server/dev'
import { scratchDir } from './scratch'

// The fields of a request block the Request tab reads.
const PAGE = { page: 'src/routes/index.kay', layouts: [], params: {}, id: 'abc', guards: [], status: 200, loads: [] }

const BOOT = (/<script>([\s\S]*)<\/script>/).exec(DEV_BOOT)![1]!

const { error, warn } = console

// A PerformanceObserver the test reports entries to by type, installed on the window until the test removes it.
function fakeObserver() {
  const observers: { type: string, callback: (list: { getEntries: () => unknown[] }) => void }[] = []

  ;(window as unknown as { PerformanceObserver: unknown }).PerformanceObserver = class {
    constructor(private callback: (list: { getEntries: () => unknown[] }) => void) {}

    observe({ type }: { type: string }): void {
      observers.push({ type, callback: this.callback })
    }

    disconnect(): void {
      return undefined
    }
  }

  return {
    report: (type: string, entries: unknown[]) => {
      for (const observer of observers.filter(observer => observer.type === type))
        observer.callback({ getEntries: () => entries })
    },
  }
}

// As a page runs it once, the console quiet but for what the tests read.
beforeAll(() => {
  GlobalRegistrator.register()
  console.error = () => undefined
  console.warn = () => undefined
  // eslint-disable-next-line no-new-func -- runs the inline script a dev page carries
  ;(new Function(BOOT) as () => void)()
})
afterAll(async () => {
  Object.assign(console, { error, warn })
  await GlobalRegistrator.unregister()
})

describe('the dev tool', () => {
  let tool: DevTool | undefined

  const shadow = () => document.querySelector('kay-dev')!.shadowRoot!
  const problems = () => [...shadow().querySelectorAll('.problem')].map(problem => [problem.classList.contains('error') ? 'error' : 'warn', problem.querySelector('pre')!.textContent])
  const groups = () => [...shadow().querySelectorAll<HTMLElement>('#kay-dev-problems .group')].filter(group => group.hidden === false).map(group => `${group.querySelector('h3')!.firstChild!.textContent} (${group.querySelector('h3 .pill')!.textContent})`)
  const dismissAll = () => [...shadow().querySelectorAll<HTMLButtonElement>('.actions button')].find(button => button.textContent === 'Dismiss all')!
  const bar = () => [...shadow().querySelectorAll('.bar > button')].filter(button => (button as HTMLElement).hidden === false).map(button => button.textContent)
  const drawer = () => shadow().querySelector<HTMLElement>('[role=dialog]')!
  const key = (init: KeyboardEventInit, target: EventTarget = document.body) => target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, composed: true, ...init }))

  afterEach(() => {
    tool?.stop()
    tool = undefined
    ;(window as { $kayProblems?: unknown }).$kayProblems = []
    sessionStorage.clear()
    localStorage.clear()
    document.head.innerHTML = ''
    document.documentElement.removeAttribute('aria-busy')
  })

  it('lists what kay check found and what kay logged before and after it loaded, each once, errors told from warnings', async () => {
    const check = 'error[missing-alt]: An `img` needs `alt`\n1 | img(src="/</script>")'

    document.head.innerHTML = problemsBlock([check])
    console.error('[kay] island a.kay did not match its server markup')
    console.warn('not kay')
    tool = startDevTool()
    console.warn('[kay] the persisted signal note could not be kept')
    console.warn('[kay] the persisted signal note could not be kept')
    await Bun.sleep(0)

    expect(problems()).toEqual([['error', 'island a.kay did not match its server markup'], ['warn', 'the persisted signal note could not be kept'], ['error', check]])
    expect(groups()).toEqual(['Recovered by kay (2)', 'kay check (1)'])
    expect(shadow().querySelector('.problem > .pill:not([hidden])')?.textContent).toBe('2 times')
    expect(bar()).toEqual(['kay', '3 problems'])
    expect(shadow().querySelector('.bar > button .pill.error')?.textContent).toBe('3 problems')
    expect(shadow().querySelector('[role=status]')?.textContent).toBe('3 problems')
  })

  it('copies every listed problem as plain text with the page URL, dismissed ones left out, and says whether it worked', async () => {
    const copied: string[] = []
    const copy = () => shadow().querySelector<HTMLButtonElement>('.actions button[title^="Copy"]')!

    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => void copied.push(text) } })
    document.head.innerHTML = problemsBlock(['error[missing-alt]: An `img` needs `alt`\n --> src/routes/index.kay:3:5'])
    console.error('[kay] island a.kay did not match its server markup')
    console.warn('[kay] a note to dismiss')
    tool = startDevTool()
    console.error('[kay] island a.kay did not match its server markup')
    await Bun.sleep(0)
    ;[...shadow().querySelectorAll<HTMLElement>('.problem')].find(problem => problem.textContent?.includes('a note to dismiss'))!.querySelector<HTMLButtonElement>('button')!.click()

    copy().click()
    await Bun.sleep(0)

    expect(copied).toEqual([`kay dev problems on ${location.href}\n\n[Recovered by kay] error (2 times)\nisland a.kay did not match its server markup\n\n[kay check] error\nerror[missing-alt]: An \`img\` needs \`alt\`\n --> src/routes/index.kay:3:5`])
    expect(copy().textContent).toBe('Copied')

    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => Promise.reject(new Error('denied')) } })
    copy().click()
    await Bun.sleep(0)
    expect(copy().textContent).toBe('Copy failed')

    for (const button of shadow().querySelectorAll<HTMLButtonElement>('.problem button'))
      button.click()

    expect(shadow().querySelector<HTMLElement>('.actions')!.hidden).toBe(true)
  })

  it('lists its tabs in a vertical rail that moves by Up and Down, and keeps the size it was given for the browser', async () => {
    tool = startDevTool()
    tool.tab({ id: 'other', label: 'Other' })
    await Bun.sleep(0)

    const rail = shadow().querySelector('[role=tablist]')!
    const icons = () => [...shadow().querySelectorAll<HTMLButtonElement>('.head .icon')].map(button => [button.getAttribute('aria-label'), button.title, button.textContent])

    expect(rail.getAttribute('aria-orientation')).toBe('vertical')
    expect([...rail.querySelectorAll('[role=tab]')].map(tab => tab.id)).toEqual(['problems', 'request', 'head', 'env', 'images', 'performance', 'routes', 'other'].map(id => `kay-dev-tab-${id}`))
    expect(icons()).toEqual([['Float', 'Float', ''], ['Dock to the bottom', 'Dock to the bottom', ''], ['Dock to the right', 'Dock to the right', ''], ['Fill the window', 'Fill the window', ''], ['Close', 'Close', '']])

    key({ key: 'K', code: 'KeyK', altKey: true, shiftKey: true })
    key({ key: 'ArrowDown' }, shadow().activeElement!)
    expect(shadow().activeElement?.id).toBe('kay-dev-tab-request')
    key({ key: 'ArrowUp' }, shadow().activeElement!)
    key({ key: 'ArrowUp' }, shadow().activeElement!)
    expect(shadow().activeElement?.id).toBe('kay-dev-tab-other')
    key({ key: 'ArrowRight' }, shadow().activeElement!)
    expect(shadow().activeElement?.id).toBe('kay-dev-tab-other')

    shadow().querySelector<HTMLButtonElement>('.icon[aria-label="Fill the window"]')!.click()
    expect(shadow().querySelector('.ui.max')).not.toBeNull()
    expect(icons()[3]).toEqual(['Restore the size', 'Restore the size', ''])
    tool.stop()

    tool = startDevTool()
    await Bun.sleep(0)

    expect(shadow().querySelector('.ui.max')).not.toBeNull()
    shadow().querySelector<HTMLButtonElement>('.icon[aria-label="Restore the size"]')!.click()
    expect(shadow().querySelector('.ui.max')).toBeNull()
  })

  it('opens on the bar or Alt+Shift+K, moves between tabs by arrow keys, closes on Escape from inside it, and keeps its tab for the browser tab and its dock for the browser', async () => {
    tool = startDevTool()
    tool.tab({ id: 'other', label: 'Other' })
    await Bun.sleep(0)

    // Styled by an adopted sheet and the sizes of its bars set through the CSSOM, which a policy without inline styles allows.
    expect(shadow().adoptedStyleSheets).toHaveLength(1)
    expect(shadow().querySelector('style')).toBeNull()

    expect(drawer().hidden).toBe(true)

    key({ key: 'K', code: 'KeyK', altKey: true, shiftKey: true })
    expect(drawer().hidden).toBe(false)
    expect(shadow().activeElement?.id).toBe('kay-dev-tab-problems')
    expect(shadow().querySelector('.empty')?.textContent).toBe('No problems on this page.')

    key({ key: 'ArrowDown' }, shadow().activeElement!)
    expect(shadow().activeElement?.id).toBe('kay-dev-tab-request')
    key({ key: 'End' }, shadow().activeElement!)
    expect(shadow().activeElement?.id).toBe('kay-dev-tab-other')
    expect(shadow().querySelector<HTMLElement>('#kay-dev-other')!.hidden).toBe(false)
    key({ key: 'Home' }, shadow().activeElement!)
    expect(shadow().activeElement?.id).toBe('kay-dev-tab-problems')

    // Escape from the page is the page's own.
    key({ key: 'Escape' })
    expect(drawer().hidden).toBe(false)

    key({ key: 'Escape' }, shadow().activeElement!)
    expect(drawer().hidden).toBe(true)
    expect(shadow().activeElement?.textContent).toBe('kay')

    shadow().querySelector<HTMLButtonElement>('.mark')!.click()
    shadow().querySelector<HTMLButtonElement>('.icon[aria-label="Dock to the right"]')!.click()
    tool.stop()
    sessionStorage.clear()

    tool = startDevTool()
    await Bun.sleep(0)

    expect(drawer().hidden).toBe(true)
    expect(shadow().querySelector('.ui.dock-right')).not.toBeNull()
    expect(shadow().querySelector('.icon[aria-label="Dock to the right"]')!.getAttribute('aria-pressed')).toBe('true')
  })

  it('docks to the bottom or the right padding the page while open, resizes from the grip the keyboard reaches, and reads a broken layout as the default', async () => {
    const padding = () => [...document.adoptedStyleSheets].flatMap(sheet => [...sheet.cssRules].map(rule => rule.cssText)).join(' ')
    const reached = () => [...shadow().querySelectorAll<HTMLElement>('.grip')].filter(grip => grip.tabIndex === 0).map(grip => grip.dataset.edge)
    const shown = () => [...shadow().querySelectorAll<HTMLElement>('.grip')].filter(grip => grip.hidden === false).map(grip => grip.dataset.edge)
    const dockTo = (label: string) => shadow().querySelector<HTMLButtonElement>(`.icon[aria-label="${label}"]`)!.click()

    localStorage.setItem('kay-dev-layout', '{"dock":"sideways","corner":"middle","box":{"left":"x"},"bottom":"tall"}')
    tool = startDevTool()
    await Bun.sleep(0)

    // A floating drawer resizes from every edge and corner, the keyboard reaching its bottom right corner.
    expect(shadow().querySelector('.ui.floating')).not.toBeNull()
    expect(shown()).toEqual(['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'])
    expect(reached()).toEqual(['se'])

    shadow().querySelector<HTMLButtonElement>('.mark')!.click()
    dockTo('Dock to the bottom')

    expect(shown()).toEqual(['n'])
    expect(shadow().querySelector('.grip.n')!.getAttribute('role')).toBe('separator')
    expect(shadow().querySelector<HTMLElement>('.ui')!.style.getPropertyValue('--dock')).toBe('320px')
    expect(padding()).toContain('padding-bottom: 320px')
    expect(shadow().querySelector<HTMLElement>('.size')!.hidden).toBe(true)

    // Up grows a drawer docked at the bottom, never past its smallest height: happy-dom lays nothing out, so the drawer measures 0 high.
    key({ key: 'ArrowUp' }, shadow().querySelector('.grip.n')!)
    expect((JSON.parse(localStorage.getItem('kay-dev-layout')!) as { bottom: number }).bottom).toBe(180)

    dockTo('Dock to the right')
    expect(padding()).toContain('padding-right: 448px')
    expect(reached()).toEqual(['w'])

    shadow().querySelector<HTMLButtonElement>('.mark')!.click()
    expect(padding()).not.toContain('padding')

    tool.stop()
    tool = undefined
    expect(document.adoptedStyleSheets).toHaveLength(0)
    expect(sessionStorage.getItem('kay-dev')).not.toContain('dock')
  })

  it('dismisses the problems shown for the rest of the browser tab, drops what the page logged as a swap starts, and reads what kay check finds again as it ends', async () => {
    document.head.innerHTML = problemsBlock(['warning[missing-title]: a page needs a title'])
    tool = startDevTool()
    console.warn('[kay] first')
    await Bun.sleep(0)

    dismissAll().click()
    expect(problems()).toEqual([])
    expect(bar()).toEqual(['kay'])

    console.warn('[kay] first')
    console.warn('[kay] second')
    await Bun.sleep(0)
    expect(problems()).toEqual([['warn', 'second']])

    tool.stop()
    document.head.innerHTML = problemsBlock(['warning[missing-title]: a page needs a title', 'warning[missing-alt]: an img needs alt'])
    tool = startDevTool()
    console.warn('[kay] on this page')
    await Bun.sleep(0)
    expect(problems()).toEqual([['warn', 'on this page'], ['warn', 'warning[missing-alt]: an img needs alt']])

    document.documentElement.setAttribute('aria-busy', 'true')
    await Bun.sleep(0)
    expect(problems()).toEqual([['warn', 'warning[missing-alt]: an img needs alt']])

    // Read again, a problem kay check still finds came no second time.
    document.documentElement.removeAttribute('aria-busy')
    await Bun.sleep(0)
    document.documentElement.setAttribute('aria-busy', 'true')
    await Bun.sleep(0)
    expect(shadow().querySelector<HTMLElement>('.problem > .pill')!.hidden).toBe(true)

    document.head.innerHTML = problemsBlock(['error[unread-prop]: a prop nothing reads'])
    document.documentElement.removeAttribute('aria-busy')
    await Bun.sleep(0)
    expect(problems()).toEqual([['error', 'error[unread-prop]: a prop nothing reads']])
  })

  it('lists what nothing caught and what the policy blocked, each under its heading, and dismisses one problem alone', async () => {
    tool = startDevTool()
    window.dispatchEvent(new ErrorEvent('error', { message: 'boom', error: Object.assign(new Error('boom'), { stack: 'Error: boom\n    at click (/_kay/client/a.js:1:2)' }) }))

    const rejected = new Event('unhandledrejection')
    const blocked = new Event('securitypolicyviolation')

    Object.defineProperty(rejected, 'reason', { value: 'nope' })
    Object.defineProperties(blocked, { disposition: { value: 'enforce' }, blockedURI: { value: 'https://cdn.example/x.js' }, effectiveDirective: { value: 'script-src-elem' }, sourceFile: { value: '' } })
    window.dispatchEvent(rejected)
    window.dispatchEvent(blocked)
    console.warn('[kay] a11y image-alt: Images must have alternative text\n  img.hero\nhttps://dequeuniversity.com/rules/axe/4.14/image-alt')
    await Bun.sleep(0)

    expect(groups()).toEqual(['Uncaught errors (2)', 'Blocked by the policy (1)', 'Accessibility (1)'])
    expect(problems()).toEqual([
      ['error', 'Error: boom\n    at click (/_kay/client/a.js:1:2)'],
      ['error', 'Uncaught (in promise) nope'],
      ['error', 'blocked https://cdn.example/x.js by script-src-elem'],
      ['warn', 'a11y image-alt: Images must have alternative text\n  img.hero\nhttps://dequeuniversity.com/rules/axe/4.14/image-alt'],
    ])

    shadow().querySelector<HTMLButtonElement>('.problem button[aria-label="Dismiss this problem"]')!.click()
    expect(groups()).toEqual(['Uncaught errors (1)', 'Blocked by the policy (1)', 'Accessibility (1)'])
  })

  it('lists an error kay caught in an island, heads a stack that lacks them with its name and message, and leaves out a resize observer note', async () => {
    tool = startDevTool()

    const thrown = Object.assign(new TypeError('no count'), { stack: 'counted@http://localhost/_kay/client/a.js:1:2' })
    const rejected = new Event('unhandledrejection')

    Object.defineProperty(rejected, 'reason', { value: thrown })
    // What kay reports, as an island's render that throws does, its client sending it to the server too.
    const { fetch } = globalThis

    globalThis.fetch = (async () => new Response(null)) as unknown as typeof fetch
    await import('../src/runtime/client')
    reportError(thrown, 'src/components/counter.kay')
    globalThis.fetch = fetch
    window.dispatchEvent(rejected)
    window.dispatchEvent(new ErrorEvent('error', { message: 'ResizeObserver loop completed with undelivered notifications.', error: null }))
    await Bun.sleep(0)

    expect(problems()).toEqual([
      ['error', 'in island src/components/counter.kay: TypeError: no count\ncounted@http://localhost/_kay/client/a.js:1:2'],
      ['error', 'Uncaught (in promise) TypeError: no count\ncounted@http://localhost/_kay/client/a.js:1:2'],
    ])
  })

  it('outlines the elements an accessibility problem names on hover', async () => {
    document.body.innerHTML = '<img class="hero" src="/a.png"><img class="hero" src="/b.png">'
    tool = startDevTool()
    console.warn('[kay] a11y image-alt: Images must have alternative text\n  img.hero\n  #in >>> img\n  and 3 more\nhttps://dequeuniversity.com/rules/axe/4.14/image-alt')
    await Bun.sleep(0)

    const visible = () => [...shadow().querySelectorAll<HTMLElement>('.outline')].filter(outline => outline.hidden === false).length

    shadow().querySelector('.problem')!.dispatchEvent(new PointerEvent('pointerenter'))
    expect(visible()).toBe(2)
    expect(shadow().querySelector('.label')!.textContent).toBe('image-alt')

    shadow().querySelector('.problem')!.dispatchEvent(new PointerEvent('pointerleave'))
    expect(visible()).toBe(0)
    document.body.innerHTML = ''
  })

  it('finds the .kay files a problem names by kay\'s route names, with a line alone, and none inside a URL', async () => {
    tool = startDevTool()
    console.error('[kay] src/routes/todos/[id].kay:3:4, src/routes/(site)/[[page]].kay:12, src/routes/[...rest].kay and http://localhost:3000/src/x.kay')
    await Bun.sleep(0)

    expect([...shadow().querySelectorAll('.problem button.position')].map(position => position.textContent)).toEqual(['src/routes/todos/[id].kay:3:4', 'src/routes/(site)/[[page]].kay:12', 'src/routes/[...rest].kay'])
  })

  it('opens each .kay file a problem names once an opener is set, saying why it could not', async () => {
    const opened: string[] = []

    tool = startDevTool()
    console.error('[kay] island src/components/card.kay did not match, see src/routes/index.kay:4:3.')
    console.error('[kay] line alone in src/routes/about.kay:7')
    await Bun.sleep(0)

    const positions = () => [...shadow().querySelectorAll<HTMLButtonElement>('.problem button.position')]

    expect(positions().map(position => [position.textContent, position.disabled])).toEqual([['src/components/card.kay', true], ['src/routes/index.kay:4:3', true], ['src/routes/about.kay:7', true]])

    tool.setOpener(async (source) => {
      opened.push(source)

      return source.startsWith('src/routes') ? 'no editor found, set KAY_EDITOR' : undefined
    })
    expect(positions().every(position => !position.disabled)).toBe(true)

    for (const position of positions())
      position.click()

    await Bun.sleep(0)

    expect(opened).toEqual(['src/components/card.kay:1:1', 'src/routes/index.kay:4:3', 'src/routes/about.kay:7:1'])
    expect(problems()[0]![1]).toBe('island src/components/card.kay did not match, see src/routes/index.kay:4:3 (no editor found, set KAY_EDITOR).')
  })

  it('answers the buttons of kay\'s error pages: a source position opens in the editor, Copy copies the error', async () => {
    const opened: string[] = []
    const copied: string[] = []

    document.body.innerHTML = '<button type="button" data-kay-open="src/stock.ts:4:11">src/stock.ts:4:11</button><button type="button" data-kay-copy="kay-error-text">Copy</button><pre id="kay-error-text" hidden>Error: no stock</pre>'
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (copy: string) => void copied.push(copy) } })
    tool = startDevTool()
    tool.setOpener(async (source) => {
      opened.push(source)

      return 'no editor found, set KAY_EDITOR'
    })

    const [open, copy] = document.querySelectorAll('button')

    open!.click()
    copy!.click()
    await Bun.sleep(0)

    expect(opened).toEqual(['src/stock.ts:4:11'])
    expect(open!.textContent).toBe('src/stock.ts:4:11 (no editor found, set KAY_EDITOR)')
    expect(copied).toEqual(['Error: no stock'])
    expect(copy!.textContent).toBe('Copied')
    document.body.innerHTML = ''
  })

  it('says nothing on the bar of a rebuild, and keeps no state of one for the page', async () => {
    tool = startDevTool()
    window.dispatchEvent(new CustomEvent('kay-dev-built', { detail: JSON.stringify({ id: 'a', at: Date.now(), changed: 'src/routes/index.kay', ms: 58 }) }))

    expect(shadow().querySelector('.built')).toBeNull()
    expect(bar()).toEqual(['kay'])
    expect('$kayBuilt' in window).toBe(false)
  })

  it('gives a tab its icon, the default one when it names none, and tones its count', () => {
    tool = startDevTool()

    const plain = tool.tab({ id: 'plain', label: 'Plain', summary: count => `${count} plain` })
    const named = tool.tab({ id: 'named', label: 'Named', icon: 'mail', summary: count => `${count} named` })
    const icon = (id: string) => shadow().querySelector(`#kay-dev-tab-${id} svg`)!.innerHTML

    plain.count(2, 'warn')
    named.count(1, 'error')

    expect(icon('plain')).toBe(tool.icon('puzzle').innerHTML)
    expect(icon('named')).toBe(tool.icon('mail').innerHTML)
    expect(shadow().querySelector('#kay-dev-tab-plain .count')!.className).toBe('count pill warn')
    expect(shadow().querySelector('#kay-dev-tab-named .count')!.className).toBe('count pill error')

    const badges = [...shadow().querySelectorAll('.bar > button:not([hidden]) .pill')].map(badge => `${badge.className} ${badge.textContent}`)

    expect(badges).toContain('pill warn 2 plain')
    expect(badges).toContain('pill error 1 named')
  })

  it('shows the page\'s path in the head, and follows a swap', async () => {
    const { happyDOM } = window as unknown as { happyDOM: { setURL: (url: string) => void } }
    const { href } = location

    happyDOM.setURL('http://localhost/docs?page=2')
    tool = startDevTool()

    try {
      expect(shadow().querySelector('.head .where')!.textContent).toBe('/docs?page=2')

      happyDOM.setURL('http://localhost/next')
      window.dispatchEvent(new PopStateEvent('popstate'))

      expect(shadow().querySelector('.head .where')!.textContent).toBe('/next')
    }
    finally {
      happyDOM.setURL(href)
    }
  })

  it('shows what served the page, its route, files, params, status and loads, and reads the next page\'s as a swap brings it', async () => {
    const block = (request: object) => {
      const script = document.createElement('script')

      script.type = 'application/json'
      script.id = 'kay-dev-request'
      script.textContent = JSON.stringify(request)

      return script
    }
    const facts = () => [...shadow().querySelectorAll('#kay-dev-request dt')].map(term => `${term.textContent}: ${[...term.nextElementSibling!.children].map(line => line.textContent).join(' / ') || term.nextElementSibling!.textContent}`)
    const line = () => [...shadow().querySelector('#kay-dev-request .reqline')!.children].map(part => part.textContent)
    const chain = () => [...shadow().querySelectorAll('#kay-dev-request .chain li')].map(item => [...item.children].map(part => part.textContent).filter(Boolean).join(' '))
    const timing = () => {
      const grid = shadow().querySelector<HTMLElement>('#kay-dev-request .timing')

      return grid === null ? [] : [...grid.children].map(part => part.textContent).filter((_, index) => index % 3 !== 1).reduce<string[]>((rows, part, index) => index % 2 === 0 ? [...rows, part] : [...rows.slice(0, -1), `${rows.at(-1)} ${part}`], [])
    }
    const bars = () => [...shadow().querySelectorAll<HTMLElement>('#kay-dev-request .timing i')].map(fill => Number.parseFloat(fill.style.width))
    const opened: string[] = []
    let recorded: DevResponse | undefined = {
      headers: [['x-request-id', 'abc'], ['cache-control', 'no-store'], ['content-type', 'text/html'], ['content-security-policy', 'default-src \'self\'; script-src \'self\' \'sha256-abc\'; img-src *']],
      ms: 51.2,
      redirects: [{ from: '/members', status: 307, by: 'the guard src/routes/members/_guard.ts' }],
    }
    const asked: string[] = []
    const fetching = spyOn(window, 'fetch').mockImplementation((async (url: string) => {
      asked.push(url)

      return recorded ? new Response(JSON.stringify(recorded)) : new Response(null, { status: 404 })
    }) as unknown as typeof window.fetch)

    document.head.append(block({ route: '/items/:id', page: 'src/routes/items/[id].kay', layouts: ['src/routes/_layout.kay'], params: { id: '7' }, id: 'abc', guards: [{ file: 'src/routes/_guard.ts', outcome: 'passed' }, { file: 'src/routes/items/_guard.ts', outcome: 'passed' }], prerender: 'listed', locale: 'fr', status: 200, loads: [{ file: 'src/routes/_layout.kay', ms: 1.5 }, { file: 'src/routes/items/[id].kay', ms: 42.4 }] }))
    tool = startDevTool()
    shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-request')!.click()
    await Bun.sleep(0)

    await Bun.sleep(0)

    expect(asked).toEqual(['/_kay/dev/request?id=abc'])
    expect(line()).toEqual(['GET', `${location.pathname}${location.search}`, '200', '51 ms on the server'])
    expect(facts()).toEqual([
      'Route: /items/:id',
      'Params: id = "7"',
      'Locale: fr',
      'Rendered: on request here, prerendered by kay build for the paths its setting lists',
      'Redirected: /members (307, by the guard src/routes/members/_guard.ts)',
    ])
    expect(chain()).toEqual(['Guard src/routes/_guard.ts passed', 'Guard src/routes/items/_guard.ts passed', 'Layout src/routes/_layout.kay', 'Page src/routes/items/[id].kay'])
    expect(timing()).toEqual(['src/routes/_layout.kay 1.5 ms', 'src/routes/items/[id].kay 42 ms', 'Whole request 51 ms'])
    expect(bars()[0]).toBeCloseTo(1.5 / 51.2 * 100)
    expect(bars()[1]).toBeCloseTo(42.4 / 51.2 * 100)
    expect(bars()[2]).toBe(100)
    expect([...shadow().querySelectorAll('#kay-dev-request .headers tr')].map(row => [...row.children].map(cell => cell.textContent))).toEqual([
      ['content-security-policy', 'default-src \'self\';script-src \'self\' \'sha256-abc\';img-src *;'],
      ['cache-control', 'no-store'],
      ['x-request-id', 'abc'],
      ['content-type', 'text/html'],
    ])

    // A policy reads a directive to a line.
    expect([...shadow().querySelectorAll('.headers .directive')].map(line => line.textContent)).toEqual(['default-src \'self\';', 'script-src \'self\' \'sha256-abc\';', 'img-src *;'])

    // The swap adds the next page's block, then drops this one's.
    recorded = undefined
    document.head.append(block({ page: 'src/routes/_404.kay', layouts: [], params: {}, id: 'def', guards: [{ file: 'src/routes/_guard.ts', outcome: 'denied with 403' }], locale: 'en', status: 404, error: 'Not Found', loads: [] }))
    await Bun.sleep(0)
    document.head.firstElementChild!.remove()
    await Bun.sleep(0)
    await Bun.sleep(0)

    expect(line()).toEqual(['GET', `${location.pathname}${location.search}`, '404 Not Found'])
    expect(facts()).toEqual(['Route: none matched', 'Params: none', 'Locale: en', 'Rendered: not known, a guard refused the request', 'Response: not recorded by the server'])
    expect(chain()).toEqual(['Guard src/routes/_guard.ts denied with 403', 'Page src/routes/_404.kay'])
    expect(timing()).toEqual([])
    expect(shadow().querySelector('#kay-dev-request .reqline .pill')?.textContent).toBe('404 Not Found')
    expect(shadow().querySelector('#kay-dev-request .reqline .pill')?.classList.contains('error')).toBe(true)

    tool.setOpener(async (source) => {
      opened.push(source)

      return undefined
    })
    shadow().querySelector<HTMLButtonElement>('#kay-dev-request .chain li:last-child button.position')!.click()
    await Bun.sleep(0)

    expect(opened).toEqual(['src/routes/_404.kay:1:1'])
    fetching.mockRestore()
  })

  it('adds an i18n tab for a site with locales alone: the page\'s locale, a link to it in each, the messages no locale has, cleared as a swap starts', async () => {
    const block = (request: object) => {
      const script = document.createElement('script')

      script.type = 'application/json'
      script.id = 'kay-dev-request'
      script.textContent = JSON.stringify(request)

      return script
    }
    const panel = () => shadow().querySelector('#kay-dev-i18n')
    const links = () => [...panel()!.querySelectorAll('.locale-chip')].map(link => `${link.textContent}${link.getAttribute('href') === null ? '' : ` ${link.getAttribute('href')}`}${link.getAttribute('aria-current') === null ? '' : ' current'}`)
    const count = () => shadow().querySelector('#kay-dev-tab-i18n .count')?.textContent

    document.head.append(block({ ...PAGE, locale: 'en' }))
    tool = startDevTool()
    expect(panel()).toBeNull()
    tool.stop()

    console.error('[kay] no locale has the message "nav.home"; production shows the key itself')
    document.head.replaceChildren(block({ ...PAGE, locale: 'en', locales: [{ locale: 'en', href: '/docs/about' }, { locale: 'fr', href: '/docs/fr/a-propos' }] }))
    tool = startDevTool()
    expect(links()).toEqual(['en current', 'fr /docs/fr/a-propos'])
    expect(panel()!.textContent).toContain('nav.home')
    expect(count()).toBe('1')

    console.error('[kay] no locale has the message "nav.home"; production shows the key itself')
    console.error('[kay] no locale has the message "a\\"b"; production shows the key itself')
    await Bun.sleep(0)
    expect(panel()!.querySelectorAll('.missing li')).toHaveLength(2)
    expect(panel()!.textContent).toContain('a"b')

    document.head.replaceChildren(block({ ...PAGE, locale: 'fr', locales: [{ locale: 'en', href: '/docs/about' }, { locale: 'fr', href: '/docs/fr/a-propos' }] }))
    await Bun.sleep(0)
    expect(links()).toEqual(['en /docs/about', 'fr current'])

    document.documentElement.setAttribute('aria-busy', 'true')
    await Bun.sleep(0)
    expect(panel()!.querySelectorAll('.missing li')).toHaveLength(0)
    expect(count()).toBe('0')
  })

  it('lists the routes the server serves as the tab shows and after each restart, filtered as typed, linking the paths no request fills in, the page shown marked', async () => {
    const fetched: string[] = []
    const { happyDOM } = window as unknown as { happyDOM: { setURL: (url: string) => void } }
    const { href } = location
    let status = 200

    happyDOM.setURL('http://localhost/broken')
    const fetching = spyOn(window, 'fetch').mockImplementation((async (url: string) => {
      fetched.push(url)

      return new Response(JSON.stringify({ notes: ['`seo` is set but not the origin, so there is no sitemap or robots.txt.'], routes: [
        { kind: 'page', method: 'GET', path: '/broken', file: 'src/routes/broken.kay', href: '/broken' },
        { kind: 'page', method: 'GET', path: '/items/:id', file: 'src/routes/items/[id].kay' },
        { kind: 'page', method: 'GET', path: '/fr/a-propos', file: 'src/routes/about.kay', locale: 'fr', href: '/fr/a-propos' },
        { kind: 'api', method: 'POST', path: '/api/stock/:id', file: 'src/api/stock.ts' },
        { kind: 'kay', method: 'GET', path: '/manifest.webmanifest', file: '', owner: 'the web app manifest', href: '/manifest.webmanifest' },
      ] }), { status })
    }) as unknown as typeof window.fetch)

    const rows = () => [...shadow().querySelectorAll('#kay-dev-routes .route')].map(row => [...row.children].map(cell => cell.textContent).join(' | '))
    const filter = () => shadow().querySelector<HTMLInputElement>('#kay-dev-routes input')!
    const sections = () => [...shadow().querySelectorAll('#kay-dev-routes .group')].map(group => `${group.querySelector('h3')!.firstChild!.textContent} (${group.querySelector('h3 .pill')!.textContent})`)

    try {
      tool = startDevTool()
      shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-routes')!.click()
      await Bun.sleep(0)

      expect(fetched).toEqual(['/_kay/dev/routes'])
      expect(sections()).toEqual(['Pages (3)', 'API (1)', 'Served by kay (1)'])
      expect(rows()).toEqual(['GET | /broken |  | src/routes/broken.kay', 'GET | /items/:id |  | src/routes/items/[id].kay', 'GET | /fr/a-propos | fr | src/routes/about.kay', 'POST | /api/stock/:id |  | src/api/stock.ts', 'GET | /manifest.webmanifest |  | the web app manifest'])
      expect([...shadow().querySelectorAll<HTMLAnchorElement>('#kay-dev-routes a')].map(link => link.getAttribute('href'))).toEqual(['/broken', '/fr/a-propos', '/manifest.webmanifest'])
      expect(shadow().querySelector('#kay-dev-routes > .list > .note')?.textContent).toContain('no sitemap or robots.txt')
      expect(shadow().querySelector('#kay-dev-routes [aria-current=page] .path')?.textContent).toBe('/broken')

      filter().value = 'ABOUT'
      filter().dispatchEvent(new Event('input'))
      expect(rows()).toEqual(['GET | /fr/a-propos | fr | src/routes/about.kay'])
      filter().value = 'nothing'
      filter().dispatchEvent(new Event('input'))
      expect(shadow().querySelector('#kay-dev-routes .empty')?.textContent).toBe('No route matches the filter.')

      // A restart may change the routes: the tab shown asks again.
      status = 500
      window.dispatchEvent(new CustomEvent('kay-dev-built', { detail: JSON.stringify({ id: 'b', at: 0, changed: 'src/routes/x.kay', ms: 1 }) }))
      await Bun.sleep(0)

      expect(fetched).toHaveLength(2)
      expect(shadow().querySelector('#kay-dev-routes .empty')?.textContent).toBe('Could not list the routes: the server answered 500')
    }
    finally {
      fetching.mockRestore()
      happyDOM.setURL(href)
    }
  })

  it('shows the head of the page: its search result, title and description with their lengths, canonical, alternates, robots, social tags and card, JSON-LD parsed or failing, and what the server flags, again after a page swap', async () => {
    const asked: { path: string, head: string }[] = []
    const { happyDOM } = window as unknown as { happyDOM: { setURL: (url: string) => void } }
    const { href } = location
    let answer: DevHead = { descriptionLength: 160, site: 'https://shop.example', sitemap: 'listed', problems: [{ code: 'long-description', severity: 'warning', message: 'The description of `/` runs 200 characters', help: 'shorten it' }] }

    happyDOM.setURL('http://localhost:3000/')
    document.head.innerHTML = [
      '<title>Home | Shop</title>',
      '<meta name="description" content="The shop">',
      '<link rel="canonical" href="https://shop.example/">',
      '<link rel="alternate" hreflang="fr" href="https://shop.example/fr">',
      '<meta name="robots" content="noindex">',
      '<meta property="og:title" content="Home">',
      '<meta property="og:image" content="https://shop.example/_kay/card?title=Home">',
      '<meta name="twitter:card" content="summary_large_image">',
      '<script type="application/ld+json">{"@type":"WebSite"}</script>',
      '<script type="application/ld+json">{"@type": </script>',
    ].join('')

    const fetching = spyOn(window, 'fetch').mockImplementation((async (_url: string, init: RequestInit) => {
      asked.push(JSON.parse(init.body as string) as { path: string, head: string })

      return new Response(JSON.stringify(answer))
    }) as unknown as typeof window.fetch)
    const panel = () => shadow().querySelector('#kay-dev-head')!
    const text = (selector: string) => [...panel().querySelectorAll(selector)].map(element => element.textContent)

    try {
      tool = startDevTool()
      shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-head')!.click()
      await Bun.sleep(0)

      expect(asked).toHaveLength(1)
      expect(asked[0]!.path).toBe('/')
      expect(asked[0]!.head).toContain('Home | Shop')
      expect(text('.problem pre')).toEqual(['The description of `/` runs 200 characters\nhelp: shorten it'])
      expect(text('.serp span:not(.cap)')).toEqual(['https://shop.example/', 'Home | Shop', 'The shop'])
      expect(panel().querySelector('.facts')!.textContent).toBe('TitleHome | Shop11 / 60DescriptionThe shop8 / 160Canonicalhttps://shop.example/Alternatesfr: https://shop.example/frRobotsnoindexSitemaplisted')
      expect(text('.meter.over')).toEqual([])
      expect(text('h3')).toEqual(['Tags', 'Open Graph2', 'Twitter1', 'JSON-LD2'])
      expect(panel().querySelector<HTMLImageElement>('.preview img.card')!.src).toBe('http://localhost:3000/_kay/card?title=Home')
      expect(text('.json summary')).toEqual(['WebSite'])
      expect(text('.json pre')).toEqual(['{\n  "@type": "WebSite"\n}'])
      expect(panel().querySelector('.error')?.textContent).toContain('Not valid JSON')
      expect(shadow().querySelector('#kay-dev-tab-head .count')?.textContent).toBe('1')

      // A swap brings the next page's head, with no origin to list it in.
      answer = { descriptionLength: 160, sitemap: 'none', problems: [] }
      document.head.innerHTML = '<title>About</title>'
      await Bun.sleep(0)
      await Bun.sleep(0)

      expect(asked).toHaveLength(2)
      expect(text('.serp span:not(.cap)')).toEqual(['http://localhost:3000/', 'About', 'No description'])
      expect(panel().querySelector('.facts')!.textContent).toContain('Sitemapnone, the site has no origin')
      expect(panel().querySelector('img.card')).toBeNull()
      expect(panel().querySelector('.preview:not(.serp)')!.textContent).toContain('No og:image or twitter:image tag.')
      expect(text('.problem')).toEqual([])
      expect(shadow().querySelector<HTMLElement>('#kay-dev-tab-head .count')!.hidden).toBe(true)

      // A server that fails leaves the head readable.
      fetching.mockImplementation((async () => new Response(null, { status: 500 })) as unknown as typeof window.fetch)
      document.head.innerHTML = '<title>Again</title><meta property="og:image" content="http://">'
      await Bun.sleep(0)
      await Bun.sleep(0)

      expect(panel().querySelector('.empty')?.textContent).toBe('Could not check the head: the server answered 500')
      expect(text('.serp span:not(.cap)')[1]).toBe('Again')
      expect(panel().querySelector('.error')?.textContent).toBe('The social card image is not a valid URL: http://')
    }
    finally {
      fetching.mockRestore()
      happyDOM.setURL(href)
    }
  })

  it('shows one snapshot of the head when the page swaps while the server is asked', async () => {
    const { happyDOM } = window as unknown as { happyDOM: { setURL: (url: string) => void } }
    const { href } = location
    let release!: () => void
    const stalled = new Promise<void>((resolve) => {
      release = resolve
    })

    happyDOM.setURL('http://localhost:3000/')
    document.head.innerHTML = '<title>Home | Shop</title><meta name="description" content="The shop"><meta property="og:title" content="Home">'

    const fetching = spyOn(window, 'fetch').mockImplementation((async () => {
      await stalled

      return new Response(JSON.stringify({ descriptionLength: 160, sitemap: 'none', problems: [] } satisfies DevHead))
    }) as unknown as typeof window.fetch)
    const panel = () => shadow().querySelector('#kay-dev-head')!

    try {
      tool = startDevTool()
      shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-head')!.click()
      await Bun.sleep(0)
      // The tab is hidden when the page swaps, so no read follows the swap.
      shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-request')!.click()
      document.head.innerHTML = '<title>About</title><meta name="description" content="Other"><meta property="og:title" content="About">'
      await Bun.sleep(0)
      release()
      await Bun.sleep(0)
      await Bun.sleep(0)

      expect(panel().textContent).toContain('Home | Shop')
      expect(panel().textContent).not.toContain('About')
      expect(panel().textContent).not.toContain('Other')
    }
    finally {
      fetching.mockRestore()
      happyDOM.setURL(href)
    }
  })

  it('lists the env the browser receives, as the server sends it, flags what looks like a secret, and says when the app sends none', async () => {
    const dir = await scratchDir('dev-tool-env-')
    const routes = relative(process.cwd(), join(dir, 'routes'))
    const names = ['KAY_TEST_ZOOM', 'KAY_TEST_MAP_KEY', 'KAY_TEST_STRIPE_SECRET', 'KAY_TEST_SESSION', 'KAY_TEST_FEED', 'KAY_TEST_REGION', 'KAY_TEST_REDIS_URL', 'KAY_TEST_HEX', 'KAY_TEST_AWS', 'KAY_TEST_PUBLISHABLE_KEY'] as const
    const given = { KAY_TEST_ZOOM: '12', KAY_TEST_MAP_KEY: 'pk.123', KAY_TEST_STRIPE_SECRET: 'abc', KAY_TEST_SESSION: 'q8Zr3VxK1mT9yB2nWd5LpC7aHs4JfE6u', KAY_TEST_FEED: 'postgres://app:hunter2@db.internal/app', KAY_TEST_REGION: 'eu-west-1', KAY_TEST_REDIS_URL: 'redis://cache:6379', KAY_TEST_HEX: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', KAY_TEST_AWS: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY1', KAY_TEST_PUBLISHABLE_KEY: 'pk_live_abc' }

    await Bun.write(join(dir, 'routes/index.kay'), 'p Home\n')
    Object.assign(process.env, given)

    const publicEnv = t.Object({ KAY_TEST_ZOOM: t.Numeric(), KAY_TEST_MAP_KEY: t.String(), KAY_TEST_STRIPE_SECRET: t.String(), KAY_TEST_SESSION: t.String(), KAY_TEST_FEED: t.String(), KAY_TEST_REGION: t.String(), KAY_TEST_REDIS_URL: t.String(), KAY_TEST_HEX: t.String(), KAY_TEST_AWS: t.String(), KAY_TEST_PUBLISHABLE_KEY: t.String() })
    const { happyDOM } = window as unknown as { happyDOM: { setURL: (url: string) => void } }
    const { href } = location
    const asked: string[] = []
    let app = await pages({ routes, dev: true, publicEnv })
    const fetching = spyOn(window, 'fetch').mockImplementation((async (url: string) => {
      asked.push(url)

      return app.handle(new Request(`http://localhost${url}`))
    }) as unknown as typeof window.fetch)
    const flag = (row: Element) => {
      if (row.querySelector('.flag'))
        return ' (flagged)'

      return row.querySelector('.soft') ? ' (noted)' : ''
    }
    const rows = () => [...shadow().querySelectorAll('#kay-dev-env .envrow')].map(row => `${row.querySelector('.name')!.textContent} = ${row.querySelector('.val')!.textContent}${flag(row)}`)

    try {
      happyDOM.setURL('http://localhost/')
      tool = startDevTool()
      shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-env')!.click()
      await Bun.sleep(20)

      expect(asked).toEqual(['/_kay/env.js'])
      expect(rows()).toEqual([
        'KAY_TEST_ZOOM = 12',
        'KAY_TEST_MAP_KEY = pk.123 (noted)',
        'KAY_TEST_STRIPE_SECRET = abc (flagged)',
        'KAY_TEST_SESSION = q8Zr3VxK1mT9yB2nWd5LpC7aHs4JfE6u (flagged)',
        'KAY_TEST_FEED = postgres://app:hunter2@db.internal/app (flagged)',
        'KAY_TEST_REGION = eu-west-1',
        'KAY_TEST_REDIS_URL = redis://cache:6379 (flagged)',
        'KAY_TEST_HEX = 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 (flagged)',
        'KAY_TEST_AWS = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY1 (flagged)',
        'KAY_TEST_PUBLISHABLE_KEY = pk_live_abc',
      ])
      expect(shadow().querySelector('#kay-dev-tab-env .count')?.textContent).toBe('6')

      // No `publicEnv`: nothing reaches the browser, and the tab says so after the restart.
      app = await pages({ routes, dev: true })
      window.dispatchEvent(new CustomEvent('kay-dev-built', { detail: JSON.stringify({ id: 'b', at: 0, changed: 'kay.config.ts', ms: 1 }) }))
      await Bun.sleep(20)

      expect(shadow().querySelector('#kay-dev-env .empty')?.textContent).toContain('sends no public env')
      expect(shadow().querySelector<HTMLElement>('#kay-dev-tab-env .count')!.hidden).toBe(true)

      // Only a missing route means none: a failing server, or a page answering in its place, is told as a failure.
      for (const answer of [new Response(null, { status: 503 }), new Response('<p>Home</p>', { headers: { 'content-type': 'text/html' } })]) {
        fetching.mockImplementation((async () => answer.clone()) as unknown as typeof window.fetch)
        window.dispatchEvent(new CustomEvent('kay-dev-built', { detail: JSON.stringify({ id: 'c', at: 0, changed: 'kay.config.ts', ms: 1 }) }))
        await Bun.sleep(20)

        expect(shadow().querySelector('#kay-dev-env .empty')?.textContent).toContain('Could not read the public env')
      }
    }
    finally {
      fetching.mockRestore()
      happyDOM.setURL(href)

      for (const name of names)
        delete process.env[name]

      delete (globalThis as { [PUBLIC_ENV]?: unknown })[PUBLIC_ENV]
    }
  })

  it('lists the images of the page with the variant and format each got, the size served against the size drawn, the largest paint and what is wrong with each, and outlines one on hover', async () => {
    const { happyDOM } = window as unknown as { happyDOM: { setURL: (url: string) => void } }
    const { href } = location
    const observed = fakeObserver()

    happyDOM.setURL('http://localhost/')
    document.body.innerHTML = [
      '<img id="hero" src="/_kay/image?src=%2F_kay%2Fassets%2Fhero.jpg&w=1280" width="1280" height="720" alt="">',
      '<img id="plain" src="/photo.jpg" width="4000" height="3000" alt="">',
      '<img id="bare" src="/_kay/images/logo-320-1x1.webp" loading="lazy" alt="">',
      '<img id="far" src="https://cdn.example/a.png" width="10" height="10" alt="">',
      '<img id="odd" src="/_kay/images/100%.webp" width="10" height="10" alt="">',
      '<img id="broken" src="http://" width="10" height="10" alt="">',
      '<img id="gone" src="/_kay/images/gone.webp" width="10" height="10" alt="">',
      '<img id="hung" src="/_kay/images/hung.webp" width="10" height="10" alt="">',
      '<img id="unloaded" src="/_kay/images/unloaded.webp" loading="lazy" width="10" height="10" alt="">',
    ].join('')

    // The browser draws and loads: sizes are not computed here.
    const sizes: Record<string, [number, number, number]> = { hero: [640, 360, 1280], plain: [300, 225, 4000], bare: [80, 80, 160], far: [10, 10, 10], odd: [10, 10, 10], broken: [10, 10, 10], gone: [10, 10, 10], hung: [10, 10, 10], unloaded: [10, 10, 0] }

    for (const [id, [width, height, natural]] of Object.entries(sizes)) {
      const image = document.getElementById(id) as HTMLImageElement

      Object.defineProperty(image, 'naturalWidth', { value: natural })
      Object.defineProperty(image, 'naturalHeight', { value: natural })
      Object.defineProperty(image, 'complete', { value: natural > 0 })
      image.getBoundingClientRect = () => ({ width, height, top: id === 'bare' ? 100 : 5000, bottom: 5100, left: 0, right: width, x: 0, y: 0, toJSON: () => ({}) })
    }

    const { devicePixelRatio } = window

    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true })
    const asked: string[] = []
    const signals: unknown[] = []
    let missing = true
    const fetching = spyOn(window, 'fetch').mockImplementation((async (url: string, init: RequestInit) => {
      asked.push(`${init.method} ${url}`)
      signals.push(init.signal)

      // Never answers, until the request is given up on.
      if (url.includes('hung'))
        return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('timeout'))))

      if (url.includes('gone') && missing)
        return new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } })

      const photo = url.includes('photo')
      const type = photo ? 'image/jpeg' : 'image/avif'

      return new Response(null, { headers: { 'content-type': url.includes('logo') ? 'image/webp' : type, 'content-length': photo ? '2500000' : '45000' } })
    }) as unknown as typeof window.fetch)
    const rows = () => [...shadow().querySelectorAll('#kay-dev-images .image')].map(row => [`${row.querySelector('.src')!.firstChild!.textContent}${row.querySelector('.src .pill') === null ? '' : ' (largest paint)'}`, [...row.querySelectorAll('.chip')].map(chip => chip.textContent).join(' - '), ...[...row.querySelectorAll('.flag')].map(flag => flag.textContent)].join(' | '))

    try {
      tool = startDevTool()
      observed.report('largest-contentful-paint', [{ startTime: 900, renderTime: 900, element: document.getElementById('hero')! }])
      shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-images')!.click()
      await Bun.sleep(20)

      // Only loaded images of kay's own routes are asked for: the app's handlers, an image not drawn yet and another host are not, and a request that hangs holds back none of the others.
      expect(asked).toEqual(['HEAD http://localhost/_kay/image?src=%2F_kay%2Fassets%2Fhero.jpg&w=1280', 'HEAD http://localhost/_kay/images/logo-320-1x1.webp', 'HEAD http://localhost/_kay/images/100%.webp', 'HEAD http://localhost/_kay/images/gone.webp', 'HEAD http://localhost/_kay/images/hung.webp'])
      expect(signals.every(signal => signal instanceof AbortSignal)).toBe(true)
      expect(rows()).toEqual([
        '/_kay/image?src=%2F_kay%2Fassets%2Fhero.jpg&w=1280 (largest paint) | 1280w, resized on request - avif, 43.9 KB - 1280x1280 drawn 640x360 at 2x',
        '/photo.jpg | not resized by kay - format not looked up - 4000x4000 drawn 300x225 at 2x | served 59 times the pixels it is drawn with, give it a smaller width or `sizes`',
        '/_kay/images/logo-320-1x1.webp | 320w, cut 1x1, written by kay build - webp, 43.9 KB - 160x160 drawn 80x80 at 2x | no width and height, so the page shifts as it loads | lazy-loaded but in view, which delays it',
        'https://cdn.example/a.png | not resized by kay - on another host - 10x10 drawn 10x10 at 2x',
        '/_kay/images/100%.webp | not resized by kay - avif, 43.9 KB - 10x10 drawn 10x10 at 2x',
        'http:// | not resized by kay - format unknown - 10x10 drawn 10x10 at 2x',
        '/_kay/images/gone.webp | not resized by kay - the server answered 404 - 10x10 drawn 10x10 at 2x',
        '/_kay/images/hung.webp | not resized by kay - format... - 10x10 drawn 10x10 at 2x',
        '/_kay/images/unloaded.webp | not resized by kay - not loaded - not loaded, drawn 10x10 at 2x',
      ])
      expect(shadow().querySelector('#kay-dev-tab-images .count')?.textContent).toBe('3')

      // The page changes under the open tab: an image added is listed, and the answers already read are not asked for again.
      document.body.insertAdjacentHTML('beforeend', '<img id="late" src="/late.png" width="10" height="10" alt="">')
      await Bun.sleep(20)

      expect(rows()).toHaveLength(10)

      // No answer is asked for again, the 404 and the request still pending included, until the next rebuild.
      missing = false
      document.body.insertAdjacentHTML('beforeend', '<img id="later" src="/later.png" width="10" height="10" alt="">')
      await Bun.sleep(20)

      expect(asked).toHaveLength(5)
      expect(rows().at(-5)).toContain('the server answered 404')

      window.dispatchEvent(new CustomEvent('kay-dev-built', { detail: JSON.stringify({ id: 'b', at: 0, changed: 'src/routes/x.kay', ms: 1 }) }))
      await Bun.sleep(20)

      expect(asked.filter(request => request.includes('gone'))).toHaveLength(2)
      expect(rows().at(-5)).toContain('avif, 43.9 KB')

      const visible = () => [...shadow().querySelectorAll<HTMLElement>('.outline')].filter(outline => outline.hidden === false).length

      shadow().querySelector('#kay-dev-images .image')!.dispatchEvent(new PointerEvent('pointerenter'))
      expect(visible()).toBe(1)
      shadow().querySelector('#kay-dev-images .image')!.dispatchEvent(new PointerEvent('pointerleave'))
      expect(visible()).toBe(0)
    }
    finally {
      fetching.mockRestore()
      delete (window as { PerformanceObserver?: unknown }).PerformanceObserver
      Object.defineProperty(window, 'devicePixelRatio', { value: devicePixelRatio, configurable: true })
      document.body.innerHTML = ''
      happyDOM.setURL(href)
    }
  })

  it('never flags an SVG as served more pixels than it is drawn with, still flags a raster, and still flags an SVG without width and height', async () => {
    const { happyDOM } = window as unknown as { happyDOM: { setURL: (url: string) => void } }
    const { href } = location

    happyDOM.setURL('http://localhost/')
    document.body.innerHTML = [
      '<img id="viewbox" src="/_kay/assets/logo.svg" alt="">',
      '<img id="sized" src="/logo.svg" width="16" height="16" alt="">',
      '<img id="large" src="/large.svg" width="16" height="16" alt="">',
      '<img id="query" src="/logo.svg?v=2#mark" width="16" height="16" alt="">',
      '<img id="upper" src="/LOGO%2ESVG" width="16" height="16" alt="">',
      '<img id="png" src="/logo.png" width="16" height="16" alt="">',
      '<img id="decoy" src="/logo.png?file=a.svg" width="16" height="16" alt="">',
    ].join('')

    for (const image of document.querySelectorAll('img')) {
      const natural = image.id === 'large' ? 512 : 150

      Object.defineProperty(image, 'naturalWidth', { value: natural })
      Object.defineProperty(image, 'naturalHeight', { value: natural })
      Object.defineProperty(image, 'complete', { value: true })
      image.getBoundingClientRect = () => ({ width: 16, height: 16, top: 5000, bottom: 5016, left: 0, right: 16, x: 0, y: 0, toJSON: () => ({}) })
    }

    const fetching = spyOn(window, 'fetch').mockImplementation((async () => new Response(null, { headers: { 'content-type': 'image/svg+xml' } })) as unknown as typeof window.fetch)
    const flags = () => [...shadow().querySelectorAll('#kay-dev-images .image')].map(row => [row.querySelector('.src')?.textContent, ...[...row.querySelectorAll('.flag')].map(flag => flag.textContent)].join(' | '))

    try {
      tool = startDevTool()
      shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-images')!.click()
      await Bun.sleep(20)

      expect(flags()).toEqual([
        '/_kay/assets/logo.svg | no width and height, so the page shifts as it loads',
        '/logo.svg',
        '/large.svg',
        '/logo.svg?v=2#mark',
        '/LOGO%2ESVG',
        '/logo.png | served 88 times the pixels it is drawn with, give it a smaller width or `sizes`',
        '/logo.png?file=a.svg | served 88 times the pixels it is drawn with, give it a smaller width or `sizes`',
      ])
    }
    finally {
      fetching.mockRestore()
      document.body.innerHTML = ''
      happyDOM.setURL(href)
    }
  })

  it('gives copies of one image drawn alike one row, outlining each, and rounds the density', async () => {
    const { happyDOM } = window as unknown as { happyDOM: { setURL: (url: string) => void } }
    const { href } = location
    const { devicePixelRatio } = window

    happyDOM.setURL('http://localhost/')
    document.body.innerHTML = [
      '<img src="/logo.svg" width="16" height="16" alt="">',
      '<img src="/logo.svg" width="16" height="16" alt="">',
      '<img src="/logo.svg" width="16" height="16" alt="">',
      '<img id="big" src="/logo.svg" width="32" height="32" alt="">',
    ].join('')

    for (const image of document.querySelectorAll('img')) {
      const side = image.id === 'big' ? 32 : 16

      Object.defineProperty(image, 'naturalWidth', { value: 150 })
      Object.defineProperty(image, 'naturalHeight', { value: 150 })
      Object.defineProperty(image, 'complete', { value: true })
      image.getBoundingClientRect = () => ({ width: side, height: side, top: 5000, bottom: 5000 + side, left: 0, right: side, x: 0, y: 0, toJSON: () => ({}) })
    }

    // Chromium's density at a 120% zoom.
    Object.defineProperty(window, 'devicePixelRatio', { value: 1.2000000476837158, configurable: true })
    const rows = () => [...shadow().querySelectorAll('#kay-dev-images .image')].map(row => `${row.querySelector('.src')!.textContent} | ${[...row.querySelectorAll('.chip')].map(chip => chip.textContent).join(' - ')}`)
    const visible = () => [...shadow().querySelectorAll<HTMLElement>('.outline')].filter(outline => outline.hidden === false).length

    try {
      tool = startDevTool()
      shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-images')!.click()
      await Bun.sleep(20)

      expect(rows()).toEqual([
        '/logo.svg3 copies | not resized by kay - format not looked up - 150x150 drawn 16x16 at 1.2x',
        '/logo.svg | not resized by kay - format not looked up - 150x150 drawn 32x32 at 1.2x',
      ])
      expect(shadow().querySelector('#kay-dev-images .image')!.getAttribute('aria-label')).toBe('/logo.svg, 3 copies')

      shadow().querySelector('#kay-dev-images .image')!.dispatchEvent(new PointerEvent('pointerenter'))
      expect(visible()).toBe(3)
    }
    finally {
      Object.defineProperty(window, 'devicePixelRatio', { value: devicePixelRatio, configurable: true })
      document.body.innerHTML = ''
      happyDOM.setURL(href)
    }
  })

  it('answers an image the server is not asked about at once, even while every request slot is held by one that hangs', async () => {
    const { happyDOM } = window as unknown as { happyDOM: { setURL: (url: string) => void } }
    const { href } = location
    const observed = fakeObserver()

    happyDOM.setURL('http://localhost/')
    document.body.innerHTML = [
      ...Array.from({ length: 4 }, (_, index) => `<img id="hung${index}" src="/_kay/images/hung${index}.webp" width="10" height="10" alt="">`),
      '<img id="far" src="https://cdn.example/a.png" width="10" height="10" alt="">',
      '<img id="plain" src="/photo.jpg" width="10" height="10" alt="">',
      '<img id="broken" src="http://" width="10" height="10" alt="">',
      '<img id="unloaded" src="/_kay/images/unloaded.webp" width="10" height="10" alt="">',
    ].join('')

    for (const image of document.querySelectorAll('img')) {
      const loaded = image.id !== 'unloaded'

      Object.defineProperty(image, 'naturalWidth', { value: loaded ? 10 : 0 })
      Object.defineProperty(image, 'naturalHeight', { value: loaded ? 10 : 0 })
      Object.defineProperty(image, 'complete', { value: loaded })
    }

    const fetching = spyOn(window, 'fetch').mockImplementation((async (_url: string, init: RequestInit) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('timeout'))))) as unknown as typeof window.fetch)

    try {
      tool = startDevTool()
      observed.report('largest-contentful-paint', [])
      shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-images')!.click()
      await Bun.sleep(20)

      const formats = [...shadow().querySelectorAll('#kay-dev-images .image .chips')].map(line => line.textContent)

      expect(fetching).toHaveBeenCalledTimes(4)
      expect(formats.slice(0, 4).every(text => text?.includes('format...'))).toBe(true)
      expect(formats[4]).toContain('on another host')
      expect(formats[5]).toContain('format not looked up')
      expect(formats[6]).toContain('format unknown')
      expect(formats[7]).toContain('not loaded')
    }
    finally {
      fetching.mockRestore()
      delete (window as { PerformanceObserver?: unknown }).PerformanceObserver
      document.body.innerHTML = ''
      happyDOM.setURL(href)
    }
  })

  it('shows LCP, CLS and INP as the page is used each against its limit, and the HTML, CSS and JS gzipped with the island chunks split out, saying they are dev sizes', async () => {
    const { happyDOM } = window as unknown as { happyDOM: { setURL: (url: string) => void } }
    const { href } = location
    const observed = fakeObserver()
    const files: Record<string, string> = {
      '/': `<!doctype html><title>Home</title>${'<p>Hello</p>'.repeat(200)}`,
      '/_kay/_layout-1.css': 'body { margin: 0 }\n'.repeat(100),
      '/_kay/entry-abc12345.js': 'export const run = () => 1\n'.repeat(400),
      '/_kay/counter-def45678.js': 'export const count = () => 2\n'.repeat(50),
      '/_kay/page-swap-aa11bb22.js': 'export const swap = () => 3\n'.repeat(30),
      '/_kay/dev/tool.js': 'the tool itself, left out',
      '/_kay/env.js': 'export default {}\n',
      '/_kay/search-tbghfygg.js': 'export const search = () => 6\n'.repeat(40),
      '/_kay/dev/sizes': JSON.stringify({ sizes: { route: '/', js: 5120, css: 256, estimated: true, exported: false, built: Date.now() - 2 * 3_600_000 } }),
      '/_kay/lib-calendar.js': 'export const calendar = () => 4\n'.repeat(20),
      '/_kay/lib-original.js': 'export const original = () => 5\n'.repeat(25),
      '/_kay/old-1.css': 'a { color: red }\n',
    }
    // What the browser loaded over the page's life: the island rebuilt since, a stylesheet swapped with a query, and one the page no longer links.
    const loaded = ['/_kay/_layout-1.css', '/_kay/_layout-1.css?kay-dev=2', '/_kay/entry-abc12345.js', '/_kay/counter-00000000.js', '/_kay/counter-def45678.js', '/_kay/page-swap-aa11bb22.js', '/_kay/search-tbghfygg.js', '/_kay/lib-calendar.js', '/_kay/lib-original.js', '/_kay/dev/tool.js', '/_kay/env.js', '/_kay/old-1.css']
    const fetched: string[] = []

    happyDOM.setURL('http://localhost/')
    // The stylesheet is only linked: the test reads its address, the browser's own load is not part of it.
    const { settings } = (window as unknown as { happyDOM: { settings: { disableCSSFileLoading: boolean, handleDisabledFileLoadingAsSuccess: boolean } } }).happyDOM

    Object.assign(settings, { disableCSSFileLoading: true, handleDisabledFileLoadingAsSuccess: true })
    document.head.insertAdjacentHTML('beforeend', '<link rel="stylesheet" href="/_kay/_layout-1.css?kay-dev=2">')
    document.body.innerHTML = '<slot data-component="src/components/counter.kay"></slot><slot data-component="src/components/search.kay"></slot>'

    const performance = spyOn(window.performance, 'getEntriesByType').mockImplementation(((type: string) => type === 'resource' ? loaded.map(path => ({ name: `http://localhost${path}` })) : []) as unknown as typeof window.performance.getEntriesByType)
    const fetching = spyOn(window, 'fetch').mockImplementation((async (url: string) => {
      fetched.push(new URL(url, 'http://localhost').pathname)

      return new Response(files[new URL(url, 'http://localhost').pathname])
    }) as unknown as typeof window.fetch)
    const vitalTiles = () => [...shadow().querySelectorAll('#kay-dev-performance .vital')].map(tile => `${tile.querySelector('.name')!.textContent}: ${tile.querySelector('.num')!.textContent} ${tile.querySelector('.pill')?.textContent ?? ''}`.trim())
    const weights = () => [...shadow().querySelectorAll('#kay-dev-performance .weight > .v')].map(value => value.textContent)
    const size = (...texts: string[]) => {
      const bytes = texts.reduce((sum, text) => sum + Bun.gzipSync(text).length, 0)

      return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
    }

    try {
      tool = startDevTool()
      observed.report('largest-contentful-paint', [{ startTime: 3000, renderTime: 3000, element: null }])
      observed.report('layout-shift', [{ startTime: 100, value: 0.04, hadRecentInput: false }, { startTime: 400, value: 0.08, hadRecentInput: false }, { startTime: 450, value: 0.5, hadRecentInput: true }, { startTime: 9000, value: 0.01, hadRecentInput: false }])
      shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-performance')!.click()
      await Bun.sleep(30)

      expect(vitalTiles()).toEqual(['LCP: 3000ms needs work', 'CLS: 0.120 needs work', 'INP: no interaction yet'])
      expect(shadow().querySelector('#kay-dev-performance .vital .tick')?.textContent).toBe('2.5 s')

      // Interactions: the slowest of each, the worst taken; a later report moves the open tab.
      observed.report('event', [{ interactionId: 1, duration: 80 }, { interactionId: 1, duration: 120 }, { interactionId: 2, duration: 240 }, { duration: 900 }, { interactionId: 3, duration: 800, target: shadow().host }])

      expect(vitalTiles()[2]).toBe('INP: 240ms needs work')
      expect(shadow().querySelector('#kay-dev-tab-performance .count')?.textContent).toBe('3')

      // The HTML is sized from the document the browser holds, not fetched again; two unhashed files whose names end in 8 letters stay two, and an island hashed in letters only is still one.
      expect(fetched.sort()).toEqual(['/_kay/_layout-1.css', '/_kay/counter-def45678.js', '/_kay/dev/sizes', '/_kay/entry-abc12345.js', '/_kay/lib-calendar.js', '/_kay/lib-original.js', '/_kay/page-swap-aa11bb22.js', '/_kay/search-tbghfygg.js'])
      expect(weights().slice(1, -1)).toEqual([
        size(files['/_kay/_layout-1.css']!),
        size(files['/_kay/entry-abc12345.js']!),
        size(files['/_kay/counter-def45678.js']!, files['/_kay/search-tbghfygg.js']!),
        size(files['/_kay/page-swap-aa11bb22.js']!, files['/_kay/lib-calendar.js']!, files['/_kay/lib-original.js']!),
      ])
      expect(weights()[0]).toMatch(/^\d+(\.\d)? (B|KB)$/)
      expect(weights().at(-1)).toMatch(/^\d+(\.\d)? (B|KB)$/)
      expect(shadow().querySelector('#kay-dev-performance')!.textContent).toContain('Dev sizes: not minified')

      // The last build's sizes for the route, with their age, the estimate marked.
      const built = shadow().querySelector('#kay-dev-performance .build')!.textContent
      const text = shadow().querySelector('#kay-dev-performance')!.textContent

      expect(built).toContain('JS ~5.0 KB')
      expect(built).toContain('CSS 256 B')
      expect(text).toContain('Last kay build, 2 h ago')
      expect(text).toContain('Route /, server build')
      expect(text).toContain('~ marks an estimate')
      expect(shadow().querySelector('#kay-dev-performance')!.textContent).toContain('Measured on the load of /.')

      // A link swaps in another page without a load: the vitals say which load they belong to.
      happyDOM.setURL('http://localhost/next')
      document.head.insertAdjacentHTML('beforeend', '<meta name="swapped">')
      await Bun.sleep(30)

      expect(shadow().querySelector('#kay-dev-performance')!.textContent).toContain('Measured on the load of /, not on this page')
    }
    finally {
      fetching.mockRestore()
      performance.mockRestore()
      delete (window as { PerformanceObserver?: unknown }).PerformanceObserver
      document.body.innerHTML = ''
      document.head.querySelector('link[rel=stylesheet]')?.remove()
      document.head.querySelector('meta[name=swapped]')?.remove()
      happyDOM.setURL(href)
    }
  })
})
