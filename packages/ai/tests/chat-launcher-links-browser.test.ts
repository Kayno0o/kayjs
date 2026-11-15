import { join } from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { replied } from './fixture/tests/replied'

const site = await testSite({ root: join(import.meta.dir, 'fixture'), browser: true })

afterAll(async () => site.close())

// Every link of the assistant's turn and of its list of sources, by its text and where it opens. A link of the reply to another site is also opened apart by the app's `links.outside` setting, so the list's own are what `newTab` decides.
async function links(path: string) {
  await using page = await site.open(path)

  await page.click('.kai-launcher-button')
  await page.waitFor('.kai-launcher-panel[open]')
  await page.fill('.kai-chat-form textarea', 'see [1] and [2]')
  await page.click('.kai-chat-form .kai-chat-send')
  await page.waitFor('.kai-chat-turn[data-role=assistant] .kai-chat-text', { text: 'see' })
  await replied(page)

  // Awaited here, as the page closes when the function returns.
  return await page.evaluate(() => [...document.querySelectorAll('.kai-chat-turn[data-role=assistant] a')].map(link => `${link.textContent}|${link.getAttribute('target') ?? ''}`))
}

it('opens a source of another site apart and one of this site in place by default', async () => {
  expect(await links('/launching-citing')).toEqual(['[1]|_blank', '[2]|', 'Tides|_blank', 'Moon|'])
}, 120_000)

it('opens a source of another site in place too with newTab={false}', async () => {
  expect((await links('/launching-citing-here')).slice(2)).toEqual(['Tides|', 'Moon|'])
}, 120_000)
