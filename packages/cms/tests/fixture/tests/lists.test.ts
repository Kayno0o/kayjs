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
// The size a bar is counted as when it is placed above or below its item (BAR_WIDTH, BAR_HEIGHT of page-lists.ts).
const BAR_WIDTH = 240
const BAR_HEIGHT = 30
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

// Waits until the bars have kept their boxes for a few frames, so a box read next is not one of a bar still moving to its place, which takes longer on a loaded machine. Not for a click next: the tooltip of the last button pressed shows over the new bar meanwhile.
function barsStill(page: Page) {
  return page.evaluate(() => new Promise<void>((resolve) => {
    let last = ''
    let same = 0
    const check = () => {
      const now = [...document.querySelectorAll('.kcms-list-bar')].map((bar) => {
        const { left, top, width, height } = bar.getBoundingClientRect()

        return `${left},${top},${width},${height}`
      }).join('|')

      same = now === last ? same + 1 : 0
      last = now

      if (same >= 3)
        resolve()
      else
        requestAnimationFrame(check)
    }

    check()
  }))
}

// The tooltip of the button last pressed stays while the pointer rests on it, and can cover a button of the next bar for as long as it is open, so a click right after fails as covered. The pointer is sent off it and the wait ends when it has closed.
async function closeTooltip(page: Page) {
  await page.evaluate(() => document.body.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })))
  await page.waitUntil(() => document.querySelector('#kui-tooltip:popover-open') === null)
}

// The editor docks at the bottom of a short window, so the item is scrolled to the top, clear of it, and the pointer is moved onto it there (a hover would scroll it back to the middle, under the editor's edge).
async function showBar(page: Page, selector: string, bars = 1) {
  await closeTooltip(page)
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
  await page.waitUntil(() => document.activeElement?.matches('ol.steps li, ol.first li') === true)

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

const TITLE = '[data-kcms-path="title"] input'
const FOLDS = '[data-kcms-path="columns"] [data-kcms-fold]'
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const folds = (page: Page) => page.evaluate((selector: string) => [...document.querySelectorAll(selector)].map(button => button.getAttribute('aria-expanded')), FOLDS)

// Types into the title as the form would, and clicks `selector` at once, in the render's pause.
function typeThen(page: Page, selector: string) {
  return page.evaluate((title: string, target: string) => {
    const input = document.querySelector<HTMLInputElement>(title)!

    input.focus()
    input.value = 'Intro!'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector<HTMLElement>(target)!.click()
  }, TITLE, selector)
}

test('the bars stay while a field of the form is typed in', async () => {
  const page = await open()

  await showBar(page, 'ol.steps li:first-child')
  await page.evaluate((title: string) => {
    const seen = { least: Infinity }

    Object.assign(window, { seen })

    const sample = () => {
      seen.least = Math.min(seen.least, document.querySelectorAll('.kcms-list-bar').length)
      requestAnimationFrame(sample)
    }

    sample()
    document.querySelector<HTMLInputElement>(title)!.focus()
  }, TITLE)
  await page.press('x')
  await page.waitUntil(() => document.querySelector('h1')!.textContent!.endsWith('x'))
  await pause(400)
  expect(await page.evaluate(() => (window as unknown as { seen: { least: number } }).seen.least)).toBe(1)
}, 60_000)

test('an action is refused in the pause before the page renders what was typed', async () => {
  const page = await open()

  await showBar(page, 'ol.steps li:first-child')
  await typeThen(page, REMOVE)
  await page.waitUntil(() => document.querySelector('h1')!.textContent === 'Intro!')
  await pause(300)
  expect(await texts(page, 'ol.steps li')).toEqual(['Open', 'Edit'])
  expect(await formSteps(page)).toEqual(['Open', 'Edit'])

  await showBar(page, 'ol.steps li:first-child')
  await page.click(REMOVE)
  await page.waitUntil(() => document.querySelectorAll('ol.steps li').length === 1)
}, 60_000)

test('the form\'s folds follow an add, a move and a remove made on the page', async () => {
  const page = await open()
  const section = '.columns .column:first-child h2'
  // The item an action moved holds the focus, which shows its bar too.
  const hover = async () => {
    // The page may render again and the focus come back to an item, so the focus is dropped and the pointer moved onto the item at every try.
    await page.waitUntil((target: string) => {
      const element = document.querySelector(target)!

      ;(document.activeElement as HTMLElement | null)?.blur()
      const box = element.getBoundingClientRect()

      element.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: box.left + 4, clientY: box.top + box.height / 2 }))

      return document.querySelectorAll('.kcms-list-bar').length === 1
    }, undefined, section)
  }

  await page.waitUntil((selector: string) => document.querySelectorAll(selector).length === 2, undefined, FOLDS)
  await page.evaluate((selector: string) => document.querySelector<HTMLElement>(selector)!.click(), FOLDS)
  expect(await folds(page)).toEqual(['false', 'true'])

  await hover()
  await page.click(DOWN)
  await page.waitUntil(() => document.querySelector('.columns h2')!.textContent === 'Right')
  expect(await folds(page)).toEqual(['true', 'false'])

  await hover()
  await page.click(ADD)
  await page.waitUntil(() => document.querySelectorAll('.columns .column').length === 3)
  expect(await folds(page)).toEqual(['true', 'true', 'false'])

  await hover()
  await page.click(REMOVE)
  await page.waitUntil(() => document.querySelectorAll('.columns .column').length === 2)
  expect(await folds(page)).toEqual(['true', 'false'])
}, 60_000)

