import { join } from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { testSite } from 'kay/test'

const site = await testSite({ root: join(import.meta.dir, 'fixture'), browser: true })

afterAll(async () => site.close())

type Page = Awaited<ReturnType<typeof site.open>>

const EDIT = 'button[aria-label^="Edit the message"]'
const REGENERATE = 'button[aria-label="Regenerate the reply"]'
const LAST = '.kai-chat-turn[data-role=assistant]:last-of-type'

// The assistant turns as a visitor reads them: the text, then the titles of the sources listed under it.
const turns = async (page: Page) => page.evaluate(() => [...document.querySelectorAll('.kai-chat-turn[data-role=assistant]')].map(turn => `${turn.querySelector('.kai-chat-text')?.textContent?.trim() ?? ''} | ${[...turn.querySelectorAll('.kai-chat-source-link')].map(link => link.textContent).join(',')}`))

async function send(page: Page, text: string, answer: string) {
  await page.fill('.kai-chat-form textarea', text)
  await page.click('.kai-chat-form .kai-chat-send')
  await page.waitFor(`${LAST} .kai-chat-text`, { text: answer })
}

it('hydrates an initial turn with sources as the server drew it: formatted from the first paint, one list that never flashes', async () => {
  await using plain = await site.open('/citing-initial', { javaScript: false })

  const drawn = await plain.evaluate(() => document.querySelector('.kai-chat-turn')!.innerHTML)

  expect(drawn).toContain('<h1>Title</h1>')
  expect(drawn).toContain('<a href="https://example.com/tides" target="_blank" rel="nofollow ugc noopener" data-new-tab="">[1]</a>')
  expect(drawn).toContain('not <code>[1]</code> in code')

  await using page = await site.open('/citing-initial')

  // Every state the turn went through while the page loaded: a stand-in of the Markdown as written, or a list that came and went, would show here.
  await page.initScript(() => {
    const seen = new Set<string>()
    const record = () => {
      const turn = document.querySelector('.kai-chat-turn')

      if (turn)
        seen.add(turn.innerHTML)
    }

    Object.assign(window, { seen })
    new MutationObserver(record).observe(document, { subtree: true, childList: true, characterData: true, attributes: true })
    document.addEventListener('DOMContentLoaded', record)
  })
  await page.reload()
  await page.waitUntil(() => document.querySelectorAll('.kai-chat-source-link').length === 2)

  const states = await page.evaluate(() => [...(window as unknown as { seen: Set<string> }).seen])

  expect(states.every(state => state.includes('<h1>Title</h1>') && state.split('kai-chat-source-link').length === 3)).toBe(true)
  expect(await page.evaluate(() => document.querySelector('.kai-chat-turn')!.innerHTML)).toContain('<h1>Title</h1>')
  expect(await page.count('.kai-chat-sources')).toBe(1)
  expect(page.errors).toEqual([])
}, 120_000)

it('hydrates an initial turn that cites only inside code with no list at any moment, as the server drew it', async () => {
  await using plain = await site.open('/citing-initial-code', { javaScript: false })

  expect(await plain.count('.kai-chat-sources')).toBe(0)

  await using page = await site.open('/citing-initial-code')

  await page.initScript(() => {
    const seen = new Set<string>()
    const record = () => {
      const turn = document.querySelector('.kai-chat-turn')

      if (turn)
        seen.add(turn.innerHTML)
    }

    Object.assign(window, { seen })
    new MutationObserver(record).observe(document, { subtree: true, childList: true, characterData: true, attributes: true })
    document.addEventListener('DOMContentLoaded', record)
  })
  await page.reload()
  // The island is hydrated once it, or an element around the chat, carries its state; the renderer arrives a moment after.
  await page.waitUntil(() => {
    for (let element = document.querySelector('.kai-chat'); element; element = element.parentElement) {
      if ('_$k' in element)
        return true
    }

    return false
  })
  await Bun.sleep(500)

  const states = await page.evaluate(() => [...(window as unknown as { seen: Set<string> }).seen])

  expect(states.length).toBeGreaterThan(0)
  expect(states.some(state => state.includes('kai-chat-source'))).toBe(false)
  expect(await page.count('.kai-chat-sources')).toBe(0)
  expect(page.errors).toEqual([])
}, 120_000)

