import { join } from 'node:path'
import { afterAll, afterEach, expect, test } from 'bun:test'
import { testSite } from 'kay/test'

const ROOT = join(import.meta.dir, '..')
const built = await testSite({ root: ROOT, browser: true })
const PATH = '/admin/page?path=/guide'
const BAR = '.kcms-list-bar'
const MENU = '.kcms-marker-menu'
const DOWN = `${BAR} button:nth-child(2)`
const ADD = `${BAR} button:nth-child(3)`
const REMOVE = `${BAR} button:nth-child(4)`
const ALT_SHIFT = { modifiers: ['Alt', 'Shift'] } as never

const opened: { close: () => void }[] = []

afterEach(() => {
  for (const page of opened.splice(0))
    page.close()
})

afterAll(async () => {
  await built.close()
})

async function open(path = PATH) {
  const page = await built.open(path)

  opened.push(page)
  await page.evaluate(() => {
    localStorage.clear()
    localStorage.setItem('kcms-marks', 'off')
  })
  await page.reload()
  await page.waitUntil(() => document.querySelector('.kcms-editor-open') !== null && document.querySelector('[data-kcms-path="steps"] input') !== null && document.querySelector('ol.steps li[tabindex]') !== null)

  return page
}

type Page = Awaited<ReturnType<typeof open>>

const texts = (page: Page, selector: string) => page.evaluate((target: string) => [...document.querySelectorAll(target)].map(element => element.textContent), selector)
const formSteps = (page: Page) => page.evaluate(() => [...document.querySelectorAll('[data-kcms-path="steps"] [data-kcms-row] input')].map(input => (input as HTMLInputElement).value))
const barCount = (page: Page) => page.evaluate(() => document.querySelectorAll('.kcms-list-bar').length)

// The editor docks at the bottom of a short window, so the item is scrolled to the top, clear of it, and the pointer is moved onto it there (a hover would scroll it back to the middle, under the editor's edge).
async function showBar(page: Page, selector: string, bars = 1) {
  await page.evaluate((target: string) => {
    const element = document.querySelector(target)!

    element.scrollIntoView({ block: 'start' })

    const box = element.getBoundingClientRect()

    element.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: box.left + 4, clientY: box.top + box.height / 2 }))
  }, selector)
  await page.waitUntil((count: number) => document.querySelectorAll('.kcms-list-bar').length === count, undefined, bars)
}

test('a visitor gets no list marker and no editor code', async () => {
  const html = (await (await built.fetch('/guide')).text())

  expect(html).not.toContain('data-kay-list')
  expect(html).not.toContain('kcms-list')
})

test('a list item moves down from its bar, the form follows and the focus goes with it', async () => {
  const page = await open()

  await showBar(page, 'ol.steps li:first-child')
  await page.click(DOWN)
  await page.waitUntil(() => document.querySelector('ol.steps li')!.textContent === 'Edit')
  expect(await texts(page, 'ol.steps li')).toEqual(['Edit', 'Open'])
  expect(await formSteps(page)).toEqual(['Edit', 'Open'])
  await page.waitUntil(() => document.activeElement?.textContent === 'Open' && document.activeElement.matches('ol.steps li'))
}, 60_000)

test('removing an item can be undone, from the editor\'s notice', async () => {
  const page = await open()

  await showBar(page, 'ol.steps li:first-child')
  await page.click(REMOVE)
  await page.waitUntil(() => document.querySelectorAll('ol.steps li').length === 1)
  expect(await formSteps(page)).toEqual(['Edit'])
  expect(await page.evaluate(() => document.querySelector('.kcms-editor-undo')?.textContent)).toContain('removed')
  await page.waitUntil(() => document.activeElement?.matches('ol.steps li') === true)

  await page.waitUntil(() => document.querySelector<HTMLButtonElement>('.kcms-editor-undo button')?.disabled === false)
  await page.click('.kcms-editor-undo button')
  await page.waitUntil(() => document.querySelectorAll('ol.steps li').length === 2)
  expect(await texts(page, 'ol.steps li')).toEqual(['Open', 'Edit'])
  expect(await page.evaluate(() => document.querySelector('.kcms-editor-undo'))).toBeNull()
}, 60_000)