test('a list the page shows twice, the first time in part, is found where the item is', async () => {
  const page = await open()

  await showBar(page, 'ol.steps li:first-child')
  await page.click(DOWN)
  await page.waitUntil(() => document.activeElement?.textContent === 'Open' && document.activeElement.matches('ol.steps li'))
}, 60_000)

test('the bar sits inside the window\'s scrollbars and above the docked editor', async () => {
  const page = await open()

  await showBar(page, 'ol.steps li:first-child')
  // The bar settles on the item's right edge a frame or two after it shows, later on a loaded machine.
  await page.waitUntil(() => Math.abs(document.querySelector('.kcms-list-bar')!.getBoundingClientRect().right - document.querySelector('ol.steps li')!.getBoundingClientRect().right) < 1)

  // The item lies under the editor: the bar stays above its edge.
  await page.evaluate(() => {
    const panel = document.querySelector('.kcms-editor-open')!.getBoundingClientRect()
    const element = document.querySelector('ul.limited li')!

    window.scrollBy({ top: element.getBoundingClientRect().top - (panel.top + 8) })
  })
  // The pointer is moved onto the item again at each poll: the bar follows the pointer a frame after it moves, and the editor docking or the scroll settling on a loaded machine can leave the first move on something else.
  await page.waitUntil(() => {
    const element = document.querySelector('ul.limited li')!
    const box = element.getBoundingClientRect()

    element.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: box.left + 4, clientY: box.top + 4 }))

    const bars = document.querySelectorAll('.kcms-list-bar')

    return bars.length === 1 && bars[0]!.getBoundingClientRect().bottom <= document.querySelector('.kcms-editor-open')!.getBoundingClientRect().top + 0.5
  })
}, 60_000)

interface Box { left: number, right: number, top: number, bottom: number }

// The boxes of the first element each selector matches.
function boxes(page: Page, ...selectors: string[]) {
  return page.evaluate((all: string[]) => all.map((selector) => {
    const { left, right, top, bottom } = document.querySelector(selector)!.getBoundingClientRect()

    return { left, right, top, bottom }
  }), selectors) as Promise<Box[]>
}

const overlaps = (a: Box, b: Box) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5

// Scrolls the item to `top` pixels under the window's top and puts the pointer on it.
async function showBarAt(page: Page, selector: string, top: number, bars = 1) {
  await page.evaluate((target: string, at: number) => {
    const element = document.querySelector(target)!

    window.scrollBy({ top: element.getBoundingClientRect().top - at })

    const box = element.getBoundingClientRect()

    element.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: box.left + 4, clientY: box.top + box.height / 2 }))
  }, selector, top)
  await page.waitUntil((count: number) => document.querySelectorAll('.kcms-list-bar').length === count, undefined, bars)
  await barsStill(page)
}

// Whether the element at the item's top left corner is the item or inside it, so the pointer that called the bar still reaches the page.
function pointerOnItem(page: Page, selector: string) {
  return page.evaluate((target: string) => {
    const box = document.querySelector(target)!.getBoundingClientRect()

    return document.elementFromPoint(box.left + 2, box.top + 2)?.closest(target) != null
  }, selector)
}

