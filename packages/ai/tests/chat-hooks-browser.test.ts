import { join } from 'node:path'
import { afterAll, afterEach, expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { fakeAi } from '../src'
import { replied } from './fixture/tests/replied'

const site = await testSite({ root: join(import.meta.dir, 'fixture'), browser: true })

afterAll(async () => site.close())
afterEach(() => fakeAi.clear())

it('calls the app\'s callbacks as a suggestion is pressed, the message goes out and the reply ends, and fills suggestions from a promise', async () => {
  await using page = await site.open('/hearing')

  fakeAi.reply('Hello back')
  await page.waitFor('.kai-chat-suggestion')
  await page.click('.kai-chat-suggestion')
  await page.waitFor('.kai-chat-turn[data-role=assistant]')
  await replied(page)
  await page.waitFor('.heard', { text: 'reply:Hello back' })

  expect(await page.text('.heard')).toBe('suggestion:From a promise;send:From a promise;reply:Hello back')
  expect(page.errors).toEqual([])
}, 120_000)

it('opens and closes a launcher the app controls, and tells the app when the visitor does', async () => {
  await using page = await site.open('/opening')

  expect(await page.evaluate(() => document.querySelector('.kai-launcher-panel')!.hasAttribute('hidden'))).toBe(true)
  await page.click('.ask')
  await page.waitFor('.kai-launcher-panel:not([hidden])')
  // Set by the app, so the app is not told.
  expect(await page.text('.changes')).toBe('')

  await page.click('.kai-launcher-button')
  await page.waitFor('.kai-launcher-panel[hidden]')
  expect(await page.text('.changes')).toBe('false')

  await page.click('.kai-launcher-button')
  await page.waitFor('.kai-launcher-panel:not([hidden])')
  await page.click('.dismiss')
  await page.waitFor('.kai-launcher-panel[hidden]')
  expect(await page.text('.changes')).toBe('false;true')
  expect(page.errors).toEqual([])
}, 120_000)

it('puts a question in the field from outside and keeps what was typed after it', async () => {
  await using page = await site.open('/drafting')

  await page.fill('.kai-chat-form textarea', 'mine')
  await page.evaluate(() => document.querySelector('.kai-chat')!.dispatchEvent(new CustomEvent('kai:chat-draft', { detail: { text: 'About this page' } })))
  await page.waitUntil(() => document.querySelector<HTMLTextAreaElement>('.kai-chat-form textarea')!.value === 'About this page\nmine', { what: 'the draft' })
  expect(page.errors).toEqual([])
}, 120_000)

it('offers the suggestions a function returned at once, drawn by the server', async () => {
  const html = await (await site.fetch('/suggesting')).text()

  expect(html).toContain('Sync one')
  expect(html).toContain('Sync two')
}, 120_000)
