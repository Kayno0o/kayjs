import type { Asked } from '../src'
import { join } from 'node:path'
import { afterAll, afterEach, expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { fakeAi } from '../src'
import { testing } from './fixture/src/testing'

const site = await testSite({ root: join(import.meta.dir, 'fixture'), browser: true })

afterAll(async () => site.close())
afterEach(() => fakeAi.clear())

type Page = Awaited<ReturnType<typeof site.open>>

// The reply says how many messages the model read and the last one, so a test sees the server replayed the stored turns.
const counted = (asked: Asked) => `read ${asked.messages.length} after ${String(asked.messages.at(-1)?.content).slice(0, 20)}`

const log = async (page: Page) => page.evaluate(() => [...document.querySelectorAll('.kai-chat-turn')].map(turn => `${turn.getAttribute('data-role')![0]}:${turn.querySelector('.kai-chat-text')?.textContent?.trim() ?? ''}`))
const shown = async (page: Page) => new URL(await page.path(), 'http://site').searchParams.get('conversation')

// The address names the conversation once the param's write lands, which kay spaces 200 ms apart.
async function named(page: Page) {
  await page.waitUntil(() => location.search.includes('conversation='))

  return shown(page)
}

async function send(page: Page, text: string, answer: string) {
  fakeAi.reply(counted)
  await page.fill('.kai-chat-form textarea', text)
  await page.click('.kai-chat-form .kai-chat-send')
  await page.waitFor('.kai-chat-turn[data-role=assistant]:last-of-type .kai-chat-text', { text: answer })
}

it('renders the greeting for a new conversation, and none for one the address names until it is read', async () => {
  expect(await (await site.fetch('/keeping')).text()).toContain('data-part="greeting"')
  expect(await (await site.fetch('/keeping?conversation=conv-00000001')).text()).not.toContain('data-part="greeting"')
})

it('keeps the conversation on the server: the address names it, a reload shows it again, and the model reads the stored turns', async () => {
  await using page = await site.open('/keeping')

  await send(page, 'first question', 'read 1 after first question')

  const id = await named(page)

  expect(id).toMatch(/^[\da-f]{32}$/)

  await page.reload()
  await page.waitFor('.kai-chat-turn[data-role=assistant] .kai-chat-text', { text: 'read 1 after first question' })
  await send(page, 'second', 'read 3 after second')

  expect(await log(page)).toEqual(['u:first question', 'a:read 1 after first question', 'u:second', 'a:read 3 after second'])
  expect(await shown(page)).toBe(id)
  expect(page.errors).toEqual([])
}, 120_000)

it('lists the conversations, follows a link of the list, renames one and deletes another', async () => {
  await using page = await site.open('/keeping')

  await send(page, 'about trains', 'read 1 after about trains')

  const trains = await named(page)

  await page.click('.kai-chat-conversation-new')
  await page.waitUntil(() => document.querySelectorAll('.kai-chat-turn').length === 0)
  await send(page, 'about boats', 'read 1 after about boats')
  await page.waitFor('.kai-chat-conversation[data-current] .kai-chat-conversation-link', { text: 'about boats' })
  expect(await page.a11y('.kai-chat-conversations')).toEqual([])

  await page.click(`.kai-chat-conversation-link[href*="${trains}"]`)
  await page.waitFor('.kai-chat-turn[data-role=user] .kai-chat-text', { text: 'about trains' })
  expect(await shown(page)).toBe(trains)

  await page.click('.kai-chat-conversation[data-current] button[aria-label^="Rename the conversation"]')
  await page.fill('.kai-chat-conversation[data-current] input', 'Trains')
  await page.press('Enter')
  await page.waitFor('.kai-chat-conversation[data-current] .kai-chat-conversation-link', { text: 'Trains' })

  await page.click('.kai-chat-conversation[data-current] button[aria-label^="Delete the conversation"]')
  await page.click('.kai-chat-delete-confirm .kui-btn-danger')
  await page.waitUntil(() => document.querySelectorAll('.kai-chat-turn').length === 0 && !location.search.includes('conversation'))
  expect(await page.count(`.kai-chat-conversation-link[href*="${trains}"]`)).toBe(0)
  // The row and its buttons went, so the focus lands on New conversation rather than the page.
  await page.waitUntil(() => document.activeElement?.classList.contains('kai-chat-conversation-new'))

  await page.reload()
  await page.waitFor('.kai-chat-conversation-link', { text: 'about boats' })
  expect(await page.count(`.kai-chat-conversation-link[href*="${trains}"]`)).toBe(0)
  expect(page.errors).toEqual([])
}, 120_000)

// The launcher's chat is an island of its own, marked `_$k` once hydrated, which reads its conversation then.
async function openLauncher(page: Page) {
  await page.click('.kai-launcher-button')
  await page.waitUntil(() => (document.querySelector('.kai-launcher-body [data-component]') as unknown as { _$k?: boolean } | null)?._$k === true)
  await page.waitFor('.kai-launcher-body .kai-chat-log:not([aria-busy])')
}

const pickConversation = async (page: Page, title: string) => page.evaluate((wanted: string) => [...document.querySelectorAll<HTMLButtonElement>('button.kai-chat-conversation-link')].find(button => button.textContent.trim() === wanted)!.click(), title)

it('the launcher keeps its conversation on the server, named by the browser rather than the address, and lists them in its panel', async () => {
  await using page = await site.open('/held-launcher/one')

  await openLauncher(page)
  await send(page, 'launcher question', 'read 1 after launcher question')
  await page.waitFor('.kai-chat-conversation[data-current] .kai-chat-conversation-link', { text: 'launcher question' })

  expect(await page.evaluate(() => location.search)).toBe('')
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('kai-chat-conversation:')))).toHaveLength(1)

  // A page loaded afresh, not swapped, finds the conversation in the browser.
  await page.goto('/held-launcher/two')
  await openLauncher(page)
  await page.waitFor('.kai-chat-turn[data-role=assistant] .kai-chat-text', { text: 'read 1 after launcher question' })
  await send(page, 'next', 'read 3 after next')

  // The panel leaves no room beside the chat: the list heads it, as wide as the chat.
  expect(await page.evaluate(() => {
    const list = document.querySelector('.kai-launcher-body .kai-chat-conversations')!
    const chat = document.querySelector('.kai-launcher-body .kai-chat')!

    return { place: getComputedStyle(list).position, width: Math.round(list.getBoundingClientRect().width) === Math.round(chat.getBoundingClientRect().width) }
  })).toEqual({ place: 'static', width: true })

  await page.click('button.kai-chat-conversation-new')
  await page.waitUntil(() => document.querySelectorAll('.kai-chat-turn').length === 0)
  await send(page, 'other question', 'read 1 after other question')
  await page.waitFor('.kai-chat-conversation[data-current] .kai-chat-conversation-link', { text: 'other question' })
  await pickConversation(page, 'launcher question')
  await page.waitFor('.kai-chat-turn[data-role=user]:nth-of-type(3) .kai-chat-text', { text: 'next' })

  expect(await page.evaluate(() => document.querySelector('.kai-chat-conversation[data-current] .kai-chat-conversation-link')?.getAttribute('aria-current'))).toBe('true')
  expect(await page.evaluate(() => location.pathname + location.search)).toBe('/held-launcher/two')
  expect(await page.a11y('.kai-launcher')).toEqual([])
  expect(page.errors).toEqual([])
}, 120_000)