test('the bar sits above its item\'s top right corner, below it with no room above, and never over the item or the pointer', async () => {
  const page = await open()

  await showBarAt(page, 'ol.steps li:first-child', 120)

  const [item, bar] = await boxes(page, 'ol.steps li:first-child', BAR) as [Box, Box]

  expect(bar.bottom).toBeLessThanOrEqual(item.top + 0.5)
  expect(Math.abs(bar.right - item.right)).toBeLessThan(1)
  expect(await pointerOnItem(page, 'ol.steps li:first-child')).toBe(true)

  await showBar(page, 'ol.steps li:first-child')
  await barsStill(page)

  const [top, under] = await boxes(page, 'ol.steps li:first-child', BAR) as [Box, Box]

  expect(under.top).toBeGreaterThanOrEqual(top.bottom - 0.5)
}, 60_000)

test('the bar of a small item, a chip say, covers no part of it', async () => {
  const page = await open()

  await page.evaluate(() => {
    const style = document.createElement('style')

    style.textContent = 'ol.steps li { display: inline-block; margin: 0 1rem 0 0 }'
    document.head.append(style)
  })
  await showBarAt(page, 'ol.steps li:first-child', 120)

  const [chip, bar] = await boxes(page, 'ol.steps li:first-child', BAR) as [Box, Box]

  expect(overlaps(chip, bar)).toBe(false)
  expect(await pointerOnItem(page, 'ol.steps li:first-child')).toBe(true)
}, 60_000)

test('an item at the window\'s left edge gets a bar that stays in the window', async () => {
  const page = await open()

  await page.evaluate(() => {
    const style = document.createElement('style')

    style.textContent = 'ol.steps { padding: 0; margin: 0; list-style: none } ol.steps li { width: 3rem }'
    document.head.append(style)
  })
  await showBarAt(page, 'ol.steps li:first-child', 120)

  const [item, bar] = await boxes(page, 'ol.steps li:first-child', BAR) as [Box, Box]

  expect(bar.left).toBeGreaterThanOrEqual(0)
  expect(overlaps(item, bar)).toBe(false)
}, 60_000)

test('nested bars stack outside their items, covering neither each other nor the item they act on', async () => {
  const page = await open()

  await showBarAt(page, '.columns .cells li:first-child', 150, 2)

  const [cell, column, inner, outer] = await boxes(page, '.columns .cells li:first-child', '.columns .column:first-child', `${BAR}:nth-child(1)`, `${BAR}:nth-child(2)`) as [Box, Box, Box, Box]

  expect(overlaps(cell, inner)).toBe(false)
  expect(overlaps(column, outer)).toBe(false)
  expect(overlaps(inner, outer)).toBe(false)
}, 60_000)

test('the focus on an item puts its bar outside it as well', async () => {
  const page = await open()

  await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>('ol.steps li')!

    window.scrollBy({ top: element.getBoundingClientRect().top - 120 })
    element.focus()
  })
  await page.waitUntil(() => document.querySelector('.kcms-list-bar') !== null)

  const [item, bar] = await boxes(page, 'ol.steps li:first-child', BAR) as [Box, Box]

  expect(overlaps(item, bar)).toBe(false)
}, 60_000)

const captions = (page: Page) => page.evaluate(() => [...document.querySelectorAll('.kcms-list-bar')].map(bar => bar.querySelector('.kcms-list-caption')?.textContent))

test('each bar says which list and item it acts on, nested ones apart', async () => {
  const page = await open()

  await showBarAt(page, 'ol.steps li:first-child', 120)
  expect(await captions(page)).toEqual(['Steps: Item 1'])
  expect(await page.evaluate(() => document.querySelector('.kcms-list-bar')!.getAttribute('aria-label'))).toBe('Item 1, of Steps')

  await showBarAt(page, '.columns .cells li:first-child', 150, 2)

  const [inner, outer] = await captions(page) as [string, string]

  expect(inner).toMatch(/^Cells: /)
  expect(outer).toMatch(/^Columns: /)
  expect(outer).toContain('Left')
}, 60_000)

test('a long caption is cut with an ellipsis and the bar stays in its room', async () => {
  const page = await open()

  await showBarAt(page, 'ol.steps li:first-child', 120)
  await page.evaluate(() => {
    document.querySelector('.kcms-list-caption')!.textContent = 'A very long title of a list, with an item title longer still'
  })

  const [style, bar] = await page.evaluate(() => {
    const caption = getComputedStyle(document.querySelector('.kcms-list-caption')!)

    return [[caption.textOverflow, caption.whiteSpace], document.querySelector('.kcms-list-bar')!.getBoundingClientRect().width]
  }) as [string[], number]

  expect(style).toEqual(['ellipsis', 'nowrap'])
  expect(bar).toBeLessThanOrEqual(BAR_WIDTH)
}, 60_000)

