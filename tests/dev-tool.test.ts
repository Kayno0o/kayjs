import type { DevTool } from '../src/runtime/dev-tool'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { startDevTool } from '../src/runtime/dev-tool'
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

  it('opens each .kay file a problem names once an opener is set, saying why it could not', async () => {
    const opened: string[] = []

    tool = startDevTool()
    console.error('[kay] island src/components/card.kay did not match, see src/routes/index.kay:4:3.')
    await Bun.sleep(0)

    const positions = () => [...shadow().querySelectorAll<HTMLButtonElement>('.problem button.position')]

    expect(positions().map(position => [position.textContent, position.disabled])).toEqual([['src/components/card.kay', true], ['src/routes/index.kay:4:3', true]])

    tool.setOpener(async (source) => {
      opened.push(source)

      return source.startsWith('src/routes') ? 'no editor found, set KAY_EDITOR' : undefined
    })
    expect(positions().every(position => !position.disabled)).toBe(true)

    positions()[0]!.click()
    positions()[1]!.click()
    await Bun.sleep(0)

    expect(opened).toEqual(['src/components/card.kay:1:1', 'src/routes/index.kay:4:3'])
    expect(problems()[0]![1]).toBe('island src/components/card.kay did not match, see src/routes/index.kay:4:3 (no editor found, set KAY_EDITOR).')
  })
})
