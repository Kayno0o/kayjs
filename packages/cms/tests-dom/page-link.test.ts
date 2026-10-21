import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { settle } from 'kay/test'
import { CHECK_PATH, HINT_COOKIE, PAGE_LINK_ATTRIBUTE, pageLink, pageLinkLoader, SIGNED_IN_COOKIE } from '../src/page-link'

const ANSWER = { label: 'Edit this page', href: '/admin/page' }
const BUTTON = 'html > a'

function answering(status: number, body: unknown = ANSWER) {
  return spyOn(globalThis, 'fetch').mockImplementation((async () => status === 200 ? Response.json(body) : new Response(null, { status })) as unknown as typeof fetch)
}

async function run(): Promise<void> {
  pageLink(HINT_COOKIE, PAGE_LINK_ATTRIBUTE, CHECK_PATH, SIGNED_IN_COOKIE)
  await settle()
}

// A document with an address, where a cookie is kept.
const PAGE = 'https://site.test/about?lang=fr'

// The files after this one share the document, and their requests to a site.test address would never be answered.
const FIRST = location.href

function goTo(url: string): void {
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(url)
}

beforeEach(() => {
  goTo(PAGE)
  document.body.innerHTML = '<p>Read</p>'
  document.cookie = `${HINT_COOKIE}=1; path=/`
})

afterEach(() => {
  document.querySelector(BUTTON)?.remove()
  document.cookie = `${HINT_COOKIE}=; path=/; max-age=0`
  document.cookie = `${SIGNED_IN_COOKIE}=; path=/; max-age=0`
  sessionStorage.clear()
  mock.restore()
})

afterAll(() => {
  goTo(FIRST)
})

test('shows a link into edit mode on the page the signed-in editor reads, naming that page', async () => {
  const fetched = answering(200)

  await run()

  const link = document.querySelector<HTMLAnchorElement>(BUTTON)

  expect(link?.textContent).toBe('Edit this page')
  expect(link?.getAttribute('href')).toBe(`/admin/page?path=${encodeURIComponent('/about?lang=fr')}`)
  expect(String(fetched.mock.calls[0]![0])).toBe(CHECK_PATH)
})

test('takes the base off a meta into the requests and the link', async () => {
  document.head.insertAdjacentHTML('beforeend', '<meta name="kay-base" content="/site">')

  try {
    const fetched = answering(200)

    await run()

    expect(String(fetched.mock.calls[0]![0])).toBe(`/site${CHECK_PATH}`)
    expect(document.querySelector(BUTTON)?.getAttribute('href')).toStartWith('/site/admin/page?path=')
  }
  finally {
    document.head.querySelector('meta[name=kay-base]')?.remove()
  }
})

test('shows nothing and drops the hint once the session is over, whether the guard denies or redirects', async () => {
  for (const status of [401, 403, 0]) {
    document.cookie = `${HINT_COOKIE}=1; path=/`
    answering(status)

    await run()

    expect(document.querySelector(BUTTON)).toBeNull()
    expect(document.cookie).not.toContain(HINT_COOKIE)
    mock.restore()
  }
})

test('keeps the hint when the server cannot be reached or fails', async () => {
  spyOn(globalThis, 'fetch').mockImplementation((async () => {
    throw new Error('offline')
  }) as unknown as typeof fetch)
  await run()
  expect(document.querySelector(BUTTON)).toBeNull()
  expect(document.cookie).toContain(HINT_COOKIE)
  mock.restore()
  answering(500)
  await run()
  expect(document.cookie).toContain(HINT_COOKIE)
})

test('asks nothing and shows nothing in the admin or in edit mode', async () => {
  for (const marker of ['kcms-admin', 'kcms-editor']) {
    document.body.innerHTML = `<div class="${marker}"></div>`

    const fetched = answering(200)

    await run()

    expect(document.querySelector(BUTTON)).toBeNull()
    expect(fetched).not.toHaveBeenCalled()
    mock.restore()
  }
})

