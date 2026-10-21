import { join } from 'node:path'
import { afterAll, afterEach, expect, test } from 'bun:test'
import { testSite } from 'kay/test'

const ROOT = join(import.meta.dir, '..')
const built = await testSite({ root: ROOT, browser: true })
const PATH = '/admin/page?path=/blog/hello'
const TITLE = 'h1[data-kay-field]'
const OUTLINE_ALL = 'button[aria-label="Outline every field of the page"]'
const BROWSE = 'button[aria-label^="Browse the page"]'
const MENU = '.kcms-marker-menu'

const opened: { close: () => void }[] = []

afterEach(() => {
  for (const page of opened.splice(0))
    page.close()
})

afterAll(async () => {
  await built.close()
})

// The outlines start off (a headless browser reports no hover, which would turn them on), unless the test says otherwise.
async function open(marks: 'on' | 'off' | 'unset' = 'off') {
  const page = await built.open(PATH)

  opened.push(page)
  await page.evaluate((value: string) => {
    localStorage.clear()

    if (value !== 'unset')
      localStorage.setItem('kcms-marks', value)
  }, marks)
  await page.reload()
  await page.waitUntil(() => document.querySelector('.kcms-editor-open') !== null && document.querySelector('[data-kcms-path="title"] input') !== null && document.querySelector('h1[tabindex]') !== null)

  return page
}

// The outlines the editor draws over the page, as boxes.
function outlines() {
  return [...document.querySelectorAll('.kcms-mark')].map((mark) => {
    const box = mark.getBoundingClientRect()

    return { left: box.left, top: box.top, width: box.width, height: box.height, hovered: mark.hasAttribute('data-hover') }
  })
}

// Adds an element marked by attributes: the title of the entry shown in the attribute `data-kay-field-title`.
async function addMarked(page: Awaited<ReturnType<typeof open>>, html: string) {
  await page.evaluate((markup: string) => {
    document.querySelector('article')!.insertAdjacentHTML('beforebegin', markup)
  }, html)
}

test('the field under the pointer is outlined, an attribute and a comment pair as much as a text', async () => {
  const page = await open()

  await addMarked(page, '<p id="alt" data-kay-field-title="posts:hello:title">Attribute</p>')
  await page.hover(TITLE)
  await page.waitUntil(() => document.querySelectorAll('.kcms-mark[data-hover]').length === 1)

  await page.hover('#alt')
  await page.waitUntil(() => {
    const box = document.querySelector('#alt')!.getBoundingClientRect()
    const mark = document.querySelector('.kcms-mark[data-hover]')?.getBoundingClientRect()

    return mark !== undefined && Math.abs(mark.left + 2 - box.left) < 1 && Math.abs(mark.height - 4 - box.height) < 1
  })

  // "Posted as" shares its paragraph with a comment pair's text.
  await page.hover('h1 + p')
  await page.waitUntil(() => document.querySelectorAll('.kcms-mark[data-hover]').length === 1)

  const [only] = await page.evaluate(outlines)

  expect(only!.width).toBeGreaterThan(0)
}, 60_000)

test('the toggle outlines every marked field, stays after a reload, and shows on a screen with no hover', async () => {
  const page = await open()

  expect(await page.count('.kcms-mark')).toBe(0)
  await page.click(OUTLINE_ALL)
  await page.waitUntil(() => document.querySelectorAll('.kcms-mark').length >= 2)

  const boxes = await page.evaluate(outlines)
  const title = await page.evaluate((selector: string) => {
    const box = document.querySelector(selector)!.getBoundingClientRect()

    return [box.left, box.top]
  }, TITLE)

  expect(boxes.some(({ left, top }) => Math.abs(left + 2 - title[0]!) < 1 && Math.abs(top + 2 - title[1]!) < 1)).toBe(true)

  await page.reload()
  await page.waitUntil(() => document.querySelectorAll('.kcms-mark').length >= 2)
  expect(await page.evaluate(() => document.querySelector('button[aria-pressed="true"]')?.getAttribute('aria-label'))).toBe('Stop outlining every field')
}, 60_000)

test('a screen with no hover has the outlines on until the editor turns them off', async () => {
  const page = await open('unset')
  const noHover = await page.evaluate(() => matchMedia('(hover: none)').matches)

  expect(await page.evaluate(() => document.querySelector('button[aria-pressed]')?.getAttribute('aria-pressed') === 'true')).toBe(noHover)
  expect(await page.count('.kcms-mark') > 0).toBe(noHover)
}, 60_000)

