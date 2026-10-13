import type { DevTool } from '../src/runtime/dev-tool'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { startDevTool } from '../src/runtime/dev-tool'
import { DEV_BOOT, problemsBlock } from '../src/server/dev'

const BOOT = (/<script>([\s\S]*)<\/script>/).exec(DEV_BOOT)![1]!

beforeAll(() => GlobalRegistrator.register())
afterAll(async () => GlobalRegistrator.unregister())

describe('the dev tool', () => {
  const { error, warn } = console
  let tool: DevTool | undefined

  const shadow = () => document.querySelector('kay-dev')!.shadowRoot!
  const problems = () => [...shadow().querySelectorAll('pre.problem')].map(problem => [problem.classList.contains('error') ? 'error' : 'warn', problem.textContent])
  const bar = () => [...shadow().querySelectorAll('.bar > button')].filter(button => (button as HTMLElement).hidden === false).map(button => button.textContent)
  const drawer = () => shadow().querySelector<HTMLElement>('[role=dialog]')!
  const boot = () => {
    // eslint-disable-next-line no-new-func -- runs the inline script a dev page carries
    (new Function(BOOT) as () => void)()
  }
  const key = (init: KeyboardEventInit, target: EventTarget = document.body) => target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, composed: true, ...init }))

  afterEach(() => {
    tool?.stop()
    tool = undefined
    Object.assign(console, { error, warn })
    delete (window as { $kayProblems?: unknown }).$kayProblems
    sessionStorage.clear()
    document.head.innerHTML = ''
    document.documentElement.removeAttribute('aria-busy')
  })

  it('lists what kay check found and what kay logged before and after it loaded, each once, errors told from warnings', async () => {
    const check = 'error[missing-alt]: An `img` needs `alt`\n1 | img(src="/</script>")'

    document.head.innerHTML = problemsBlock([check])
    console.error = () => undefined
    console.warn = () => undefined
    boot()
    console.error('[kay] island a.kay did not match its server markup')
    console.warn('not kay')
    tool = startDevTool()
    console.warn('[kay] the persisted signal note could not be kept')
    console.warn('[kay] the persisted signal note could not be kept')
    await Bun.sleep(0)

    expect(problems()).toEqual([['error', check], ['error', 'island a.kay did not match its server markup'], ['warn', 'the persisted signal note could not be kept']])
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
    console.warn = () => undefined
    boot()
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
    expect(problems()).toEqual([['warn', 'warning[missing-alt]: an img needs alt'], ['warn', 'on this page']])

    document.documentElement.setAttribute('aria-busy', 'true')
    await Bun.sleep(0)
    expect(problems()).toEqual([['warn', 'warning[missing-alt]: an img needs alt']])

    document.head.innerHTML = problemsBlock(['error[unread-prop]: a prop nothing reads'])
    document.documentElement.removeAttribute('aria-busy')
    await Bun.sleep(0)
    expect(problems()).toEqual([['error', 'error[unread-prop]: a prop nothing reads']])
  })
})
