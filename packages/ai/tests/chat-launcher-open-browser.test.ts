import { join } from 'node:path'
import { afterAll, afterEach, expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { fakeAi } from '../src'

const site = await testSite({ root: join(import.meta.dir, 'fixture'), browser: true })

afterAll(async () => site.close())
afterEach(() => fakeAi.clear())

const shut = () => !(document.querySelector('.kai-launcher-panel') as HTMLDialogElement).open

it('opens on the address fragment at load, as the visitor does', async () => {
  await using page = await site.open('/linking#chat')

  await page.waitFor('.kai-launcher-panel[open]')
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
  await page.waitFor('.kai-launcher-panel[open]')
  expect(await page.text('.changes')).toBe('true')
  expect(page.errors).toEqual([])
}, 120_000)

it('opens on kai:chat-open on the document', async () => {
  await using page = await site.open('/linking')

  await page.click('.event')
  await page.waitFor('.kai-launcher-panel[open]')
  expect(await page.text('.changes')).toBe('true')
  expect(page.errors).toEqual([])
}, 120_000)

it('opens the panel, then drafts a question sent before the chat was loaded', async () => {
  await using page = await site.open('/linking')

  await page.click('.draft')
  await page.waitFor('.kai-launcher-panel[open]')
  await page.waitUntil(() => document.querySelector<HTMLTextAreaElement>('.kai-chat-form textarea')?.value === 'Drafted from outside', { what: 'the draft' })
  expect(page.errors).toEqual([])
}, 120_000)

it('opens the panel, then sends a question sent before the chat was loaded', async () => {
  await using page = await site.open('/linking')

  fakeAi.reply('Hello back')
  await page.click('.send')
  await page.waitFor('.kai-launcher-panel[open]')
  await page.waitFor('.kai-chat-turn[data-role=user]', { text: 'Sent from outside' })
  await page.waitFor('.kai-chat-turn[data-role=assistant]', { text: 'Hello back' })
  expect(page.errors).toEqual([])
}, 120_000)

it('stays closed after the visitor closes a panel that a #chat address opened', async () => {
  await using page = await site.open('/linking#chat')

  await page.waitFor('.kai-launcher-panel[open]')
  await page.click('.kai-launcher-button')
  await page.waitFor('.kai-launcher-panel:not([open])')
  await page.evaluate(async () => new Promise(done => setTimeout(done, 200)))
  expect(await page.evaluate(shut)).toBe(true)
  expect(await page.text('.changes')).toBe('true;false')
}, 120_000)

it('opens again on a second click on the link while the address already holds the fragment', async () => {
  await using page = await site.open('/linking#chat')

  await page.waitFor('.kai-launcher-panel[open]')
  await page.click('.kai-launcher-button')
  await page.waitFor('.kai-launcher-panel:not([open])')
  await page.click('.link')
  await page.waitFor('.kai-launcher-panel[open]')
  expect(await page.text('.changes')).toBe('true;false;true')
}, 120_000)

it('fires one change for an event while the panel is open, and none for blank text', async () => {
  await using page = await site.open('/linking')

  await page.click('.event')
  await page.waitFor('.kai-launcher-panel[open]')
  await page.click('.event')
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('kai:chat-draft', { detail: { text: '  ' } })))
  expect(await page.text('.changes')).toBe('true')
}, 120_000)

it('focuses the field on opening, keeps the chat mounted while shut, and returns the focus to the button on Escape', async () => {
  await using page = await site.open('/linking')

  await page.waitUntil(() => (document.querySelector('.kai-launcher')?.closest('[data-component]') as unknown as { _$k?: boolean } | null)?._$k === true)

  const chat = () => document.querySelector('.kai-launcher-panel .kai-chat') !== null
  const state = () => {
    const active = document.activeElement
    let focus = 'other'

    if (active?.tagName === 'TEXTAREA')
      focus = 'field'
    else if (active?.className.includes('kai-launcher-button'))
      focus = 'button'

    return { expanded: document.querySelector('.kai-launcher-button')?.getAttribute('aria-expanded'), focus }
  }

  expect(await page.evaluate(chat)).toBe(true)
  expect(await page.evaluate(state)).toEqual({ expanded: 'false', focus: 'other' })
  await page.click('.kai-launcher-button')
  await page.waitFor('.kai-launcher-panel[open]')
  await page.waitUntil(() => document.activeElement?.tagName === 'TEXTAREA')
  expect(await page.evaluate(state)).toEqual({ expanded: 'true', focus: 'field' })
  await page.press('Escape')
  await page.waitFor('.kai-launcher-panel:not([open])')
  await page.waitUntil(() => document.activeElement?.className.includes('kai-launcher-button') === true && document.activeElement.getAttribute('aria-expanded') === 'false')
  expect(await page.evaluate(state)).toEqual({ expanded: 'false', focus: 'button' })
  expect(await page.evaluate(chat)).toBe(true)
  expect(page.errors).toEqual([])
}, 120_000)