it('a reload while a reply that outlives its request runs shows the message it answers, picks the reply back up, and the next send counts it', async () => {
  const gate = Promise.withResolvers<void>()

  testing.provider = {
    name: 'held',
    model: 'm',
    async* stream(request) {
      yield { text: 'Hel' }
      await gate.promise
      yield { text: `lo after ${request.messages.length}` }
      yield { finish: 'stop' }
    },
  }

  try {
    await using page = await site.open('/keeping-staying')
    const said = async (text: string) => page.waitUntil((wanted: string) => document.querySelector('.kai-chat-log')!.textContent.includes(wanted), {}, text)

    await page.waitFor('.kai-chat-log:not([aria-busy])')
    await page.fill('.kai-chat-form textarea', 'long question')
    await page.click('.kai-chat-form .kai-chat-send')
    await said('Hel')
    await named(page)

    await page.reload()
    await page.waitFor('.kai-chat-turn[data-role=user] .kai-chat-text', { text: 'long question' })
    await said('Hel')
    gate.resolve()
    await page.waitFor('.kai-chat-turn[data-role=assistant] .kai-chat-text', { text: 'Hello after 1' })

    testing.provider = undefined
    await send(page, 'next', 'read 3 after next')

    expect(await log(page)).toEqual(['u:long question', 'a:Hello after 1', 'u:next', 'a:read 3 after next'])
    expect(page.errors).toEqual([])
  }
  finally {
    testing.provider = undefined
  }
}, 120_000)

it('a tab left open on an older revision cannot write: its message goes back to the field and the conversation shows as stored', async () => {
  await using first = await site.open('/keeping')

  await send(first, 'shared', 'read 1 after shared')
  await named(first)

  await using second = await site.open(await first.path())

  await second.waitFor('.kai-chat-turn[data-role=assistant] .kai-chat-text', { text: 'read 1 after shared' })
  await send(second, 'from the second tab', 'read 3 after from the second tab')

  await first.fill('.kai-chat-form textarea', 'stale tab')
  await first.click('.kai-chat-form .kai-chat-send')
  await first.waitFor('.kai-chat-turn[data-role=user]:nth-of-type(3) .kai-chat-text', { text: 'from the second tab' })
  await first.waitUntil(() => document.querySelector('.kai-chat')!.textContent.includes('This conversation changed in another tab'))

  expect(await first.value('.kai-chat-form textarea')).toBe('stale tab')
  expect(await log(first)).toEqual(['u:shared', 'a:read 1 after shared', 'u:from the second tab', 'a:read 3 after from the second tab'])
  // The model was asked for the two replies the tabs got, never for the stale one.
  expect(fakeAi.asked).toHaveLength(2)
}, 120_000)