test('a bar outlines its item on the page while the pointer or the focus is on it, without moving the page', async () => {
  const page = await open()
  const outline = () => page.evaluate(() => {
    const element = document.querySelector('.kcms-list-outline')

    if (!element || getComputedStyle(element).display === 'none')
      return undefined

    const { left, top, width, height } = element.getBoundingClientRect()
    const item = document.querySelector('ol.steps li')!.getBoundingClientRect()

    return { same: [left - item.left, top - item.top, width - item.width, height - item.height].every(gap => Math.abs(gap) < 1), page: document.documentElement.scrollHeight }
  })

  await showBarAt(page, 'ol.steps li:first-child', 120)

  const before = await page.evaluate(() => document.documentElement.scrollHeight)

  expect(await outline()).toBeUndefined()
  await page.hover(`${BAR} button:nth-child(2)`)
  await page.waitUntil(() => document.querySelector('.kcms-list-outline') !== null && getComputedStyle(document.querySelector('.kcms-list-outline')!).display !== 'none')
  expect(await outline()).toEqual({ same: true, page: before })

  // Off the bar, onto the page elsewhere: the bar goes with the pointer's item, and its outline with it.
  await page.hover('h1')
  await page.waitUntil(() => document.querySelector('.kcms-list-bar') === null)
  expect(await outline()).toBeUndefined()

  await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>('ol.steps li')!

    window.scrollBy({ top: element.getBoundingClientRect().top - 120 })
    element.focus()
  })
  await page.waitUntil(() => document.querySelector('.kcms-list-bar') !== null)
  await page.press('Tab')
  await page.waitUntil(() => document.activeElement?.closest('.kcms-list-bar') != null)
  expect((await outline())?.same).toBe(true)
}, 60_000)

test('a bar stays within the size the places above and below its item count on', async () => {
  const page = await open()

  await showBarAt(page, 'ol.steps li:first-child', 120)

  const [bar] = await boxes(page, BAR) as [Box]

  expect(bar.right - bar.left).toBeLessThanOrEqual(BAR_WIDTH)
  expect(bar.bottom - bar.top).toBeLessThanOrEqual(BAR_HEIGHT)
}, 60_000)

test('Tab goes from an item to its bar and on, Shift+Tab comes back', async () => {
  const page = await open()
  const inBar = () => page.evaluate(() => document.activeElement?.closest('.kcms-list-bar') != null)

  await page.evaluate(() => document.querySelector<HTMLElement>('ol.steps li')!.focus())
  await page.waitUntil(() => document.querySelector('.kcms-list-bar') !== null)
  await page.press('Tab')
  await page.waitUntil(() => document.activeElement?.closest('.kcms-list-bar') != null)
  expect(await barCount(page)).toBe(1)
  expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toContain('down')
  await page.press('Tab', { modifiers: ['Shift'] } as never)
  await page.waitUntil(() => document.activeElement?.matches('ol.steps li, ol.first li') === true)

  await page.press('Tab')
  await page.waitUntil(() => document.activeElement?.closest('.kcms-list-bar') != null)
  await page.press('Tab')
  await page.press('Tab')
  expect(await inBar()).toBe(true)
  await page.press('Tab')
  await page.waitUntil(() => document.activeElement?.textContent === 'Edit' && document.activeElement.matches('ol.steps li'))
}, 60_000)

test('the outlines are not drawn again for the bars', async () => {
  const page = await open()

  await page.evaluate(() => localStorage.setItem('kcms-marks', 'on'))
  await page.reload()
  await page.waitUntil(() => document.querySelector('.kcms-marks')?.childElementCount)
  await showBar(page, 'ol.steps li:first-child')
  await pause(200)

  const drawn = await page.evaluate(async () => {
    let count = 0
    const watch = new MutationObserver((records) => {
      count += records.length
    })

    watch.observe(document.querySelector('.kcms-marks')!, { childList: true })
    document.querySelector('.kcms-list-bar')!.setAttribute('data-moved', '')
    await new Promise(resolve => setTimeout(resolve, 300))
    watch.disconnect()

    return count
  })

  expect(drawn).toBe(0)
}, 60_000)

