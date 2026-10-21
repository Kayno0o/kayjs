import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { settle } from 'kay/test'
import { CHECK_PATH, HINT_COOKIE, PAGE_LINK_ATTRIBUTE, pageLink } from '../src/page-link'

const ANSWER = { label: 'Edit this page', href: '/admin/page' }
const BUTTON = 'html > a'

function answering(status: number, body: unknown = ANSWER) {
  return spyOn(globalThis, 'fetch').mockImplementation((async () => status === 200 ? Response.json(body) : new Response(null, { status })) as unknown as typeof fetch)
}

async function run(): Promise<void> {
  pageLink(HINT_COOKIE, PAGE_LINK_ATTRIBUTE, CHECK_PATH)
  await settle()
}

// A document with an address, where a cookie is kept.
const PAGE = 'https://site.test/about?lang=fr'

beforeEach(() => {
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(PAGE)
  document.body.innerHTML = '<p>Read</p>'
  document.cookie = `${HINT_COOKIE}=1; path=/`
})

afterEach(() => {
  document.querySelector(BUTTON)?.remove()
  document.cookie = `${HINT_COOKIE}=; path=/; max-age=0`
  mock.restore()
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
