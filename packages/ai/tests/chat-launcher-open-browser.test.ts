import { join } from 'node:path'
import { afterAll, afterEach, expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { fakeAi } from '../src'

const site = await testSite({ root: join(import.meta.dir, 'fixture'), browser: true })

afterAll(async () => site.close())
afterEach(() => fakeAi.clear())

const shut = () => document.querySelector('.kai-launcher-panel')!.hasAttribute('hidden')

it('opens on the address fragment at load, as the visitor does', async () => {
  await using page = await site.open('/linking#chat')

  await page.waitFor('.kai-launcher-panel:not([hidden])')
  expect(await page.text('.changes')).toBe('true')
  expect(page.errors).toEqual([])
}, 120_000)

it('opens when the fragment changes to it, once, and stays shut on another one', async () => {
  await using page = await site.open('/linking')

  expect(await page.evaluate(shut)).toBe(true)
  await page.evaluate(() => {
    location.hash = '#other'
  })
  expect(await page.evaluate(shut)).toBe(true)
  await page.click('.link')
  await page.waitFor('.kai-launcher-panel:not([hidden])')
  expect(await page.text('.changes')).toBe('true')
  expect(page.errors).toEqual([])
}, 120_000)

it('opens on a kai-chat-open event on the window', async () => {
  await using page = await site.open('/linking')

  await page.click('.event')
  await page.waitFor('.kai-launcher-panel:not([hidden])')
  expect(await page.text('.changes')).toBe('true')
  expect(page.errors).toEqual([])
}, 120_000)

it('opens the panel, then drafts a question sent before the chat was loaded', async () => {
  await using page = await site.open('/linking')

  await page.click('.draft')
  await page.waitFor('.kai-launcher-panel:not([hidden])')
  await page.waitUntil(() => document.querySelector<HTMLTextAreaElement>('.kai-chat-form textarea')?.value === 'Drafted from outside', { what: 'the draft' })
  expect(page.errors).toEqual([])
}, 120_000)

it('opens the panel, then sends a question sent before the chat was loaded', async () => {
  await using page = await site.open('/linking')

  fakeAi.reply('Hello back')
  await page.click('.send')
  await page.waitFor('.kai-launcher-panel:not([hidden])')
  await page.waitFor('.kai-chat-turn[data-role=user]', { text: 'Sent from outside' })
  await page.waitFor('.kai-chat-turn[data-role=assistant]', { text: 'Hello back' })
  expect(page.errors).toEqual([])
}, 120_000)