test('an empty list keeps the tab stop and role the page gave it', async () => {
  const page = await open()

  await showBar(page, 'ul.named li')
  await page.click(REMOVE)
  await page.waitUntil(() => document.querySelector('ul.named')!.getAttribute('aria-label') !== null)
  expect(await page.evaluate(() => ['tabindex', 'role'].map(name => document.querySelector('ul.named')!.getAttribute(name)))).toEqual(['-1', 'list'])
}, 60_000)

test('an item the draft\'s issues keep the page from showing takes the focus in the form', async () => {
  const page = await open()

  // The page shows the saved list until the new blank item is valid, so its first item is not the new one.
  await page.evaluate(() => document.querySelector<HTMLElement>('ul.named li')!.focus())
  await page.press('Enter', ALT_SHIFT)
  await page.waitUntil((selector: string) => document.activeElement === document.querySelector(`${selector} button`), undefined, MENU)
  await page.press('Enter')
  await page.waitUntil(() => document.activeElement?.closest('[data-kcms-path="named.0"]') != null)
  expect(await texts(page, 'ul.named li')).toEqual(['Fine'])
}, 60_000)

test('Alt and Shift keep their meaning in a text box inside an item', async () => {
  const page = await open()

  await page.evaluate(() => document.querySelector<HTMLElement>('ul.limited li input')!.focus())
  await page.press('Delete', ALT_SHIFT)
  await pause(500)
  expect(await page.evaluate(() => document.querySelectorAll('ul.limited li').length)).toBe(2)
}, 60_000)

test('an item taken out cannot be put back once its entry left the page', async () => {
  const page = await open()

  await showBar(page, 'ol.steps li:first-child')
  await page.click(REMOVE)
  await page.waitUntil(() => document.querySelector('.kcms-editor-undo') !== null)
  // Unsaved edits hold the page, so they are reset first: the notice stays, as only a change of entry takes it away.
  await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.kcms-editor button')].find(button => button.textContent === 'Reset')!.click())
  await page.waitUntil(() => document.querySelector('dialog[open] .kui-btn-accent') !== null)
  await page.evaluate(() => document.querySelector<HTMLElement>('dialog[open] .kui-btn-accent')!.click())
  await page.waitUntil(() => document.querySelectorAll('ol.steps li').length === 2)
  expect(await page.evaluate(() => document.querySelector('.kcms-editor-undo') !== null)).toBe(true)
  await page.evaluate(() => document.querySelector<HTMLElement>('a.out')!.click())
  await page.waitUntil(() => document.querySelector('a.out') === null)
  await pause(300)
  expect(await page.evaluate(() => document.querySelector('.kcms-editor-undo'))).toBeNull()
}, 60_000)

test('the keyboard and the undo act on the innermost list of nested ones', async () => {
  const page = await open()
  const cells = () => texts(page, '.columns .column:first-child .cells li')

  await page.waitUntil(() => document.querySelector('.columns .cells li[tabindex]') !== null)
  await page.evaluate(() => document.querySelector<HTMLElement>('.columns .cells li')!.focus())
  await page.press('ArrowDown', ALT_SHIFT)
  await page.waitUntil(() => document.querySelector('.columns .cells li')!.textContent === 'L2')
  expect(await cells()).toEqual(['L2', 'L1'])
  expect(await texts(page, '.columns h2')).toEqual(['Left', 'Right'])

  await page.waitUntil(() => document.activeElement?.textContent === 'L1' && document.activeElement.matches('.cells li'))
  await page.evaluate(() => document.querySelector<HTMLElement>('.columns .cells li')!.focus())
  await page.press('Delete', ALT_SHIFT)
  await page.waitUntil(() => document.querySelectorAll('.columns .column:first-child .cells li').length === 1)
  await page.waitUntil(() => document.querySelector<HTMLButtonElement>('.kcms-editor-undo button')?.disabled === false)
  await page.click('.kcms-editor-undo button')
  await page.waitUntil(() => document.querySelectorAll('.columns .column:first-child .cells li').length === 2)
  expect(await cells()).toEqual(['L2', 'L1'])
  expect(await texts(page, '.columns h2')).toEqual(['Left', 'Right'])
  expect(await texts(page, '.columns .column:last-child .cells li')).toEqual(['R1'])
}, 60_000)
