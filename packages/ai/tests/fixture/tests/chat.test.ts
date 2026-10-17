import { join } from 'node:path'
import { fakeAi } from '@kaynooo/kayjs-ai'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { browserPath, testSite } from 'kay/test'

const ROOT = join(import.meta.dir, '..')
const path = browserPath()

let site: Awaited<ReturnType<typeof testSite>>

afterEach(() => fakeAi.clear())

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('the Chat island in a browser', () => {
  beforeAll(async () => {
    site = await testSite({ root: ROOT, browser: { path }, onError: () => undefined })
  }, 120_000)

  afterAll(async () => site?.close())

  test('a message streams its reply in as markdown, and the history is posted whole with the next one', async () => {
    const page = await site.open('/assistant')

    fakeAi.reply(['Here is **bold** and ', '![pixel](https://evil.test/p.png) a [link](https://example.com).'])
    await page.fill('textarea', 'Hello')
    await page.click('button[type="submit"]')
    await page.waitFor('[data-pending]', { gone: true })
    await page.waitFor('.kai-chat-turn[data-role="assistant"] strong', { text: 'bold' })

    expect(await page.text('.kai-chat-turn[data-role="user"]')).toBe('Hello')
    // No image goes into the page, since its URL could carry the conversation out.
    expect(await page.count('.kai-chat-text img')).toBe(0)
    expect(await page.count('.kai-chat-text a')).toBe(1)
    expect(await page.value('textarea')).toBe('')

    fakeAi.reply('Second answer')
    await page.fill('textarea', 'Again')
    await page.press('Enter')
    await page.waitFor('.kai-chat-turn[data-role="assistant"]:nth-of-type(4)', { text: 'Second answer' })
    await page.waitFor('[data-pending]', { gone: true })

    expect(fakeAi.asked.map(asked => asked.messages.map(message => message.role))).toEqual([['user'], ['user', 'assistant', 'user']])
    expect(fakeAi.last()?.messages[1]?.content).toContain('Here is **bold**')
    expect(await page.count('[data-pending]')).toBe(0)
    expect(page.errors).toEqual([])
  })

  test('a reply that fails shows an alert and Try again asks for it once more without a second copy of the message', async () => {
    const page = await site.open('/assistant')

    fakeAi.fail(new Error('down'))
    await page.fill('textarea', 'Hello')
    await page.press('Enter')
    await page.waitFor('[role="alert"]', { text: 'The reply failed.' })

    fakeAi.reply('Back again')
    await page.click('[role="alert"] button')
    await page.waitFor('.kai-chat-turn[data-role="assistant"]', { text: 'Back again' })
    await page.waitFor('[role="alert"]', { gone: true })

    expect(fakeAi.asked.map(asked => asked.messages.length)).toEqual([1, 1])
    expect(await page.count('.kai-chat-turn[data-role="user"]')).toBe(1)
  })

  test('Stop closes the stream and keeps the words that came, marked as stopped', async () => {
    const page = await site.open('/slow-assistant')

    await page.fill('textarea', 'Go')
    await page.press('Enter')
    await page.waitFor('[data-pending] .kai-chat-text', { text: 'Working' })
    // Send turns into Stop while the reply is under way.
    expect(await page.text('.kai-chat-form button')).toBe('Stop')

    await page.press('Escape')
    await page.waitFor('[data-pending]', { gone: true })

    expect((await page.text('.kai-chat-turn[data-role="assistant"] .kai-chat-text'))?.trim()).toBe('Working')
    expect(await page.text('.kai-chat-note')).toBe('Stopped')
    expect(await page.text('.kai-chat-form button')).toBe('Send')
    expect(await page.count('[role="alert"]')).toBe(0)
    expect(page.errors).toEqual([])
  })

  test('tool calls show before the text of their turn, running then done, with their arguments and result', async () => {
    const page = await site.open('/helper')

    fakeAi.reply({ text: 'Adding. ', calls: [{ name: 'add_note', input: { title: 'Milk' } }, { name: 'breaks' }] })
    fakeAi.reply('Done, **all** of it')
    await page.fill('textarea', 'Add milk')
    await page.press('Enter')
    await page.waitFor('[data-pending]', { gone: true })
    await page.waitFor('.kai-chat-turn[data-role="assistant"] strong', { text: 'all' })

    const turn = '.kai-chat-turn[data-role="assistant"]'

    expect(await page.count(`${turn} .kai-chat-call`)).toBe(2)
    expect(await page.text(`${turn} .kai-chat-call:nth-child(1) .kai-chat-call-name`)).toBe('add_note')
    expect(await page.text(`${turn} .kai-chat-call:nth-child(1) .kai-chat-call-status`)).toBe('Done')
    expect(await page.text(`${turn} .kai-chat-call:nth-child(2) .kai-chat-call-status`)).toBe('Failed')
    expect(await page.text(`${turn} .kai-chat-call:nth-child(1) pre`)).toContain('"title": "Milk"')
    // The calls come before the text, and a call's markup is text, never HTML.
    expect(await page.evaluate(() => document.querySelector('.kai-chat-calls')?.nextElementSibling?.classList.contains('kai-chat-text'))).toBe(true)
    expect(await page.text(`${turn} .kai-chat-call:nth-child(2) pre:last-of-type`)).toContain('Something went wrong on our side')
    expect(await page.a11y('.kai-chat')).toEqual([])
    expect(page.errors).toEqual([])
  })

  test('the chat has no accessibility violation, its log and field named', async () => {
    const page = await site.open('/assistant')

    expect(await page.a11y('.kai-chat')).toEqual([])
    expect(await page.evaluate(() => document.querySelector('[role="log"]')?.getAttribute('aria-label'))).toBe('Assistant')
  })
})
