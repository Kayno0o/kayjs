import { join } from 'node:path'
import { afterAll, afterEach, expect, test } from 'bun:test'
import { testSite } from 'kay/test'

const ROOT = join(import.meta.dir, '..')
const built = await testSite({ root: ROOT, browser: true })
const PATH = '/admin/page?path=/blog/hello'
const TITLE = 'h1[data-kay-field]'
const FORM_TITLE = '[data-kcms-path="title"] input'

// Each page holds the live connection the editor's presence keeps open, and a browser allows a host a few, so a page is closed with its test.
const opened: { close: () => void }[] = []

afterEach(() => {
  for (const page of opened.splice(0))
    page.close()
})

afterAll(async () => {
  await built.close()
})

async function open() {
  const page = await built.open(PATH)

  opened.push(page)
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.waitUntil(() => document.querySelector('.kcms-editor-open') !== null && document.querySelector('[data-kcms-path="title"] input') !== null)

  return page
}

// Clicks the title and selects its text, as an editor about to replace it does.
async function edit(page: Awaited<ReturnType<typeof open>>) {
  await page.click(TITLE)
  await page.waitUntil((selector: string) => document.activeElement === document.querySelector(selector) && document.activeElement?.getAttribute('contenteditable') === 'plaintext-only', undefined, TITLE)
  await page.evaluate((selector: string) => document.getSelection()!.selectAllChildren(document.querySelector(selector)!), TITLE)
}

test('a click on the title types in place, the form follows, and Enter ends the edit with the text kept', async () => {
  const page = await open()

  await edit(page)
  await page.type('Hello inline')
  await page.waitUntil((selector: string) => (document.querySelector(selector) as HTMLInputElement).value === 'Hello inline', undefined, FORM_TITLE)

  // The page renders the draft meanwhile, which leaves the element being typed in alone.
  await page.waitUntil(() => document.querySelector('.kcms-editor-status p') === null)
  expect(await page.evaluate(selector => [document.querySelector(selector)!.textContent, document.activeElement === document.querySelector(selector)], TITLE)).toEqual(['Hello inline', true])

  await page.press('Enter')
  await page.waitUntil((selector: string) => !document.querySelector(selector)!.hasAttribute('contenteditable'), undefined, TITLE)
  await page.waitUntil(() => document.querySelector('.kcms-editor-status p') === null)

  expect(await page.text(TITLE)).toBe('Hello inline')
  expect(await page.value(FORM_TITLE)).toBe('Hello inline')
}, 60_000)

test('text with a line break and HTML lands as one line of text', async () => {
  const page = await open()

  await edit(page)
  await page.cdp('Input.insertText', { text: 'one\ntwo <b>bold</b>' })
  await page.waitUntil((selector: string) => (document.querySelector(selector) as HTMLInputElement).value === 'one two <b>bold</b>', undefined, FORM_TITLE)

  // The browser lays the break out as a block while the text is typed in; once the edit ends the page renders the draft: one line, the HTML as text.
  await page.press('Enter')
  await page.waitUntil((selector: string) => document.querySelector(selector)!.children.length === 0 && document.querySelector(selector)!.textContent === 'one two <b>bold</b>', undefined, TITLE)
  expect(await page.value(FORM_TITLE)).toBe('one two <b>bold</b>')
}, 60_000)

test('the caret lands where the title was clicked', async () => {
  const page = await open()

  // The point between the fifth and sixth letter, where the h1's own box is wider than its text.
  const [x, y] = await page.evaluate((selector: string) => {
    const text = document.querySelector(selector)!.firstChild!
    const range = document.createRange()

    range.setStart(text, 5)
    range.setEnd(text, 6)

    const box = range.getBoundingClientRect()

    return [box.left + 1, box.top + box.height / 2]
  }, TITLE)

  for (const type of ['mousePressed', 'mouseReleased'])
    await page.cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })

  await page.waitUntil((selector: string) => document.activeElement === document.querySelector(selector) && document.activeElement?.getAttribute('contenteditable') === 'plaintext-only', undefined, TITLE)
  await page.type('X')

  const text = await page.evaluate(selector => document.querySelector(selector)!.textContent!, TITLE)

  expect(text.replace('X', '')).toBe('Hello world')
  expect(text).toBe('HelloX world')
}, 60_000)

