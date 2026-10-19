import { join } from 'node:path'
import { fakeAi } from '@kaynooo/kayjs-ai'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { browserPath, testSite } from 'kay/test'
import { refusals } from '../src/testing'

const ROOT = join(import.meta.dir, '..')
const path = browserPath()

let site: Awaited<ReturnType<typeof testSite>>

afterEach(() => {
  fakeAi.clear()
  refusals.length = 0
})

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
    // A link opens in a new tab, so following it does not swap the page and drop the conversation.
    expect(await page.evaluate(() => document.querySelector('.kai-chat-text a')?.getAttribute('target'))).toBe('_blank')
    expect(await page.evaluate(() => document.querySelector('.kai-chat-text a')?.getAttribute('rel'))).toBe('nofollow ugc noopener')
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
    expect(await page.evaluate(() => document.querySelector('.kai-chat-form button')?.getAttribute('aria-label'))).toBe('Stop')

    await page.press('Escape')
    await page.waitFor('[data-pending]', { gone: true })

    expect((await page.text('.kai-chat-turn[data-role="assistant"] .kai-chat-text'))?.trim()).toBe('Working')
    expect(await page.text('.kai-chat-note')).toBe('Stopped')
    expect(await page.evaluate(() => document.querySelector('.kai-chat-form button')?.getAttribute('aria-label'))).toBe('Send')
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
    // The calls fold into one line.
    expect(await page.text(`${turn} .kai-chat-calls-summary`)).toBe('add_note, breaks (Failed)')
    // The calls come before the text, and a call's markup is text, never HTML.
    expect(await page.evaluate(() => document.querySelector('.kai-chat-calls')?.nextElementSibling?.classList.contains('kai-chat-text'))).toBe(true)
    expect(await page.text(`${turn} .kai-chat-call:nth-child(2) pre:last-of-type`)).toContain('Something went wrong on our side')
    expect(await page.a11y('.kai-chat')).toEqual([])
    expect(page.errors).toEqual([])
  })

  test('a finished code block is swapped for the highlighted one, while the reply streams and in the finished turn, and a block left open stays plain', async () => {
    const page = await site.open('/helper')

    fakeAi.reply('Try:\n\n```ts\nconst a = 1 < 2\n```\n\nand\n\n```html\n<img src=x onerror=alert(1)>\n```\n\nthen\n\n```ts\nopen')
    await page.fill('textarea', 'Show code')
    await page.press('Enter')
    await page.waitFor('[data-pending]', { gone: true })

    const turn = '.kai-chat-turn[data-role="assistant"] .kai-chat-text'

    expect(await page.count(`${turn} pre.hl`)).toBe(2)
    expect(await page.text(`${turn} pre.hl .tok`)).toContain('const a = 1 < 2')
    expect(await page.evaluate(() => document.querySelector('pre.hl .tok')?.getAttribute('style'))).toBe('color:#c00')
    // The block of the open fence and the hostile one stay inert: the open one stays plain, no element made from the code.
    expect(await page.count(`${turn} > pre:not(.hl)`)).toBe(1)
    expect(await page.count(`${turn} img`)).toBe(0)
    expect(page.errors).toEqual([])
  })

  test('the polite status line says each tool call start and end once while the reply is hidden', async () => {
    const page = await site.open('/helper')

    await page.evaluate(() => {
      const heard: string[] = []
      const line = document.querySelector('.kai-chat-status')!

      new MutationObserver(records => heard.push(...records.flatMap(record => [...record.addedNodes].map(node => node.textContent ?? '')))).observe(line, { childList: true, subtree: true })
      ;(window as unknown as { heard: string[] }).heard = heard
    })
    fakeAi.reply({ text: 'Adding. ', calls: [{ name: 'add_note', input: { title: 'Milk' } }, { name: 'breaks' }] })
    fakeAi.reply('All done')
    await page.fill('textarea', 'Add milk')
    await page.press('Enter')
    await page.waitFor('[data-pending]', { gone: true })
    await page.waitFor('.kai-chat-turn[data-role="assistant"]', { text: 'All done' })

    const heard = await page.evaluate(() => (window as unknown as { heard: string[] }).heard)

    expect(await page.evaluate(() => document.querySelector('.kai-chat-status')?.getAttribute('role'))).toBe('status')
    expect(heard).toContain('Thinking…')
    expect(heard.filter(text => text.startsWith('add_note'))).toEqual(['add_note: Running', 'add_note: Done'])
    expect(heard.filter(text => text.startsWith('breaks'))).toEqual(['breaks: Running', 'breaks: Failed'])
  })

  test('a double send posts one message, and Enter while a reply is under way changes nothing but keeps the draft', async () => {
    const page = await site.open('/assistant')

    await page.fill('textarea', 'Once')
    await page.evaluate(() => {
      const form = document.querySelector('form')!

      form.requestSubmit()
      form.requestSubmit()
    })
    await page.waitFor('.kai-chat-turn[data-role="assistant"]')
    await page.waitFor('[data-pending]', { gone: true })

    expect(fakeAi.asked.length).toBe(1)
    expect(await page.count('.kai-chat-turn[data-role="user"]')).toBe(1)

    const slow = await site.open('/slow-assistant')

    await slow.fill('textarea', 'Go')
    await slow.press('Enter')
    await slow.waitFor('[data-pending] .kai-chat-text', { text: 'Working' })
    await slow.fill('textarea', 'Second')
    await slow.press('Enter')

    expect(await slow.count('.kai-chat-turn[data-role="user"]')).toBe(1)
    expect(await slow.value('textarea')).toBe('Second')
    expect(await slow.evaluate(() => document.querySelector('.kai-chat-form button')?.getAttribute('aria-label'))).toBe('Stop')

    await slow.press('Escape')
    await slow.waitFor('[data-pending]', { gone: true })

    expect(await slow.value('textarea')).toBe('Second')
    expect(await slow.count('.kai-chat-turn[data-role="user"]')).toBe(1)
  })

  test('Shift+Enter breaks the line and Enter sends the whole text', async () => {
    const page = await site.open('/assistant')

    await page.fill('textarea', 'line one')
    await page.press('Enter', { modifiers: ['Shift'] })
    await page.type('line two')

    expect(await page.value('textarea')).toBe('line one\nline two')
    expect(fakeAi.asked.length).toBe(0)

    await page.press('Enter')
    await page.waitFor('.kai-chat-turn[data-role="assistant"]')

    expect(fakeAi.last()?.messages.map(message => message.content)).toEqual(['line one\nline two'])
  })

  test('initial turns show at once and an assistant greeting is never posted first, with keep cutting the history to an odd count', async () => {
    const page = await site.open('/greeter')

    expect(await page.count('.kai-chat-turn')).toBe(3)
    expect(await page.text('.kai-chat-turn[data-role="assistant"]')).toContain('Welcome, ask me anything')
    expect(await page.count('[data-pending]')).toBe(0)

    await page.fill('textarea', 'First')
    await page.press('Enter')
    await page.waitFor('.kai-chat-turn:nth-of-type(5)', { text: 'Fake reply to: First' })
    await page.fill('textarea', 'Second')
    await page.press('Enter')
    await page.waitFor('.kai-chat-turn:nth-of-type(7)', { text: 'Fake reply to: Second' })

    expect(fakeAi.asked.map(asked => asked.messages.map(message => `${message.role}:${message.content}`))).toEqual([['user:First'], ['user:Second']])
  })

  test('a message the schema refuses returns to the field, on a fresh send and on a retry, and a draft typed since stays after it', async () => {
    const page = await site.open('/refusing')

    refusals.push(422)
    await page.fill('textarea', 'Bad one')
    await page.press('Enter')
    await page.waitFor('[role="alert"]', { text: 'That message is refused' })

    expect(await page.count('.kai-chat-turn[data-role="user"]')).toBe(0)
    expect(await page.value('textarea')).toBe('Bad one')

    refusals.push(500, 422)
    await page.fill('textarea', 'Retry me')
    await page.press('Enter')
    await page.waitFor('[role="alert"]', { text: 'The reply failed.' })

    // A failure that is not a refusal keeps the message for the retry.
    expect(await page.count('.kai-chat-turn[data-role="user"]')).toBe(1)

    await page.fill('textarea', 'typed since')
    await page.click('[role="alert"] button')
    await page.waitFor('[role="alert"]', { text: 'That message is refused' })

    expect(await page.count('.kai-chat-turn[data-role="user"]')).toBe(0)
    expect(await page.count('[role="alert"] button')).toBe(0)
    expect(await page.value('textarea')).toBe('Retry me\ntyped since')

    await page.fill('textarea', 'Good one')
    await page.press('Enter')
    await page.waitFor('.kai-chat-turn[data-role="assistant"]', { text: 'Fake reply to: Good one' })

    expect(fakeAi.asked.map(asked => asked.messages.length)).toEqual([1])
  })

  test('a reply action that can ctx.fail shows its message, and answers when it does not', async () => {
    const page = await site.open('/guarded')

    await page.fill('textarea', 'refuse')
    await page.press('Enter')
    await page.waitFor('[role="alert"]', { text: 'Not today' })

    await page.fill('textarea', 'fine')
    await page.press('Enter')
    await page.waitFor('.kai-chat-turn[data-role="assistant"]', { text: 'Fake reply to: fine' })
    await page.waitFor('[role="alert"]', { gone: true })
  })

  test('a wide table scrolls inside its bubble, and the HTML in its cells is never markup', async () => {
    const page = await site.open('/assistant')
    const wide = 'x'.repeat(240)

    fakeAi.reply(`| one | two | three | four |\n| --- | --- | --- | --- |\n| ${wide} | <img src=x onerror="window.pwned = 1"> | </table><script>window.pwned = 1</script> | \`</table>\` |\n\nAfter the table`)
    await page.fill('textarea', 'Table please')
    await page.press('Enter')
    await page.waitFor('.kai-chat-turn[data-role="assistant"] .kai-chat-table')
    await page.waitFor('[data-pending]', { gone: true })

    expect(await page.count('.kai-chat-text img')).toBe(0)
    expect(await page.count('.kai-chat-text script')).toBe(0)
    expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined()
    expect(await page.count('.kai-chat-text table')).toBe(1)
    expect(await page.count('.kai-chat-text .kai-chat-table > table')).toBe(1)
    expect(await page.text('.kai-chat-text p')).toBe('After the table')

    const fit = await page.evaluate(() => {
      const box = document.querySelector<HTMLElement>('.kai-chat-table')!
      const turn = box.closest<HTMLElement>('.kai-chat-turn')!
      const log = document.querySelector<HTMLElement>('.kai-chat-log')!

      return { scrolls: box.scrollWidth > box.clientWidth, overflowX: getComputedStyle(box).overflowX, turnFits: turn.scrollWidth <= turn.clientWidth, logFits: log.scrollWidth <= log.clientWidth, label: box.getAttribute('aria-label'), tabindex: box.getAttribute('tabindex') }
    })

    expect(fit).toEqual({ scrolls: true, overflowX: 'auto', turnFits: true, logFits: true, label: 'Table', tabindex: '0' })
    expect(await page.a11y('.kai-chat')).toEqual([])
  })

  test('a hostile table label stays one attribute, and several tables get numbered names that no other reply repeats as a landmark', async () => {
    const page = await site.open('/hostile')
    const table = '| a | b |\n| --- | --- |\n| 1 | 2 |'

    fakeAi.reply(`${table}\n\nBetween\n\n${table}`)
    fakeAi.reply(table)
    await page.fill('textarea', 'Two tables')
    await page.press('Enter')
    await page.waitFor('[data-pending]', { gone: true })
    await page.waitFor('.kai-chat-table')
    await page.fill('textarea', 'One table')
    await page.press('Enter')
    await page.waitFor('.kai-chat-turn[data-role="assistant"]:nth-of-type(4) .kai-chat-table')
    await page.waitFor('[data-pending]', { gone: true })

    const boxes = await page.evaluate(() => [...document.querySelectorAll('.kai-chat-table')].map(box => ({ label: box.getAttribute('aria-label'), role: box.getAttribute('role'), attributes: box.getAttributeNames().sort().join(',') })))

    expect(boxes).toEqual([
      { label: 'Tab"le <x> & more 1', role: 'group', attributes: 'aria-label,class,role,tabindex' },
      { label: 'Tab"le <x> & more 2', role: 'group', attributes: 'aria-label,class,role,tabindex' },
      { label: 'Tab"le <x> & more', role: 'group', attributes: 'aria-label,class,role,tabindex' },
    ])
    expect(await page.count('.kai-chat-text x')).toBe(0)
    expect(await page.a11y('.kai-chat')).toEqual([])
  })

  test('the log follows a reply while the visitor is at its end, and leaves them where they scrolled to', async () => {
    const atEnd = () => {
      const log = document.querySelector<HTMLElement>('[role="log"]')!

      return log.scrollHeight > log.clientHeight && log.scrollHeight - log.scrollTop - log.clientHeight < 2
    }

    const pinned = await site.open('/lengthy')

    await pinned.fill('textarea', 'Go')
    await pinned.press('Enter')
    await pinned.waitFor('[data-pending] .kai-chat-text', { text: 'Line 60' })
    await pinned.waitUntil(atEnd)
    await pinned.waitFor('.kai-chat-turn[data-role="assistant"]', { text: 'The end' })
    await pinned.waitUntil(atEnd)

    const away = await site.open('/lengthy')

    await away.fill('textarea', 'Go')
    await away.press('Enter')
    await away.waitFor('[data-pending] .kai-chat-text', { text: 'Line 60' })
    await away.waitUntil(atEnd)
    await away.evaluate(async () => {
      document.querySelector('[role="log"]')!.scrollTo({ top: 0 })
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    await away.waitFor('.kai-chat-turn[data-role="assistant"]', { text: 'The end' })
    await away.evaluate(async () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))

    expect(await away.evaluate(() => document.querySelector('[role="log"]')!.scrollTop)).toBeLessThan(48)
  })

  test('a stream that breaks mid-reply keeps the words that came and shows the error', async () => {
    const page = await site.open('/flaky')

    await page.fill('textarea', 'Go')
    await page.press('Enter')
    await page.waitFor('[role="alert"]', { text: 'The reply failed.' })
    await page.waitFor('[data-pending]', { gone: true })

    expect((await page.text('.kai-chat-turn[data-role="assistant"] .kai-chat-text'))?.trim()).toBe('Half a reply')
    expect(await page.evaluate(() => document.querySelector('.kai-chat-form button')?.getAttribute('aria-label'))).toBe('Send')
    // The words that came stay and the message was answered, so there is nothing to ask again.
    expect(await page.count('[role="alert"] button')).toBe(0)
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA')
  })

  test('Stop before the first word ends the wait without an error or a retry, and the message returns to the field', async () => {
    const page = await site.open('/held')

    await page.fill('textarea', 'Go')
    await page.press('Enter')
    await page.waitFor('[data-pending] .kai-chat-thinking')
    await page.click('.kai-chat-form button')
    await page.waitFor('[data-pending]', { gone: true })

    expect(await page.count('[role="alert"]')).toBe(0)
    expect(await page.count('.kai-chat-turn')).toBe(0)
    expect(await page.value('textarea')).toBe('Go')
    expect(await page.evaluate(() => document.querySelector('.kai-chat-form button')?.getAttribute('aria-label'))).toBe('Send')
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA')

    // Sent again, it is the one user turn there is, not a second beside the stopped one.
    await page.fill('textarea', 'Go on')
    await page.press('Enter')
    await page.waitFor('[data-pending] .kai-chat-thinking')

    expect(await page.count('.kai-chat-turn[data-role="user"]')).toBe(1)
    expect(await page.text('.kai-chat-turn[data-role="user"]')).toBe('Go on')
  })

  test('the chat has no accessibility violation, its log and field named', async () => {
    const page = await site.open('/assistant')

    expect(await page.a11y('.kai-chat')).toEqual([])
    expect(await page.evaluate(() => document.querySelector('[role="log"]')?.getAttribute('aria-label'))).toBe('Assistant')
    expect(await page.evaluate(() => document.querySelector('.kai-chat')?.hasAttribute('aria-label'))).toBe(false)
  })

  describe('the launcher', () => {
    const chunks = (page: Awaited<ReturnType<typeof site.open>>) => page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name).filter(name => name.endsWith('.js')).length)
    // The chat inside the panel is an island of its own, marked `_$k` once hydrated.
    const chatHydrated = () => document.querySelector('.kai-launcher-body [data-component]') && (document.querySelector('.kai-launcher-body [data-component]') as unknown as { _$k?: boolean })._$k === true
    const closed = '.kai-launcher-panel[hidden]'
    const opened = '.kai-launcher-panel:not([hidden])'

    test('the chat loads and hydrates on the first open only, and the button opens and closes the panel by keyboard', async () => {
      const page = await site.open('/launcher/one')

      expect(await page.count(closed)).toBe(1)
      expect(await page.evaluate(() => document.querySelector('.kai-launcher-button')?.getAttribute('aria-expanded'))).toBe('false')

      const before = await chunks(page)

      expect(await page.evaluate(chatHydrated)).toBe(false)

      await page.evaluate(() => document.querySelector<HTMLElement>('.kai-launcher-button')?.focus())
      await page.press('Enter')
      await page.waitFor(opened)

      await page.waitUntil(chatHydrated)

      expect(await chunks(page)).toBeGreaterThan(before)
      expect(await page.evaluate(() => document.querySelector('.kai-launcher-button')?.getAttribute('aria-expanded'))).toBe('true')
      expect(await page.evaluate(() => document.activeElement?.closest('.kai-launcher-panel') !== null)).toBe(true)
      expect(await page.a11y('.kai-launcher')).toEqual([])

      await page.press('Escape')
      await page.waitFor(closed)

      expect(await page.evaluate(() => document.activeElement?.classList.contains('kai-launcher-button'))).toBe(true)
      expect(page.errors).toEqual([])
    })

    test('the conversation stays across a page swap and a source link navigates in place, and a reload of the tab starts afresh', async () => {
      const page = await site.open('/launcher/one')

      await page.click('.kai-launcher-button')
      await page.waitUntil(chatHydrated)
      fakeAi.reply('See [two](/launcher/two) or [elsewhere](https://example.com).')
      await page.fill('textarea', 'Hello')
      await page.press('Enter')
      await page.waitFor('[data-pending]', { gone: true })
      await page.waitFor('.kai-chat-text a', { text: 'two' })

      expect(await page.evaluate(() => [...document.querySelectorAll('.kai-chat-text a')].map(link => link.getAttribute('target')))).toEqual([null, '_blank'])

      await page.evaluate(() => {
        (window as unknown as { marker: string }).marker = 'same document'
      })
      await page.click('.kai-chat-text a')
      await page.waitFor('h1', { text: 'Two' })

      expect(await page.evaluate(() => (window as unknown as { marker?: string }).marker)).toBe('same document')
      expect(await page.count(opened)).toBe(1)
      expect(await page.count('.kai-chat-turn')).toBe(2)

      // The next visitor to use the tab must not read it: nothing is kept unless the site names a key.
      expect(await page.evaluate(() => sessionStorage.length)).toBe(0)

      await page.reload()
      await page.click('.kai-launcher-button')
      await page.waitUntil(chatHydrated)
      await page.waitFor('.kai-chat-empty')

      expect(await page.count('.kai-chat-turn')).toBe(0)
      expect(page.errors).toEqual([])
    })

    test('a launcher given remember keeps the conversation over a reload under that key', async () => {
      const page = await site.open('/kept')

      await page.click('.kai-launcher-button')
      await page.waitUntil(chatHydrated)
      fakeAi.reply('Hi back')
      await page.fill('textarea', 'Hello')
      await page.press('Enter')
      await page.waitFor('[data-pending]', { gone: true })
      await page.reload()
      await page.click('.kai-launcher-button')
      await page.waitUntil(chatHydrated)
      await page.waitFor('.kai-chat-turn[data-role="user"]', { text: 'Hello' })

      expect(await page.count('.kai-chat-turn')).toBe(2)
      expect(await page.evaluate(() => sessionStorage.getItem('kai-chat'))).toBeNull()
      expect(await page.evaluate(() => sessionStorage.getItem('kept-chat'))).toContain('Hello')
      expect(page.errors).toEqual([])
    })

    test('Escape stops a reply under way before it closes the panel', async () => {
      const page = await site.open('/launcher/one')

      await page.click('.kai-launcher-button')
      await page.waitUntil(chatHydrated)
      await page.fill('textarea', 'Hold')
      await page.press('Enter')
      await page.waitFor('[data-pending] .kai-chat-text', { text: 'Working' })
      await page.press('Escape')
      await page.waitFor('[data-pending]', { gone: true })

      expect(await page.count(opened)).toBe(1)

      await page.press('Escape')
      await page.waitFor(closed)
    })

    test('a panel reopened shows the latest of a long conversation', async () => {
      const page = await site.open('/launcher/one', { height: 500 })

      await page.click('.kai-launcher-button')
      await page.waitUntil(chatHydrated)
      fakeAi.reply(Array.from({ length: 60 }, (_, line) => `Line ${line}\n\n`))
      await page.fill('textarea', 'Long')
      await page.press('Enter')
      await page.waitFor('[data-pending]', { gone: true })
      await page.waitFor('.kai-chat-text', { text: 'Line 59' })
      await page.click('.kai-launcher-button')
      await page.waitFor(closed)
      await page.click('.kai-launcher-button')
      await page.waitUntil(() => {
        const log = document.querySelector('.kai-chat-log')!

        return log.scrollHeight > log.clientHeight && log.scrollHeight - log.scrollTop - log.clientHeight < 8
      })
    })

    test('a suggestion sends, New conversation clears the log and the kept history, and the panel enlarges', async () => {
      const page = await site.open('/launcher/one')

      await page.click('.kai-launcher-button')
      await page.waitUntil(chatHydrated)

      expect(await page.count('.kai-chat-suggestion')).toBe(2)

      fakeAi.reply('Answer')
      await page.click('.kai-chat-suggestion')
      await page.waitFor('.kai-chat-turn[data-role="assistant"]', { text: 'Answer' })

      expect(fakeAi.last()?.messages[0]?.content).toBe('What is it?')
      expect(await page.count('.kai-chat-suggestion')).toBe(0)

      const width = () => page.evaluate(() => document.querySelector('.kai-launcher-panel')!.getBoundingClientRect().width)
      const small = await width()

      await page.click('.kai-launcher-expand')

      expect(await width()).toBeGreaterThan(small)

      await page.click('.kai-launcher-actions button')
      await page.waitFor('.kai-chat-empty')

      expect(await page.count('.kai-chat-turn')).toBe(0)
      expect(await page.evaluate(() => sessionStorage.length)).toBe(0)
      expect(page.errors).toEqual([])
    })

    test('a suggestion clicked the moment the panel opens still sends, once', async () => {
      const page = await site.open('/launcher/one')

      fakeAi.reply('Answer')
      await page.click('.kai-launcher-button')
      await page.click('.kai-chat-suggestion')
      await page.waitFor('.kai-chat-turn[data-role="assistant"]', { text: 'Answer' })
      await page.waitFor('[data-pending]', { gone: true })

      expect(fakeAi.asked.length).toBe(1)
      expect(await page.count('.kai-chat-turn[data-role="user"]')).toBe(1)
      expect(await page.count(opened)).toBe(1)
      expect(page.errors).toEqual([])
    })

    // The suggestion leaves the page as the question is sent, and the reply it asked for must not end with it.
    test('a suggestion\'s reply streams in whole, not stopped when the suggestions leave', async () => {
      const page = await site.open('/launcher/one')

      await page.click('.kai-launcher-button')
      await page.waitUntil(chatHydrated)
      fakeAi.reply(['One ', 'two ', 'three ', 'four ', 'five.'])
      await page.click('.kai-chat-suggestion')
      await page.waitFor('[data-pending]', { gone: true })
      await page.waitFor('.kai-chat-turn[data-role="assistant"]', { text: 'One two three four five.' })

      expect(await page.count('.kai-chat-note')).toBe(0)
      expect(await page.count('.kai-chat-turn')).toBe(2)
      expect(page.errors).toEqual([])
    })

    test('the panel keeps one height empty, with a short answer and a long one, with the form at its bottom', async () => {
      const page = await site.open('/launcher/one', { height: 900 })
      const measure = () => page.evaluate(() => {
        const panel = document.querySelector('.kai-launcher-panel')!.getBoundingClientRect()
        const form = document.querySelector('.kai-chat-form')!.getBoundingClientRect()
        const log = document.querySelector('.kai-chat-log')!

        return { height: panel.height, formBottom: panel.bottom - form.bottom, scrolls: log.scrollHeight > log.clientHeight }
      })

      await page.click('.kai-launcher-button')
      await page.waitUntil(chatHydrated)

      const empty = await measure()

      expect(empty.height).toBe(640)
      expect(empty.formBottom).toBeLessThan(48)

      fakeAi.reply('Short')
      await page.click('.kai-chat-suggestion')
      await page.waitFor('.kai-chat-text', { text: 'Short' })
      await page.waitFor('[data-pending]', { gone: true })

      const short = await measure()

      expect(short).toMatchObject({ height: empty.height, scrolls: false })
      expect(short.formBottom).toBeCloseTo(empty.formBottom, 0)

      fakeAi.reply(Array.from({ length: 60 }, (_, line) => `Line ${line}\n\n`))
      await page.fill('textarea', 'Long')
      await page.press('Enter')
      await page.waitFor('.kai-chat-text', { text: 'Line 59' })
      await page.waitFor('[data-pending]', { gone: true })

      const long = await measure()

      expect(long).toMatchObject({ height: empty.height, scrolls: true })
      expect(long.formBottom).toBeCloseTo(empty.formBottom, 0)

      await page.click('.kai-launcher-expand')

      const large = await measure()

      expect(large.height).toBeGreaterThan(empty.height)
      expect(large.formBottom).toBeCloseTo(empty.formBottom, 0)

      await page.click('.kai-launcher-actions button')
      await page.waitFor('.kai-chat-empty')

      expect(await measure()).toMatchObject({ height: large.height })
    })

    test('the panel is as tall as the window leaves it on a short one, and --kai-chat-height sets it', async () => {
      const page = await site.open('/launcher/one', { height: 500 })
      const height = () => page.evaluate(() => document.querySelector('.kai-launcher-panel')!.getBoundingClientRect().height)

      await page.click('.kai-launcher-button')
      await page.waitFor(opened)

      const short = await height()

      expect(short).toBeLessThan(500)
      expect(short).toBeGreaterThan(100)

      await page.evaluate(() => document.documentElement.style.setProperty('--kai-chat-height', '20rem'))
      await page.evaluate(() => document.documentElement.style.setProperty('--kai-chat-height-large', '22rem'))

      expect(await height()).toBeLessThanOrEqual(320)

      await page.click('.kai-launcher-expand')

      expect(await height()).toBeLessThanOrEqual(352)
    })

    test('the panel fits a 400px phone and the empty chat shows no list', async () => {
      const page = await site.open('/launcher/one', { width: 400, height: 700 })

      await page.click('.kai-launcher-button')
      await page.waitFor(opened)

      const fit = await page.evaluate(() => {
        const box = document.querySelector('.kai-launcher-panel')!.getBoundingClientRect()

        return { left: box.left >= 0, right: box.right <= window.innerWidth, top: box.top >= 0, bottom: box.bottom <= window.innerHeight, scrolls: document.documentElement.scrollWidth > window.innerWidth, fills: Math.abs(box.height - (window.innerHeight - 120)) < 1, formInside: document.querySelector('.kai-chat-form')!.getBoundingClientRect().bottom <= box.bottom, log: getComputedStyle(document.querySelector('.kai-chat-log')!).display }
      })

      expect(fit).toMatchObject({ left: true, right: true, top: true, bottom: true, scrolls: false, formInside: true, fills: true, log: 'none' })
    })
  })
})