test('the keyboard moves, removes and asks about the item in focus', async () => {
  const page = await open()

  await page.evaluate(() => document.querySelector<HTMLElement>('ol.steps li')!.focus())
  await page.press('ArrowDown', ALT_SHIFT)
  await page.waitUntil(() => document.querySelector('ol.steps li')!.textContent === 'Edit')
  await page.waitUntil(() => document.activeElement?.textContent === 'Open' && document.activeElement.matches('ol.steps li'))

  await page.press('Enter', ALT_SHIFT)
  await page.waitUntil((selector: string) => document.activeElement === document.querySelector(`${selector} button`), undefined, MENU)

  const items = await page.evaluate((selector: string) => [...document.querySelectorAll(`${selector} button`)].map(item => item.textContent), MENU)

  // The last item cannot go down; the first menu item takes the focus.
  expect(items.map(label => label!.replace(/ .*/, ''))).toEqual(['Add', 'Add', 'Move', 'Remove'])
  expect(items[2]).toContain('up')
  await page.press('Escape')
  await page.waitUntil(selector => document.querySelector(selector) === null, undefined, MENU)
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Open')

  await page.press('Delete', ALT_SHIFT)
  await page.waitUntil(() => document.querySelectorAll('ol.steps li').length === 1)
  expect(await formSteps(page)).toEqual(['Edit'])
}, 60_000)

test('a choice of the menu adds before or after the item', async () => {
  const page = await open()

  await page.evaluate(() => document.querySelector<HTMLElement>('ol.steps li')!.focus())
  await page.press('Enter', ALT_SHIFT)
  await page.waitUntil((selector: string) => document.activeElement === document.querySelector(`${selector} button`), undefined, MENU)
  await page.press('ArrowDown')
  await page.press('Enter')
  await page.waitUntil(() => document.querySelectorAll('[data-kcms-path="steps"] [data-kcms-row]').length === 3)
  expect(await formSteps(page)).toEqual(['Open', '', 'Edit'])
  // The page cannot mark an empty text, so the new item's input in the form takes the focus.
  await page.waitUntil(() => document.activeElement?.closest('[data-kcms-path="steps.1"]') != null)
}, 60_000)

test('a block list adds the block chosen by type and reorders blocks across types', async () => {
  const page = await open()
  const kinds = () => page.evaluate(() => [...document.querySelector('.sections')!.children].map(child => child.localName))

  expect(await kinds()).toEqual(['header', 'p', 'blockquote'])
  await showBar(page, '.sections blockquote')
  await page.click(ADD)
  await page.waitUntil((selector: string) => document.querySelector(selector) !== null, undefined, MENU)
  expect(await page.evaluate((selector: string) => [...document.querySelectorAll(`${selector} button`)].map(item => item.textContent), MENU)).toEqual(['Hero', 'Text', 'Quote'])
  await page.click(`${MENU} button:nth-child(2)`)
  await page.waitUntil(() => document.querySelector('.sections')!.children.length === 4)
  expect(await kinds()).toEqual(['header', 'p', 'blockquote', 'p'])
  await page.waitUntil(() => document.activeElement?.closest('[data-kcms-path^="sections.3."]') != null)

  await showBar(page, '.sections header')
  await page.click(DOWN)
  await page.waitUntil(() => document.querySelector('.sections')!.firstElementChild!.localName === 'p')
  expect(await kinds()).toEqual(['p', 'header', 'blockquote', 'p'])
  expect(await page.evaluate(() => document.querySelector('.sections header h2')!.getAttribute('data-kay-field'))).toContain('sections.1.heading')
}, 60_000)

