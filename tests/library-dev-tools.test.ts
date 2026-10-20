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
    expect(shadow().querySelector('#kay-dev-tab-auth svg')).not.toBeNull()
    expect(shadow().querySelector('#kay-dev-tab-auth svg')!.innerHTML).not.toBe(shadow().querySelector('#kay-dev-tab-problems svg')!.innerHTML)
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
    expect(shadow().querySelector('#kay-dev-tab-mail svg')).not.toBeNull()
    expect(shadow().querySelector('#kay-dev-tab-mail svg')!.innerHTML).not.toBe(shadow().querySelector('#kay-dev-tab-problems svg')!.innerHTML)
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

  it('turns the "Send for real" switch on for one typed address and off again, the bar saying so from any tab even with no mail', async () => {
    let state: object = { on: false, missing: [], server: 'localhost:1025', offered: 'me@example.com' }
    const posted: unknown[] = []
    const fetching = spyOn(window, 'fetch').mockImplementation((async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url === '/_kay/mail/delivery') {
        const { to } = JSON.parse(String(init.body)) as { to: string }

        posted.push({ url, to, type: (init.headers as Record<string, string>)['content-type'] })
        state = to === '' ? { on: false, missing: [], server: 'localhost:1025' } : { on: true, to, missing: [], server: 'localhost:1025' }

        return Response.json(state)
      }

      if (url === '/_kay/mail.json')
        return Response.json([])

      return url === '/_kay/mail/delivery' ? Response.json(state) : new Response(null, { status: 404 })
    }) as unknown as typeof window.fetch)
    const badges = () => [...shadow().querySelectorAll('.bar > button:not([hidden]) .pill')].map(badge => `${badge.className} ${badge.textContent}`)

    tool = startDevTool()
    mailDevTool(tool)
    await Bun.sleep(5)
    shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-mail')!.click()
    await Bun.sleep(5)

    const input = () => panel('mail').querySelector<HTMLInputElement>('input[name=to]')!

    expect(input().value).toBe('me@example.com')
    expect(panel('mail').textContent).toContain('delivered to this one address over localhost:1025, never to its own recipients')
    expect(badges()).toEqual([])

    input().value = ' you@example.com '
    panel('mail').querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await Bun.sleep(5)
    expect(posted).toEqual([{ url: '/_kay/mail/delivery', to: 'you@example.com', type: 'application/json' }])
    expect(panel('mail').textContent).toContain('delivered to you@example.com over localhost:1025, never to its own recipients, with no cc or bcc')
    expect(panel('mail').querySelector('input')).toBeNull()

    shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-problems')!.click()
    expect(badges()).toEqual(['pill warn 0 mails, delivered to you@example.com'])

    shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-mail')!.click()
    ;[...panel('mail').querySelectorAll('button')].find(button => button.textContent === 'Turn off')!.click()
    await Bun.sleep(5)
    expect(posted.at(-1)).toMatchObject({ to: '' })
    expect(panel('mail').querySelector('input')).not.toBeNull()
    expect(badges()).toEqual([])
    fetching.mockRestore()
  })

  it('names the SMTP variables the switch lacks, and draws no switch where the route is not there', async () => {
    let answer: () => Response = () => Response.json({ on: false, missing: ['SMTP_HOST', 'SMTP_FROM'] })
    const fetching = answering({
      'GET /_kay/mail.json': () => Response.json([]),
      'GET /_kay/mail/delivery': () => answer(),
    })

    tool = startDevTool()
    mailDevTool(tool)
    await Bun.sleep(5)
    shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-mail')!.click()
    await Bun.sleep(5)
    expect(panel('mail').textContent).toContain('Set SMTP_HOST and SMTP_FROM to deliver mails over SMTP')
    expect(panel('mail').querySelector('input')).toBeNull()

    answer = () => new Response(null, { status: 404 })
    tool.stop()
    tool = startDevTool()
    mailDevTool(tool)
    await Bun.sleep(5)
    shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-mail')!.click()
    await Bun.sleep(5)
    expect(panel('mail').textContent).not.toContain('Send for real')
    expect(panel('mail').textContent).toContain('No mail has been sent')
    fetching.mockRestore()
  })

  it('says why the server refused the switch, and keeps the form', async () => {
    const fetching = spyOn(window, 'fetch').mockImplementation((async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url === '/_kay/mail/delivery')
        return new Response('Refused: type one address to deliver to', { status: 400 })

      if (url === '/_kay/mail.json')
        return Response.json([])

      return url === '/_kay/mail/delivery' ? Response.json({ on: false, missing: [], server: 'localhost:1025' }) : new Response(null, { status: 404 })
    }) as unknown as typeof window.fetch)

    tool = startDevTool()
    mailDevTool(tool)
    await Bun.sleep(5)
    shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-mail')!.click()
    await Bun.sleep(5)
    panel('mail').querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await Bun.sleep(5)
    expect(panel('mail').textContent).toContain('type one address to deliver to')
    expect(panel('mail').querySelector('input')).not.toBeNull()
    fetching.mockRestore()
  })

  it('lists the app\'s mail templates, each opening its sample, and notes a mail delivered for real or not', async () => {
    const mails = [
      { id: 'a', sentAt: '2026-10-16T10:00:00Z', to: ['ada@example.com'], subject: 'Sent', text: 'Hi', relayed: { to: 'me@example.com' } },
      { id: 'b', sentAt: '2026-10-16T10:05:00Z', to: ['bob@example.com'], subject: 'Failed', text: 'Hi', relayed: { to: 'me@example.com', error: 'connect ECONNREFUSED' } },
    ]
    const fetching = answering({
      'GET /_kay/mail.json': () => Response.json(mails),
      'GET /_kay/mail/samples.json': () => Response.json(['welcome.kay', 'auth/reset password.kay']),
    })

    tool = startDevTool()
    mailDevTool(tool)
    await Bun.sleep(5)
    shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-mail')!.click()
    await Bun.sleep(5)

    const links = [...panel('mail').querySelectorAll<HTMLAnchorElement>('a.link')].filter(link => link.getAttribute('href')!.startsWith('/_kay/mail/samples'))

    expect(links.map(link => [link.textContent, link.getAttribute('href'), link.target])).toEqual([
      ['welcome.kay', '/_kay/mail/samples?mail=welcome.kay', '_blank'],
      ['auth/reset password.kay', '/_kay/mail/samples?mail=auth%2Freset%20password.kay', '_blank'],
    ])
    expect(panel('mail').textContent).toContain('Templates')
    expect(panel('mail').textContent).toContain('Delivered to me@example.com')
    expect(panel('mail').textContent).toContain('Not delivered to me@example.com: connect ECONNREFUSED')
    fetching.mockRestore()
  })

  it('shows why a failed post of the switch failed even when the tab lost its state meanwhile', async () => {
    let reading = true
    const answer = Promise.withResolvers<Response>()
    const fetching = spyOn(window, 'fetch').mockImplementation((async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url === '/_kay/mail/delivery')
        return answer.promise

      if (url === '/_kay/mail.json')
        return Response.json([])

      if (url === '/_kay/mail/delivery')
        return reading ? Response.json({ on: false, missing: [], server: 'localhost:1025' }) : new Response(null, { status: 500 })

      return new Response(null, { status: 404 })
    }) as unknown as typeof window.fetch)

    tool = startDevTool()
    mailDevTool(tool)
    await Bun.sleep(5)
    shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-mail')!.click()
    await Bun.sleep(5)

    const turnOn = panel('mail').querySelector<HTMLButtonElement>('form button')!

    panel('mail').querySelector<HTMLInputElement>('input[name=to]')!.value = 'you@example.com'
    panel('mail').querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await Bun.sleep(5)
    expect(turnOn.disabled).toBe(true)

    // The tab shown again while the post is out, its read of the switch failing.
    reading = false
    shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-problems')!.click()
    shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-mail')!.click()
    await Bun.sleep(5)
    answer.resolve(new Response('Refused: the relay is down', { status: 502 }))
    await Bun.sleep(5)
    expect(turnOn.disabled).toBe(false)
    expect(panel('mail').textContent).toContain('Send for real')
    expect(panel('mail').textContent).toContain('the relay is down')
    fetching.mockRestore()
  })

  it('clears the outbox from a Clear button, the list and the count going, and says why when it is refused', async () => {
    let mails: object[] = [{ id: 'a', sentAt: '2026-10-16T10:00:00Z', to: ['ada@example.com'], subject: 'Welcome', text: 'Hi' }]
    let refuse = true
    const posted: string[] = []
    const fetching = spyOn(window, 'fetch').mockImplementation((async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url === '/_kay/mail/clear') {
        posted.push(init.method)

        if (refuse)
          return new Response('Refused: the outbox is cleared from its own page', { status: 403 })

        mails = []

        return new Response(null, { status: 204 })
      }

      return url === '/_kay/mail.json' ? Response.json(mails) : new Response(null, { status: 404 })
    }) as unknown as typeof window.fetch)
    const clear = () => [...panel('mail').querySelectorAll('button')].find(button => button.textContent === 'Clear')!

    tool = startDevTool()
    mailDevTool(tool)
    await Bun.sleep(5)
    shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-mail')!.click()
    await Bun.sleep(5)
    expect(panel('mail').querySelectorAll('.row')).toHaveLength(1)

    clear().click()
    await Bun.sleep(5)
    expect(panel('mail').textContent).toContain('the outbox is cleared from its own page')
    expect(panel('mail').querySelectorAll('.row')).toHaveLength(1)
    expect(clear().disabled).toBe(false)

    refuse = false
    clear().click()
    await Bun.sleep(5)
    expect(posted).toEqual(['POST', 'POST'])
    expect(panel('mail').querySelectorAll('.row')).toHaveLength(0)
    expect(panel('mail').textContent).toContain('No mail has been sent')
    expect([...shadow().querySelectorAll('.bar > button:not([hidden]) .pill')]).toHaveLength(0)
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
    expect(shadow().querySelector('#kay-dev-tab-cms svg')).not.toBeNull()
    expect(shadow().querySelector('#kay-dev-tab-cms svg')!.innerHTML).not.toBe(shadow().querySelector('#kay-dev-tab-problems svg')!.innerHTML)
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