test('marked elements are tab stops that say what they edit, and a plain text one is a button', async () => {
  const page = await open()

  await addMarked(page, '<div id="plain" data-kay-field="posts:hello:title">Plain</div><a id="link" href="#x" data-kay-field-title="posts:hello:title">Link</a><div id="body" data-kay-body="posts:hello"><h2>Inside</h2></div><div id="attr" data-kay-field-title="posts:hello:title">Attr</div>')
  await page.waitUntil(() => document.querySelector('#plain')!.getAttribute('tabindex') === '0')

  const read = (selector: string) => page.evaluate((target: string) => {
    const element = document.querySelector<HTMLElement>(target)!

    element.focus()

    return [element.getAttribute('tabindex'), element.getAttribute('role'), element.getAttribute('aria-description')]
  }, selector)

  // The description names the field by its label once the form has loaded, as the focus brings it up to date (`read` focuses).
  expect(await read('#plain')).toEqual(['0', 'button', 'Edit Title'])
  // What holds more than one field's text keeps its own role, so the content inside stays readable.
  expect(await read('#body')).toEqual(['0', null, 'Edit Body'])
  expect(await read('#attr')).toEqual(['0', null, 'Edit Title (title)'])
  expect(await read('#link')).toEqual([null, null, 'Edit Title (title)'])
  expect(await read(TITLE)).toEqual(['0', null, 'Edit Title'])

  // Space on a button-role element acts as Enter does.
  await page.evaluate(() => document.querySelector<HTMLElement>('#plain')!.focus())
  await page.press(' ')
  await page.waitUntil(() => document.querySelector('#plain')!.getAttribute('contenteditable') === 'plaintext-only')
}, 60_000)

test('an element with several fields asks which one, by click and by key', async () => {
  const page = await open()

  await page.evaluate((selector: string) => document.querySelector(selector)!.setAttribute('data-kay-field-title', 'posts:hello:title'), TITLE)
  await page.click(TITLE)
  await page.waitUntil((selector: string) => document.querySelector(selector) !== null, undefined, MENU)

  const items = await page.evaluate((selector: string) => [...document.querySelectorAll(`${selector} button`)].map(item => item.textContent), MENU)

  expect(items).toEqual(['Title', 'Title (title)'])
  expect(await page.evaluate(() => document.querySelector('h1')!.hasAttribute('contenteditable'))).toBe(false)

  // The first item has the focus; Escape closes the question and gives the focus back to the element only when a key opened it.
  await page.waitUntil((selector: string) => document.activeElement === document.querySelector(`${selector} button`), undefined, MENU)
  await page.press('ArrowDown')
  expect(await page.evaluate((selector: string) => document.activeElement === document.querySelectorAll(`${selector} button`)[1], MENU)).toBe(true)
  await page.press('Escape')
  await page.waitUntil(selector => document.querySelector(selector) === null, undefined, MENU)

  await page.evaluate((selector: string) => document.querySelector<HTMLElement>(selector)!.focus(), TITLE)
  await page.press('Enter')
  await page.waitUntil((selector: string) => document.activeElement === document.querySelector(`${selector} button`), undefined, MENU)
  await page.press('Enter')
  await page.waitUntil((selector: string) => document.querySelector(selector)!.getAttribute('contenteditable') === 'plaintext-only' && document.querySelector('.kcms-marker-menu') === null, undefined, TITLE)
}, 60_000)

test('the choice closes on a click elsewhere, and a field chosen with the second item opens in the form', async () => {
  const page = await open()

  await page.evaluate((selector: string) => document.querySelector(selector)!.setAttribute('data-kay-field-title', 'posts:hello:title'), TITLE)
  await page.click(TITLE)
  await page.waitUntil(selector => document.querySelector(selector) !== null, undefined, MENU)
  await page.click('footer')
  await page.waitUntil(selector => document.querySelector(selector) === null, undefined, MENU)

  await page.click(TITLE)
  await page.waitUntil(selector => document.querySelector(selector) !== null, undefined, MENU)
  await page.click(`${MENU} button:nth-child(2)`)
  await page.waitUntil(selector => document.querySelector(selector) === null, undefined, MENU)
  expect(await page.evaluate(() => document.querySelector('h1')!.hasAttribute('contenteditable'))).toBe(false)
}, 60_000)