test('a list inside an item has its own bar beside its item\'s, and each acts on its own list', async () => {
  const page = await open()

  await showBar(page, '.columns .cells li:first-child', 2)
  // The inner bar is first; the column's is below it.
  await page.click(`${BAR}:nth-child(1) button:nth-child(4)`)
  await page.waitUntil(() => document.querySelector('.columns .cells')!.children.length === 1)
  expect(await texts(page, '.columns .column:first-child .cells li')).toEqual(['L2'])

  await showBar(page, '.columns .cells li:first-child', 2)
  await page.click(`${BAR}:nth-child(2) button:nth-child(2)`)
  await page.waitUntil(() => document.querySelector('.columns h2')!.textContent === 'Right')
  expect(await texts(page, '.columns h2')).toEqual(['Right', 'Left'])
  expect(await texts(page, '.columns .column:last-child .cells li')).toEqual(['L2'])
}, 60_000)

test('an empty list has an Add of its own and a tab stop for the keyboard', async () => {
  const page = await open()

  await page.evaluate(() => document.querySelector('ul.empty')!.scrollIntoView({ block: 'start' }))
  await page.waitUntil(() => document.querySelector('.kcms-list-start button') !== null)
  expect(await page.evaluate(() => [document.querySelector('ul.empty')!.getAttribute('tabindex'), document.querySelector('ul.empty')!.getAttribute('role')])).toEqual(['0', 'group'])
  await page.click('.kcms-list-start button')
  await page.waitUntil(() => document.querySelectorAll('ul.empty li').length === 1)
  await page.waitUntil(() => document.activeElement?.closest('[data-kcms-path="empty.0"]') != null)
  expect(await page.evaluate(() => [document.querySelector('ul.empty')!.hasAttribute('tabindex'), document.querySelector('.kcms-list-start') === null])).toEqual([false, true])

  const second = await open()

  await second.evaluate(() => document.querySelector<HTMLElement>('ul.empty')!.focus())
  await second.press('Enter')
  await second.waitUntil(() => document.querySelectorAll('ul.empty li').length === 1)
}, 60_000)

test('the limits of a list disable Add at the most and Remove at the least', async () => {
  const page = await open()

  await showBar(page, 'ul.limited li:first-child')
  expect(await page.evaluate(selector => (document.querySelector(selector) as HTMLButtonElement).disabled, ADD)).toBe(true)
  await page.click(REMOVE)
  await page.waitUntil(() => document.querySelectorAll('ul.limited li').length === 1)
  await showBar(page, 'ul.limited li:first-child')
  expect(await page.evaluate(selector => [(document.querySelector(selector) as HTMLButtonElement).disabled], REMOVE)).toEqual([true])
}, 60_000)

test('a localized entry changes its own locale\'s draft, in the site\'s words', async () => {
  const page = await open('/admin/page?path=/fr/guide')

  await showBar(page, 'ol.steps li:first-child')
  expect(await page.evaluate(selector => document.querySelector(selector)!.getAttribute('aria-label'), `${BAR} button:nth-child(2)`)).toContain('Descendre')
  expect(await page.evaluate(selector => document.querySelector(selector)!.getAttribute('aria-label'), `${BAR} button:nth-child(3)`)).toContain('Ajouter après')
  expect(await page.evaluate(() => document.querySelector('ul.empty')!.getAttribute('aria-label'))).toContain('aucun élément')
  await page.click(DOWN)
  await page.waitUntil(() => document.querySelector('ol.steps li')!.textContent === 'Modifier')
  expect(await formSteps(page)).toEqual(['Modifier', 'Ouvrir'])
}, 60_000)

test('browsing the page shows no bar', async () => {
  const page = await open()

  await showBar(page, 'ol.steps li:first-child')
  await page.click('button[aria-label^="Browse the page"]')
  await page.waitUntil(() => document.querySelectorAll('.kcms-list-bar').length === 0)
  await page.hover('ol.steps li:last-child')
  expect(await barCount(page)).toBe(0)
}, 60_000)