test('fills a link of the app\'s own in place of its button, and keeps it hidden when the session is over', async () => {
  document.body.innerHTML = `<a ${PAGE_LINK_ATTRIBUTE} hidden></a><a ${PAGE_LINK_ATTRIBUTE} hidden>Modifier</a>`
  answering(200)
  await run()

  const [first, second] = document.querySelectorAll<HTMLAnchorElement>(`[${PAGE_LINK_ATTRIBUTE}]`)

  expect(document.querySelector(BUTTON)).toBeNull()
  expect([first!.hidden, first!.textContent, second!.textContent]).toEqual([false, 'Edit this page', 'Modifier'])
  expect(first!.getAttribute('href')).toStartWith('/admin/page?path=')
  mock.restore()
  document.cookie = `${HINT_COOKIE}=1; path=/`
  document.body.innerHTML = `<a ${PAGE_LINK_ATTRIBUTE}></a>`
  answering(403)
  await run()
  expect(document.querySelector<HTMLAnchorElement>(`[${PAGE_LINK_ATTRIBUTE}]`)!.hidden).toBeTrue()
})

test('the loader looks for the hint or kayjs-auth\'s signed-in cookie, and for nothing else', () => {
  expect(SIGNED_IN_COOKIE).toBe('kay_user')

  const cue = new RegExp((/\/([^/=]*=[^/]*)\/\.test\(document\.cookie\)/).exec(pageLinkLoader())![1]!)

  expect([`${HINT_COOKIE}=1`, `a=1; ${SIGNED_IN_COOKIE}=x`, `${SIGNED_IN_COOKIE}=`].map(cookie => cue.test(cookie))).toEqual([true, true, true])
  expect(['', 'session=1', 'kay_users=1'].map(cookie => cue.test(cookie))).toEqual([false, false, false])
})

test('a browser signed in with no hint asks the guard, and shows the link when it lets the user in', async () => {
  document.cookie = `${HINT_COOKIE}=; path=/; max-age=0`
  document.cookie = `${SIGNED_IN_COOKIE}=one; path=/`

  const fetched = answering(200)

  await run()
  expect(fetched).toHaveBeenCalledTimes(1)
  expect(document.querySelector(BUTTON)?.textContent).toBe('Edit this page')
})

test('a sign-in the guard refused is not asked again in the tab, a new sign-in is', async () => {
  document.cookie = `${HINT_COOKIE}=; path=/; max-age=0`
  document.cookie = `${SIGNED_IN_COOKIE}=one; path=/`

  const fetched = answering(403)

  await run()
  await run()
  await run()
  expect(fetched).toHaveBeenCalledTimes(1)
  expect(document.querySelector(BUTTON)).toBeNull()

  document.cookie = `${SIGNED_IN_COOKIE}=two; path=/`
  await run()
  expect(fetched).toHaveBeenCalledTimes(2)
})

test('asks every page when the tab keeps nothing, and a hint without a sign-in cookie is always verified', async () => {
  document.cookie = `${SIGNED_IN_COOKIE}=one; path=/`

  const kept = Object.getOwnPropertyDescriptor(window, 'sessionStorage') ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(window), 'sessionStorage')!

  Object.defineProperty(window, 'sessionStorage', { configurable: true, get: () => {
    throw new Error('blocked')
  } })

  const fetched = answering(403)

  await run()
  await run()
  expect(fetched).toHaveBeenCalledTimes(2)
  Object.defineProperty(window, 'sessionStorage', kept)
  mock.restore()
  document.cookie = `${SIGNED_IN_COOKIE}=; path=/; max-age=0`
  sessionStorage.setItem(`${HINT_COOKIE}-refused`, 'one')
  document.cookie = `${HINT_COOKIE}=1; path=/`

  const hinted = answering(200)

  await run()
  expect(hinted).toHaveBeenCalledTimes(1)
})

test('a refusal kept for the tab does not hold once the hint is back, as the guard let the user in since', async () => {
  document.cookie = `${SIGNED_IN_COOKIE}=one; path=/`
  sessionStorage.setItem(`${HINT_COOKIE}-refused`, 'one')
  document.cookie = `${HINT_COOKIE}=1; path=/`

  const fetched = answering(200)

  await run()
  expect(fetched).toHaveBeenCalledTimes(1)
  expect(document.querySelector(BUTTON)?.textContent).toBe('Edit this page')
})