it('lists a source cited in a list or a table,and links none in code, in a link, or written [01] or with five digits', async () => {
  await using page = await site.open('/citing')

  await send(page, '- see [2]\n\n| a | b |\n|---|---|\n| [1] | x |', 'see')

  expect(await page.evaluate(() => [...document.querySelectorAll('.kai-chat-turn[data-role=assistant] .kai-chat-text a')].map(link => `${link.textContent}>${link.getAttribute('href')}`))).toEqual(['[2]>/moon', '[1]>https://example.com/tides'])
  expect(await page.evaluate(() => [...document.querySelectorAll('.kai-chat-source-link')].map(link => link.textContent))).toEqual(['Moon', 'Tides'])
  expect(await page.count('.kai-chat-text .kai-chat-table')).toBe(1)

  await page.click('.kai-chat-new')
  await send(page, '```\n[1]\n```\n\n`[2]` [x [1]](https://example.com) [01] [12345] [0] [3]', '[1]')

  expect(await page.count('.kai-chat-turn[data-role=assistant] .kai-chat-text a[href="https://example.com"]')).toBe(1)
  expect(await page.count('.kai-chat-turn[data-role=assistant] .kai-chat-text a')).toBe(1)
  expect(await page.count('.kai-chat-sources')).toBe(0)
  expect(page.errors).toEqual([])
}, 120_000)

it('lists no source under a second turn that cites none, and keeps the first turn\'s', async () => {
  await using page = await site.open('/citing')

  await send(page, 'see [1]', 'see')
  await send(page, 'none:plain [1]', 'plain')

  expect(await turns(page)).toEqual(['see [1] | Tides', 'plain [1] | '])
}, 120_000)

it('leaves no source of a reply that was regenerated, edited away or cleared', async () => {
  await using page = await site.open('/citing')

  await send(page, 'see [1]', 'see')
  await send(page, 'also [2]', 'also')
  await page.click(REGENERATE)
  await page.waitFor(`${LAST} .kai-chat-source-link`)

  expect(await turns(page)).toEqual(['see [1] | Tides', 'also [2] | Moon'])

  await page.click(`.kai-chat-turn[data-role=user] ${EDIT}`)
  await page.fill('.kai-chat-turn[data-editing] textarea', 'none:edited [1]')
  await page.click('.kai-chat-save')
  await page.waitFor(`${LAST} .kai-chat-text`, { text: 'edited' })

  expect(await turns(page)).toEqual(['edited [1] | '])
  expect(await page.count('.kai-chat-sources')).toBe(0)

  await send(page, 'again [1]', 'again')
  await page.click('.kai-chat-new')

  expect(await page.count('.kai-chat-sources')).toBe(0)
  expect(await page.count('.kai-chat-turn')).toBe(0)
}, 120_000)

it('opens a local source in place with links=here, and every other link, the list\'s included, in a new tab', async () => {
  await using page = await site.open('/citing-here')

  await send(page, 'see [1] and [2]', 'see')

  const links = await page.evaluate(() => [...document.querySelectorAll('.kai-chat-turn[data-role=assistant] a')].map(link => `${link.textContent}|${link.getAttribute('target') ?? ''}|${link.getAttribute('rel')}`))

  expect(links).toEqual([
    '[1]|_blank|nofollow ugc noopener',
    '[2]||nofollow ugc',
    'Tides|_blank|nofollow ugc noopener',
    'Moon||nofollow ugc',
  ])
}, 120_000)

it('names the list of sources for a screen reader by its label', async () => {
  await using page = await site.open('/citing')

  await send(page, 'see [1]', 'see')

  expect(await page.evaluate(() => {
    const list = document.querySelector('.kai-chat-sources-list')!

    return document.getElementById(list.getAttribute('aria-labelledby')!)?.textContent
  })).toBe('Sources')
}, 120_000)
