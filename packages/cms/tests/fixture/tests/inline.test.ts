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
