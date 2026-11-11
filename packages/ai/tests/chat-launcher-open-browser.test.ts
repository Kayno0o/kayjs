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

it('opens on kai:chat-open on the document', async () => {
  await using page = await site.open('/linking')

  await page.click('.event-new')
  await page.waitFor('.kai-launcher-panel:not([hidden])')
  expect(await page.text('.changes')).toBe('true')
  expect(page.errors).toEqual([])
}, 120_000)

it('drafts and sends the text of kai:chat-draft and kai:chat-send on the document', async () => {
  await using page = await site.open('/linking')

  await page.click('.draft-new')
  await page.waitFor('.kai-launcher-panel:not([hidden])')
  await page.waitUntil(() => document.querySelector<HTMLTextAreaElement>('.kai-chat-form textarea')?.value === 'Drafted with the new name', { what: 'the draft' })
  fakeAi.reply('Hello back')
  await page.click('.send-new')
  await page.waitFor('.kai-chat-turn[data-role=user]', { text: 'Sent with the new name' })
  expect(page.errors).toEqual([])
}, 120_000)

it('opens on a kai-chat-open event on the window, the old name', async () => {
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

it('stays closed after the visitor closes a panel that a #chat address opened', async () => {
  await using page = await site.open('/linking#chat')

  await page.waitFor('.kai-launcher-panel:not([hidden])')
  await page.click('.kai-launcher-button')
  await page.waitFor('.kai-launcher-panel[hidden]')
  await page.evaluate(async () => new Promise(done => setTimeout(done, 200)))
  expect(await page.evaluate(shut)).toBe(true)
  expect(await page.text('.changes')).toBe('true;false')
}, 120_000)

it('opens again on a second click on the link while the address already holds the fragment', async () => {
  await using page = await site.open('/linking#chat')

  await page.waitFor('.kai-launcher-panel:not([hidden])')
  await page.click('.kai-launcher-button')
  await page.waitFor('.kai-launcher-panel[hidden]')
  await page.click('.link')
  await page.waitFor('.kai-launcher-panel:not([hidden])')
  expect(await page.text('.changes')).toBe('true;false;true')
}, 120_000)

it('fires one change for an event while the panel is open, and none for blank text', async () => {
  await using page = await site.open('/linking')

  await page.click('.event')
  await page.waitFor('.kai-launcher-panel:not([hidden])')
  await page.click('.event')
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('kai-chat-draft', { detail: '  ' })))
  expect(await page.text('.changes')).toBe('true')
}, 120_000)