test('a window blur keeps the edit going, and the focus coming back leaves with Enter', async () => {
  const page = await open()

  await edit(page)
  await page.evaluate((selector: string) => {
    // A window losing the focus blurs the element while it stays the document's active one.
    document.hasFocus = () => false
    document.querySelector(selector)!.dispatchEvent(new FocusEvent('blur'))
  }, TITLE)
  expect(await page.evaluate(selector => document.querySelector(selector)!.getAttribute('contenteditable'), TITLE)).toBe('plaintext-only')

  await page.evaluate(() => {
    delete (document as { hasFocus?: unknown }).hasFocus
  })
  await page.press('Enter')
  await page.waitUntil((selector: string) => !document.querySelector(selector)!.hasAttribute('contenteditable'), undefined, TITLE)
}, 60_000)

test('an element the page removes mid-edit leaves no note or editable mark behind', async () => {
  const page = await open()

  await edit(page)
  await page.type('x'.repeat(50))
  await page.waitUntil(() => document.querySelector('.kcms-inline-issue:not([hidden])') !== null)
  await page.evaluate((selector: string) => document.querySelector(selector)!.remove(), TITLE)
  await page.waitUntil(() => document.querySelector('.kcms-inline-issue') === null)
}, 60_000)

test('the schema limit shows as the title is typed, announced as an alert tied to the text', async () => {
  const page = await open()

  await edit(page)
  await page.type('x'.repeat(50))
  await page.waitUntil(() => document.querySelector('.kcms-inline-issue:not([hidden])') !== null)

  expect(await page.evaluate((selector: string) => {
    const element = document.querySelector(selector)!
    const note = document.querySelector('.kcms-inline-issue')!

    return [note.getAttribute('role'), note.textContent, element.getAttribute('aria-invalid'), element.getAttribute('aria-describedby') === note.id]
  }, TITLE)).toEqual(['alert', 'Title takes 40 characters at most', 'true', true])

  await page.press('Backspace')
  await page.evaluate(() => {
    for (let n = 0; n < 9; n++) document.execCommand('delete')
  })
  await page.waitUntil((selector: string) => document.querySelector('.kcms-inline-issue')!.hasAttribute('hidden') && !document.querySelector(selector)!.hasAttribute('aria-invalid'), undefined, TITLE)

  await page.press('Enter')
  await page.waitUntil(() => document.querySelector('.kcms-inline-issue') === null)
}, 60_000)

test('Escape puts back the text from before the edit, in the page and the form', async () => {
  const page = await open()
  const before = (await page.text(TITLE)) ?? ''

  await edit(page)
  await page.type('Changed')
  await page.waitUntil((selector: string) => (document.querySelector(selector) as HTMLInputElement).value === 'Changed', undefined, FORM_TITLE)
  await page.press('Escape')
  await page.waitUntil((selector: string) => !document.querySelector(selector)!.hasAttribute('contenteditable'), undefined, TITLE)
  await page.waitUntil((selector: string, wanted: string) => (document.querySelector(selector) as HTMLInputElement).value === wanted, undefined, FORM_TITLE, before)
  await page.waitUntil(() => document.querySelector('.kcms-editor-status p') === null)

  expect(await page.text(TITLE)).toBe(before)
}, 60_000)

test('the title takes a tab stop, and Enter on it starts the edit', async () => {
  const page = await open()

  expect(await page.evaluate(selector => document.querySelector(selector)!.getAttribute('tabindex'), TITLE)).toBe('0')

  await page.evaluate((selector: string) => (document.querySelector(selector) as HTMLElement).focus(), TITLE)
  await page.press('Enter')
  await page.waitUntil((selector: string) => document.activeElement === document.querySelector(selector) && document.activeElement?.getAttribute('contenteditable') === 'plaintext-only', undefined, TITLE)
  await page.type('!')
  await page.waitUntil((selector: string) => (document.querySelector(selector) as HTMLInputElement).value === 'Hello world!', undefined, FORM_TITLE)
}, 60_000)