test('browsing lets a link work and takes the outlines, tab stops and clicks off until editing is back', async () => {
  const page = await open()

  await addMarked(page, '<a id="jump" href="#after" data-kay-field-title="posts:hello:title">Jump</a><span id="after"></span>')
  await page.click(OUTLINE_ALL)
  await page.waitUntil(() => document.querySelectorAll('.kcms-mark').length >= 2)

  // Editing: the click is the editor's, the link does not go.
  await page.click('#jump')
  expect(await page.evaluate(() => location.hash)).toBe('')

  await page.click(BROWSE)
  await page.waitUntil(() => document.querySelector('.kcms-marks') === null && !document.querySelector('h1')!.hasAttribute('tabindex'))
  expect(await page.evaluate(() => document.documentElement.classList.contains('kcms-browsing'))).toBe(true)

  await page.click('#jump')
  await page.waitUntil(() => location.hash === '#after')
  await page.click(TITLE)
  expect(await page.evaluate(() => [document.querySelector('h1')!.hasAttribute('contenteditable'), document.querySelector('.kcms-marker-menu') === null])).toEqual([false, true])

  await page.click('button[aria-label="Edit the page again"]')
  await page.waitUntil(() => document.querySelector('h1')!.getAttribute('tabindex') === '0' && document.querySelectorAll('.kcms-mark').length >= 2)
  await page.click(TITLE)
  await page.waitUntil((selector: string) => document.querySelector(selector)!.getAttribute('contenteditable') === 'plaintext-only', undefined, TITLE)
}, 60_000)

test('the role of a tab stop comes back after the text in it was typed', async () => {
  const page = await open()

  await addMarked(page, '<div id="plain" data-kay-field="posts:hello:title">Plain</div>')
  await page.waitUntil(() => document.querySelector('#plain')!.getAttribute('role') === 'button')
  await page.click('#plain')
  await page.waitUntil(() => document.querySelector('#plain')!.getAttribute('role') === 'textbox')
  await page.press('Enter')
  await page.waitUntil(() => document.querySelector('#plain')!.getAttribute('role') === 'button')
}, 60_000)

test('typing keeps the textbox role and the outline layer survives the page taking it away', async () => {
  const page = await open()

  await addMarked(page, '<div id="plain" data-kay-field="posts:hello:title">Plain</div>')
  await page.waitUntil(() => document.querySelector('#plain')!.getAttribute('role') === 'button')
  await page.click('#plain')
  await page.type('abc')
  await page.waitUntil(() => document.querySelector('.kcms-editor-status p') === null)
  expect(await page.evaluate(() => document.querySelector('#plain')!.getAttribute('role'))).toBe('textbox')
  await page.press('Enter')

  await page.click(OUTLINE_ALL)
  await page.waitUntil(() => document.querySelector('.kcms-marks') !== null)
  await page.evaluate(() => document.querySelector('.kcms-marks')!.remove())
  await page.evaluate(() => document.body.append(document.createElement('i')))
  await page.waitUntil(() => document.querySelectorAll('.kcms-mark').length >= 2)
}, 60_000)

test('the keyboard focus is outlined as an attribute marker, and the default outline state is not kept', async () => {
  const page = await open('unset')

  await addMarked(page, '<p id="alt" data-kay-field-title="posts:hello:title">Attribute</p>')
  await page.waitUntil(() => document.querySelector('#alt')!.getAttribute('tabindex') === '0')
  await page.evaluate(() => document.querySelector<HTMLElement>('#alt')!.focus())
  await page.waitUntil(() => document.querySelectorAll('.kcms-mark[data-focus]').length === 1)
  expect(await page.evaluate(() => localStorage.getItem('kcms-marks'))).toBeNull()
}, 60_000)

test('a click on an item chooses when the button takes no focus, as in Safari and macOS Firefox', async () => {
  const page = await open()

  await page.evaluate((selector: string) => document.querySelector(selector)!.setAttribute('data-kay-field-title', 'posts:hello:title'), TITLE)
  await page.click(TITLE)
  await page.waitUntil((selector: string) => document.activeElement === document.querySelector(`${selector} button`), undefined, MENU)

  // The focus leaves for nowhere (focusout with no relatedTarget), then the click lands on an item and on the padding beside it.
  await page.evaluate(() => (document.activeElement as HTMLElement).blur())
  expect(await page.evaluate((selector: string) => document.querySelector(selector) !== null, MENU)).toBe(true)
  await page.click(`${MENU} button:nth-child(2)`)
  await page.waitUntil(selector => document.querySelector(selector) === null, undefined, MENU)
}, 60_000)

