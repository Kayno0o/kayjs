import { join } from 'node:path'
import { afterAll, afterEach, expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { fakeAi } from '../src'
import { replied } from './fixture/tests/replied'

const site = await testSite({ root: join(import.meta.dir, 'fixture'), browser: true })

afterAll(async () => site.close())
afterEach(() => fakeAi.clear())

type Page = Awaited<ReturnType<typeof site.open>>

async function ask(page: Page, text: string) {
  await page.fill('.kai-chat-form textarea', text)
  await page.click('.kai-chat-form .kai-chat-send')
  await page.waitFor('.kai-chat-turn[data-role=assistant]')
  await replied(page)
}

const texts = async (page: Page, selector: string) => page.evaluate((query: string) => [...document.querySelectorAll(query)].map(element => element.textContent?.trim()), selector)

it('draws a turn with the app\'s block, keeping the log, the turn\'s element, the status line and the regenerate button', async () => {
  await using page = await site.open('/blocked-turn')

  fakeAi.reply({ text: 'Checking', calls: [{ name: 'home_state' }] })
  fakeAi.reply('Done')
  await ask(page, 'how is the home')
  await page.waitFor('.card[data-calls="1"]')

  expect(await texts(page, '.kai-chat-turn .card')).toEqual(['user: how is the home', 'assistant: Checking\n\nDone'])
  expect(await page.evaluate(() => [...document.querySelectorAll('.kai-chat-turn')].map(turn => `${turn.getAttribute('data-role')}|${turn.querySelector('.card')?.getAttribute('data-index')}`))).toEqual(['user|0', 'assistant|1'])
  expect(await page.count('.kai-chat-text')).toBe(0)
  expect(await page.count('.card[data-pending]')).toBe(0)
  expect(await page.count('.kai-chat-log[role=log]')).toBe(1)
  expect(await page.count('.kai-chat-status[role=status]')).toBe(1)
  expect(await page.count('button[aria-label="Regenerate the reply"]')).toBe(1)
  expect(page.errors).toEqual([])
}, 120_000)

it('adds the app\'s buttons to a finished turn after the chat\'s own, and a footer under the form', async () => {
  await using page = await site.open('/blocked-actions')

  fakeAi.reply('Hello back')
  await ask(page, 'hello')

  expect(await page.count('.kai-chat-turn .like')).toBe(2)
  expect(await page.count('button[aria-label="Regenerate the reply"]')).toBe(1)
  expect(await page.evaluate(() => [...document.querySelectorAll('.kai-chat-turn[data-role=assistant] .kai-chat-actions button')].map(button => button.textContent?.trim() || button.getAttribute('aria-label')))).toEqual(['Regenerate the reply', 'Like'])
  expect(await page.evaluate(() => document.querySelector('.kai-chat-form + .footer')?.textContent)).toBe('Liked 0')

  await page.click('.kai-chat-turn[data-role=assistant] .like')
  await page.waitFor('.footer', { text: 'Liked 1' })
  expect(await page.count('.kai-chat-turn .kai-chat-text')).toBe(2)
  expect(page.errors).toEqual([])
}, 120_000)

it('draws a tool call and a cited source with the app\'s blocks, the reply\'s text staying the chat\'s', async () => {
  await using page = await site.open('/blocked-call')

  fakeAi.reply({ text: 'Checking', calls: [{ name: 'home_state' }] })
  fakeAi.reply('The tide [1] and moon [2]')
  await ask(page, 'how is the home')
  await page.waitFor('.order[data-status=done]')

  expect(await texts(page, '.order')).toEqual(['home_state gave lit'])
  expect(await texts(page, '.pill')).toEqual(['1=Tides', '2=Moon'])
  expect(await page.count('.kai-chat-calls-summary')).toBe(0)
  expect(await page.count('.kai-chat-source-link')).toBe(0)
  expect(await page.count('.kai-chat-sources')).toBe(1)
  expect(await page.evaluate(() => document.querySelector('.kai-chat-turn[data-role=assistant] .kai-chat-text')?.textContent?.trim())).toContain('The tide')
  expect(page.errors).toEqual([])
}, 120_000)

it('draws the empty chat with the app\'s block, whose send posts a message, and the log takes over', async () => {
  await using page = await site.open('/blocked-empty')

  expect(await page.count('.welcome')).toBe(1)
  expect(await page.count('.kai-chat-greeting')).toBe(0)

  fakeAi.reply('Hi!')
  await page.click('.hello')
  await page.waitFor('.kai-chat-turn[data-role=assistant] .kai-chat-text', { text: 'Hi!' })

  expect(await texts(page, '.kai-chat-turn[data-role=user] .kai-chat-text')).toEqual(['Hello there'])
  expect(await page.count('.welcome')).toBe(0)
  expect(page.errors).toEqual([])
}, 120_000)

it('forwards the turn, empty and footer blocks through the launcher', async () => {
  await using page = await site.open('/blocked-launcher')

  await page.click('.kai-launcher-button')
  await page.waitFor('.kai-launcher-body .hello')

  expect(await page.count('.kai-launcher-body .kai-chat-greeting')).toBe(0)
  expect(await texts(page, '.kai-launcher-body .footer')).toEqual(['Footer text'])

  fakeAi.reply('Done')
  await page.click('.hello')
  await page.waitFor('.kai-launcher-body .card', { text: 'assistant: Done' })

  expect(await texts(page, '.kai-launcher-body .card')).toEqual(['user: Hello there', 'assistant: Done'])
  expect(page.errors).toEqual([])
}, 120_000)

it('forwards the call, source and actions blocks through the launcher', async () => {
  await using page = await site.open('/blocked-launcher-call')

  await page.click('.kai-launcher-button')
  await page.waitFor('.kai-launcher-body .kai-chat-form textarea')

  fakeAi.reply({ text: 'Checking', calls: [{ name: 'home_state' }] })
  fakeAi.reply('The tide [1]')
  await ask(page, 'how is the home')
  await page.waitFor('.kai-launcher-body .order')

  expect(await texts(page, '.kai-launcher-body .order')).toEqual(['home_state gave lit'])
  expect(await texts(page, '.kai-launcher-body .pill')).toEqual(['1=Tides'])
  expect(await page.count('.kai-launcher-body .kai-chat-turn .like')).toBe(2)
  expect(page.errors).toEqual([])
}, 120_000)

it('hands a turn block the pending turn as it grows, and keeps the Allow button and the edit button of the chat, the approval ticket never shown', async () => {
  await using page = await site.open('/blocked-approval')

  await page.initScript(() => {
    const seen = new Set<string>()

    Object.assign(window, { seen })
    new MutationObserver(() => {
      const pending = document.querySelector('.card[data-pending]')

      if (pending)
        seen.add(pending.getAttribute('data-index')!)
    }).observe(document, { subtree: true, childList: true, attributes: true })
  })
  await page.reload()
  fakeAi.reply({ calls: [{ name: 'add_note', input: { title: 'Milk' } }] })
  fakeAi.reply('May I add it?')
  await page.fill('.kai-chat-form textarea', 'Add milk')
  await page.click('.kai-chat-form .kai-chat-send')
  await page.waitFor('.kai-chat-approval')
  await page.waitFor('.kai-chat-turn[data-pending]', { gone: true })

  expect([...await page.evaluate(() => [...(window as unknown as { seen: Set<string> }).seen])]).toContain('1')
  expect(await page.count('.kai-chat-approval button')).toBe(2)
  expect(await page.count('.kai-chat-turn[data-role=user] button[aria-label^="Edit the message"]')).toBe(1)

  fakeAi.reply({ calls: [{ name: 'add_note', input: { title: 'Milk' } }] })
  fakeAi.reply('Added')
  await page.click('.kai-chat-approval button:first-of-type')
  await page.waitFor('.card', { text: 'assistant: Added' })
  await page.waitFor('.kai-chat-turn[data-pending]', { gone: true })

  expect((await texts(page, '.card')).some(text => text?.includes('kai-approved'))).toBe(false)
  expect(page.errors).toEqual([])
}, 120_000)
