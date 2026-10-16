import type { DevTool } from '../src/runtime/dev-tool'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import authDevTool from '../packages/auth/src/devTool'
import cmsDevTool from '../packages/cms/src/devTool'
import mailDevTool from '../packages/mail/src/devTool'
import { startDevTool } from '../src/runtime/dev-tool'

// The Auth, Mail and CMS tabs the libraries ship as browser modules, run on the real dev tool with the library's dev routes answered by a stub.
class Stream {
  static open = 0
  onmessage: (() => void) | null = null

  constructor() {
    Stream.open++
  }

  close(): void {
    Stream.open--
  }
}

beforeAll(() => {
  GlobalRegistrator.register()
  // happy-dom has no event streams.
  Object.assign(globalThis, { EventSource: Stream })
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

describe('the libraries\' dev tool tabs', () => {
  let tool: DevTool | undefined

  const shadow = () => document.querySelector('kay-dev')!.shadowRoot!
  const panel = (id: string) => shadow().querySelector<HTMLElement>(`#kay-dev-${id}`)!
  const answering = (routes: Record<string, () => Response>) => spyOn(window, 'fetch').mockImplementation((async (url: string, init?: RequestInit) => routes[`${init?.method ?? 'GET'} ${url}`]?.() ?? new Response(null, { status: 404 })) as unknown as typeof window.fetch)

  afterEach(() => {
    tool?.stop()
    tool = undefined
    sessionStorage.clear()
    document.head.innerHTML = ''
  })

  it('shows the session\'s user with a sign-out under the base, and says when nobody is signed in or the route is not there', async () => {
    const user = { id: 'u1', email: 'ada@example.com', emailVerified: false, username: null, roles: ['admin', 'editor'], hasPassword: true, twoFactor: false, locale: 'fr', guest: false }
    let session: object | undefined = { user: null, via: null, signOut: '/auth/sign-out' }
    const posted: string[] = []
    const fetching = answering({
      'GET /_kay/auth': () => session === undefined ? new Response(null, { status: 404 }) : Response.json(session),
      'POST /shop/auth/sign-out': () => {
        posted.push('out')

        return new Response(null, { status: 200 })
      },
    })

    document.head.innerHTML = '<meta name="kay-base" content="/shop">'
    tool = startDevTool()
    authDevTool(tool)
    shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-auth')!.click()
    await Bun.sleep(0)
    expect(panel('auth').textContent).toContain('Nobody is signed in.')

    session = { user, via: 'session', signOut: '/auth/sign-out' }
    shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-problems')!.click()
    shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-auth')!.click()
    await Bun.sleep(0)
    expect(panel('auth').textContent).toContain('ada@example.com (not verified)')
    expect(panel('auth').textContent).toContain('admin, editor')
    expect(shadow().querySelector('#kay-dev-tab-auth .count')?.textContent).toBe('1')

    panel('auth').querySelector('button')!.click()
    await Bun.sleep(0)
    expect(posted).toEqual(['out'])

    session = undefined
    shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-problems')!.click()
    shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-auth')!.click()
    await Bun.sleep(0)
    expect(panel('auth').textContent).toContain('under `kay dev` alone')
    fetching.mockRestore()
  })

  it('lists the outbox newest first, each mail previewed in a sandboxed frame or as text, with a link to its page', async () => {
    const mails = [
      { id: 'a', sentAt: '2026-10-16T10:00:00Z', to: ['ada@example.com'], subject: 'Welcome', html: '<p>Hi</p>', text: 'Hi' },
      { id: 'b', sentAt: '2026-10-16T10:05:00Z', to: [{ address: 'bob@example.com' }], subject: 'Reset', text: 'Plain body' },
    ]
    const fetching = answering({ 'GET /_kay/mail.json': () => Response.json(mails) })

    tool = startDevTool()
    mailDevTool(tool)
    await Bun.sleep(5)
    shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-mail')!.click()
    await Bun.sleep(0)

    const rows = () => [...panel('mail').querySelectorAll('.row')]

    expect(rows().map(row => row.querySelector('button')!.textContent)).toEqual(['Reset', 'Welcome'])
    expect(rows()[0]!.querySelector('a')!.getAttribute('href')).toBe('/_kay/mail/b')
    expect(rows()[0]!.textContent).toContain('bob@example.com')

    rows()[0]!.querySelector('button')!.click()
    expect(rows()[0]!.querySelector('pre')!.textContent).toBe('Plain body')
    rows()[1]!.querySelector('button')!.click()
    expect(rows()[1]!.querySelector('iframe')!.getAttribute('sandbox')).toBe('')
    expect(rows()[1]!.querySelector('iframe')!.getAttribute('srcdoc')).toBe('<p>Hi</p>')
    fetching.mockRestore()
  })

  it('holds the mail event stream open only while the tab is shown', async () => {
    const fetching = answering({ 'GET /_kay/mail.json': () => Response.json([]) })
    const streams = () => Stream.open

    Stream.open = 0

    tool = startDevTool()
    mailDevTool(tool)
    await Bun.sleep(5)
    expect(streams()).toBe(0)
    shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-mail')!.click()
    expect(streams()).toBe(1)
    shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-problems')!.click()
    expect(streams()).toBe(0)
    fetching.mockRestore()
  })

  it('says the outbox is not there outside kay dev, and none was sent when it is empty', async () => {
    let answer = new Response(null, { status: 404 })
    const fetching = answering({ 'GET /_kay/mail.json': () => answer })

    tool = startDevTool()
    mailDevTool(tool)
    await Bun.sleep(5)
    shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-mail')!.click()
    await Bun.sleep(0)
    expect(panel('mail').textContent).toContain('under `kay dev` alone')

    answer = Response.json([])
    shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-problems')!.click()
    shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-mail')!.click()
    await Bun.sleep(0)
    expect(panel('mail').textContent).toContain('No mail has been sent')
    fetching.mockRestore()
  })

  it('toggles edit mode: into it through the screens for the page shown, out of it by the exit route', async () => {
    let editing = false
    const posted: string[] = []
    const fetching = answering({
      'GET /_kay/cms': () => Response.json({ editing, prefix: '/studio', exit: '/api/cms/preview/exit' }),
      'POST /api/cms/preview/exit': () => {
        posted.push('exit')

        return Response.json({ left: true })
      },
    })

    tool = startDevTool()
    cmsDevTool(tool)
    shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-cms')!.click()
    await Bun.sleep(0)
    expect(panel('cms').textContent).toContain('You are not in edit mode.')
    expect(panel('cms').querySelector('button')!.textContent).toBe('Edit this page')
    expect(panel('cms').querySelector('a')!.getAttribute('href')).toBe('/studio')

    editing = true
    shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-problems')!.click()
    shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-cms')!.click()
    await Bun.sleep(0)
    expect(panel('cms').textContent).toContain('You are in edit mode')

    panel('cms').querySelector('button')!.click()
    await Bun.sleep(0)
    expect(posted).toEqual(['exit'])
    fetching.mockRestore()
  })
})