test('a menu taller than its estimate still fits the window', async () => {
  const page = await open()

  await page.evaluate((selector: string) => {
    document.querySelector(selector)!.setAttribute('data-kay-field-title', 'posts:hello:title')
    document.head.insertAdjacentHTML('beforeend', '<style>.kcms-marker-item { min-height: 6rem !important }</style>')
  }, TITLE)
  await page.evaluate((selector: string) => {
    const box = document.querySelector(selector)!.getBoundingClientRect()

    document.querySelector(selector)!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: box.left + 2, clientY: innerHeight - 4 }))
  }, TITLE)
  await page.waitUntil((selector: string) => document.querySelector(selector) !== null, undefined, MENU)
  await page.waitUntil((selector: string) => document.querySelector(selector)!.getBoundingClientRect().bottom <= innerHeight + 0.5, undefined, MENU)
}, 60_000)

test('the hover frame reads the latest pointer and a pointer leaving cancels it', async () => {
  const page = await open()

  const move = (selector: string | undefined, leave: boolean) => page.evaluate((target: string | undefined, gone: boolean) => {
    const box = (target ? document.querySelector(target)! : document.documentElement).getBoundingClientRect()
    const element = target ? document.querySelector(target)! : document.body

    element.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: box.left + 4, clientY: box.top + 4 }))

    if (gone)
      document.documentElement.dispatchEvent(new PointerEvent('pointerleave'))
  }, selector, leave)
  const frames = () => page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))

  await move(TITLE, true)
  await frames()
  expect(await page.evaluate(() => document.querySelectorAll('.kcms-mark[data-hover]').length)).toBe(0)

  // Two moves in one frame: the second, off every field, is the one drawn.
  await move(TITLE, false)
  await move(undefined, false)
  await frames()
  expect(await page.evaluate(() => document.querySelectorAll('.kcms-mark[data-hover]').length)).toBe(0)
}, 60_000)

test('the focus outline survives the marks being made again and goes with a removed element', async () => {
  const page = await open()

  await addMarked(page, '<p id="alt" data-kay-field-title="posts:hello:title">Attribute</p>')
  await page.waitUntil(() => document.querySelector('#alt')!.getAttribute('tabindex') === '0')
  await page.evaluate(() => document.querySelector<HTMLElement>('#alt')!.focus())
  await page.waitUntil(() => document.querySelectorAll('.kcms-mark[data-focus]').length === 1)

  // Turning the outlines on makes the marks again; the button is clicked without taking the focus from the element.
  await page.evaluate((selector: string) => document.querySelector<HTMLElement>(selector)!.click(), OUTLINE_ALL)
  await page.waitUntil(() => document.querySelectorAll('.kcms-mark').length >= 2)
  expect(await page.evaluate(() => document.querySelectorAll('.kcms-mark[data-focus]').length)).toBe(1)

  await page.evaluate(() => document.querySelector('#alt')!.remove())
  await page.waitUntil(() => document.querySelectorAll('.kcms-mark[data-focus]').length === 0)
}, 60_000)

test('a tab stop that gains children loses its button role, and a focus rewrites nothing that did not change', async () => {
  const page = await open()

  await addMarked(page, '<div id="plain" data-kay-field="posts:hello:title">Plain</div>')
  await page.waitUntil(() => document.querySelector('#plain')!.getAttribute('role') === 'button')

  await page.evaluate(() => document.querySelector<HTMLElement>('#plain')!.focus())
  await page.evaluate(() => {
    const seen: string[] = []

    Object.assign(window, { seen })
    new MutationObserver(records => seen.push(...records.map(record => record.attributeName!))).observe(document.querySelector('#plain')!, { attributes: true })
  })
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('h1')!.focus()
    document.querySelector<HTMLElement>('#plain')!.focus()
  })
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => done())))
  expect(await page.evaluate(() => (window as unknown as { seen: string[] }).seen)).toEqual([])

  await page.evaluate(() => document.querySelector('#plain')!.append(document.createElement('b')))
  await page.waitUntil(() => !document.querySelector('#plain')!.hasAttribute('role'))
}, 60_000)
