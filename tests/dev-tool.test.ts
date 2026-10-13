import type { DevTool } from '../src/runtime/dev-tool'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { startDevTool } from '../src/runtime/dev-tool'
import { reportError } from '../src/runtime/reactive'
import { DEV_BOOT, problemsBlock } from '../src/server/dev'

const BOOT = (/<script>([\s\S]*)<\/script>/).exec(DEV_BOOT)![1]!

const { error, warn } = console

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
  const groups = () => [...shadow().querySelectorAll<HTMLElement>('.group')].filter(group => group.hidden === false).map(group => group.querySelector('h3')!.textContent)
  const bar = () => [...shadow().querySelectorAll('.bar > button')].filter(button => (button as HTMLElement).hidden === false).map(button => button.textContent)
  const drawer = () => shadow().querySelector<HTMLElement>('[role=dialog]')!
  const key = (init: KeyboardEventInit, target: EventTarget = document.body) => target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, composed: true, ...init }))

  afterEach(() => {
    tool?.stop()
    tool = undefined
    ;(window as { $kayProblems?: unknown }).$kayProblems = []
    sessionStorage.clear()
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
    expect(shadow().querySelector('.problem .note:not([hidden])')?.textContent).toBe('2 times')
    expect(bar()).toEqual(['kay', '3 problems'])
    expect(shadow().querySelector('.bar > button.error')?.textContent).toBe('3 problems')
    expect(shadow().querySelector('[role=status]')?.textContent).toBe('3 problems')
  })

  it('opens on the bar or Alt+Shift+K, moves between tabs by arrow keys, closes on Escape from inside it, and keeps its tab and dock side for the browser tab', async () => {
    tool = startDevTool()
    tool.tab({ id: 'other', label: 'Other' })
    await Bun.sleep(0)

    // Styled by an adopted sheet alone, which a policy without inline styles allows.
    expect(shadow().adoptedStyleSheets).toHaveLength(1)
    expect(shadow().querySelector('style, [style]')).toBeNull()

    expect(drawer().hidden).toBe(true)

    key({ key: 'K', code: 'KeyK', altKey: true, shiftKey: true })
    expect(drawer().hidden).toBe(false)
    expect(shadow().activeElement?.id).toBe('kay-dev-tab-problems')
    expect(shadow().querySelector('.empty')?.textContent).toBe('No problems on this page.')

    key({ key: 'ArrowRight' }, shadow().activeElement!)
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
    ;[...shadow().querySelectorAll<HTMLButtonElement>('.tool')].find(button => button.textContent === 'Dock right')!.click()
    tool.stop()

    tool = startDevTool()
    await Bun.sleep(0)

    expect(drawer().hidden).toBe(false)
    expect(shadow().querySelector('.ui.right')).not.toBeNull()
  })

  it('dismisses the problems shown for the rest of the browser tab, drops what the page logged as a swap starts, and reads what kay check finds again as it ends', async () => {
    document.head.innerHTML = problemsBlock(['warning[missing-title]: a page needs a title'])
    tool = startDevTool()
    console.warn('[kay] first')
    await Bun.sleep(0)

    shadow().querySelector<HTMLButtonElement>('.actions button')!.click()
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
    expect(shadow().querySelector<HTMLElement>('.problem .note')!.hidden).toBe(true)

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

  it('says on the bar what kay dev just rebuilt and how long it took, on the page it reloaded for the time left, never a build long past, then fades', async () => {
    const built = () => shadow().querySelector<HTMLElement>('.bar .built')!
    const announce = (data: object) => window.dispatchEvent(new CustomEvent('kay-dev-built', { detail: JSON.stringify(data) }))

    tool = startDevTool()
    expect(built().getAttribute('role')).toBe('status')
    expect(built().textContent).toBe('')

    // The first build the page hears of, as the next.
    announce({ id: 'a', at: Date.now(), changed: 'src/routes/index.kay', ms: 58 })
    expect(built().textContent).toBe('src/routes/index.kay: restarted in 58 ms')
    announce({ id: 'b', at: Date.now(), changed: 'src/app.css', ms: 24, styles: true })
    expect(built().textContent).toBe('src/app.css: stylesheets swapped in 24 ms')
    expect(document.activeElement).toBe(document.body)

    // A page opened long after a build says nothing of it.
    tool.stop()
    Object.assign(window, { $kayBuilt: JSON.stringify({ id: 'c', at: Date.now() - 60_000, changed: 'src/old.ts', ms: 9 }) })
    tool = startDevTool()
    expect(built().textContent).toBe('')

    // The page a build reloaded, whose live reload script heard of it first, says it for the time left.
    tool.stop()
    Object.assign(window, { $kayBuilt: JSON.stringify({ id: 'd', at: Date.now() - 3800, changed: 'src/name.ts', ms: 412 }) })
    tool = startDevTool()
    expect(built().textContent).toBe('src/name.ts: restarted in 412 ms')
    expect(built().classList.contains('fading')).toBe(false)

    await Bun.sleep(300)
    expect(built().classList.contains('fading')).toBe(true)
    await Bun.sleep(500)
    expect(built().textContent).toBe('')
    delete (window as { $kayBuilt?: string }).$kayBuilt
  })
})
