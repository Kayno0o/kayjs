import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, test } from 'bun:test'
import { browserPath, testSite } from 'kay/test'

const ROOT = join(import.meta.dir, '..')
const path = browserPath()
// The server's control, described by its own note and the hint it renders after it.
const SERVED = /aria-describedby="name-note (k[\w-]+)">.*class="kui-form-field-hint" id="\1"/
// What the controls of the form-reset page hold when it loads.
const START = { agree: true, power: false, free: false, decks: ['films'], size: 'm', sort: null, level: 'b', tags: ['x', 'y'], title: 'Ada', bio: 'Hello', notes: '# Notes', range: [2, 8], icon: 'star', bare: 'star', heard: 'b', refd: true, form: 'x' }
// One site and one browser for every test of the file; each test opens and closes its own page.
let built: ReturnType<typeof testSite> | undefined
const shared = async () => built ??= testSite({ root: ROOT, browser: { path } })

afterAll(async () => {
  if (built)
    (await built).close()
})

// CI installs Chromium: there, a missing browser fails rather than skipping.
const inBrowser = describe.skipIf(path === undefined && (process.env.CI ?? '') === '')

inBrowser('in the browser', () => {
  test('Table starts every value of a stacked card at one edge, and keeps a wide column aligned to its end', async () => {
    const site = await shared()

    await using page = await site.open('/stacked')
    // Where the text of each cell of a table's first row starts and ends, and where its cell's content box ends.
    const edges = (selector: string) => page.evaluate((within: string) => [...document.querySelectorAll(`${within} .kui-table-row:first-child .kui-table-cell-body`)].map((body) => {
      const text = document.createRange()
      const cell = body.closest('td')!

      text.selectNodeContents(body)

      return { start: Math.round(text.getBoundingClientRect().left), end: Math.round(text.getBoundingClientRect().right), cellEnd: Math.round(cell.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(cell).paddingRight)) }
    }), selector)
    const [name, moons] = await edges('#narrow')

    expect(moons!.start).toBe(name!.start)
    expect(moons!.end).toBeLessThan(moons!.cellEnd)
    const [, wide] = await edges('#wide')

    expect(wide!.end).toBe(wide!.cellEnd)
    expect(page.errors).toEqual([])
  }, 120_000)

  test('Table with no rows hydrates on the markup the server rendered, an @empty slot alone or beside selectable and @bulk', async () => {
    const site = await shared()

    await using page = await site.open('/empty-table')

    expect(await page.count('.kui-empty-state-title')).toBe(2)
    expect(page.errors).toEqual([])
  }, 120_000)

  test('Table keeps a long unbroken value inside its stacked card, and its sort button 2rem tall', async () => {
    const site = await shared()

    await using page = await site.open('/stacked')
    const measured = await page.evaluate(() => {
      const card = document.querySelector('#long .kui-table-row')!.getBoundingClientRect()
      const value = document.querySelector('#long .kui-table-cell-body')!.getBoundingClientRect()

      return { cardEnd: card.right, valueEnd: value.right, sortHeight: document.querySelector('#long .kui-table-sort-btn')!.getBoundingClientRect().height, rem: Number.parseFloat(getComputedStyle(document.documentElement).fontSize) }
    })

    expect(measured.valueEnd).toBeLessThanOrEqual(measured.cardEnd)
    expect(measured.sortHeight).toBeGreaterThanOrEqual(2 * measured.rem)
  }, 120_000)
})

inBrowser('FormField in an island', () => {
  test('hydrates over the ids the server handed its control, then links the message once one shows', async () => {
    const site = await shared()
    const served = (await site.visit('/described')).html

    await using page = await site.open('/described')
    const read = async () => page.evaluate(() => {
      const input = document.querySelector('#name')!

      return { described: input.getAttribute('aria-describedby'), invalid: input.getAttribute('aria-invalid'), hint: document.querySelector('.kui-form-field-hint')!.id, issues: document.querySelector('.kui-form-field-issues')!.getAttribute('id') }
    })
    const hydrated = await read()

    expect(served).toMatch(SERVED)
    expect(hydrated).toEqual({ described: `name-note ${hydrated.hint}`, invalid: null, hint: hydrated.hint, issues: null })

    await page.click('#refuse')
    await page.waitUntil(() => document.querySelector('#name')!.getAttribute('aria-invalid') === 'true')

    const refused = await read()

    expect(refused.issues).not.toBeNull()
    expect(refused.described).toBe(`name-note ${hydrated.hint} ${refused.issues}`)
    expect(page.errors).toEqual([])
  }, 120_000)

  test('keeps its hint beside the message of a refused post once the island hydrates, and as the field turns valid and refused again', async () => {
    const site = await shared()

    await using page = await site.open('/described-form')
    const read = async () => page.evaluate(() => {
      const input = document.querySelector('#claim input[name="handle"]')!

      return { described: input.getAttribute('aria-describedby'), hint: document.querySelector('.kui-form-field-hint')!.id }
    })

    await page.fill('#claim input[name="handle"]', 'ab')
    await page.click('#post')
    await page.waitFor('#claim-handle-error')
    // A click the island answers tells it hydrated.
    await page.click('#bump')
    await page.waitFor('#bump', { text: '1' })

    const refused = await read()

    expect(refused.described?.split(' ').toSorted()).toEqual(['claim-handle-error', refused.hint].toSorted())

    await page.click('#accept')
    await page.waitUntil(() => document.querySelector('#claim-handle-error') === null)

    expect((await read()).described).toBe(refused.hint)

    await page.click('#refuse')
    await page.waitUntil(() => document.querySelector('#claim-handle-error') !== null)

    expect((await read()).described).toBe(`${refused.hint} claim-handle-error`)
    expect(page.errors).toEqual([])
  }, 120_000)

  test('keeps a refused field invalid while its FormField or group shows a message, and drops the mark once neither the action nor the FormField refuses it', async () => {
    const site = await shared()

    await using page = await site.open('/invalid-form')
    // Presses a button, then waits for the action's message and the FormField's to show as asked, answering the marks of the field and of the group's.
    const press = async (button: string, refused: boolean, issue: boolean) => {
      await page.click(button)
      await page.waitUntil((refused, issue) => (document.querySelector('#claim-handle-error') !== null) === refused && (document.querySelector('.kui-form-field-issue') !== null) === issue, {}, refused, issue)

      return page.evaluate(() => ['#claim', '#grouped'].map(form => document.querySelector(`${form} input[name="handle"]`)!.getAttribute('aria-invalid')))
    }

    await page.fill('#claim input[name="handle"]', 'ab')
    await page.click('#post')
    await page.waitFor('#claim-handle-error')
    // A click the island answers tells it hydrated.
    await page.click('#bump')
    await page.waitFor('#bump', { text: '1' })

    // The mark the server rendered for the refusal is the action's own, dropped once it is accepted.
    expect(await press('#accept', false, false)).toEqual([null, null])
    expect(await press('#refuse', true, false)).toEqual(['true', 'true'])
    expect(await press('#show', true, true)).toEqual(['true', 'true'])
    expect(await press('#accept', false, true)).toEqual(['true', 'true'])
    expect(await press('#hide', false, false)).toEqual([null, null])
    expect(await press('#show', false, true)).toEqual(['true', 'true'])
    expect(await press('#refuse', true, true)).toEqual(['true', 'true'])
    expect(await press('#hide', true, false)).toEqual(['true', 'true'])
    expect(await press('#accept', false, false)).toEqual([null, null])
    expect(page.errors).toEqual([])
  }, 120_000)
})

inBrowser('a form reset on a served page', () => {
  test('puts every control of the hydrated page, a field named form and a Segmented with none picked included, back on its start', async () => {
    const site = await shared()

    await using page = await site.open('/form-reset')
    const state = async () => page.evaluate(() => JSON.parse(document.querySelector('#state')!.textContent!) as Record<string, unknown>)

    expect(await state()).toEqual(START)

    await page.evaluate(() => {
      const click = (selector: string) => document.querySelector<HTMLElement>(selector)!.click()
      const type = (selector: string, value: string, event = 'input') => {
        const field = document.querySelector<HTMLInputElement>(selector)!

        field.value = value
        field.dispatchEvent(new Event(event, { bubbles: true }))
      }

      click('input[name="agree"]')
      click('input[name="power"]')
      click('#free')
      click('input[name="decks"][value="games"]')
      click('input[name="decks"][value="films"]')
      click('input[name="size"][value="l"]')
      click('input[name="sort"][value="l"]')
      type('#level', 'c', 'change')
      document.querySelectorAll<HTMLElement>('.kui-multi-select-checkbox')[0]!.click()
      document.querySelectorAll<HTMLElement>('.kui-multi-select-checkbox')[2]!.click()
      type('#title', 'Grace')
      type('#bio', 'Bye')
      type('#notes', '# Other')
      type('input[aria-label="Range from"]', '4', 'change')
      type('input[aria-label="Range to"]', '9', 'change')
      click('#named .kui-icon-grid-option[aria-label="moon"]')
      click('#bare .kui-icon-grid-option[aria-label="moon"]')
      type('#fixed', 'a', 'change')
      type('#formname', 'y')
      type('#bare input[type="search"]', 'mo')
    })
    await page.waitUntil(() => JSON.parse(document.querySelector('#state')!.textContent!).form === 'y')

    expect(await state()).toMatchObject({ agree: false, power: true, free: true, decks: ['games'], size: 'l', sort: 'l', level: 'c', title: 'Grace', form: 'y', icon: 'moon' })

    await page.click('#reset')
    await page.waitUntil(() => JSON.parse(document.querySelector('#state')!.textContent!).form === 'x')

    expect(await state()).toEqual(START)
    expect(await page.evaluate(() => [...new FormData(document.querySelector('form')!)].map(([name, value]) => `${name}=${String(value)}`).sort())).toEqual(['agree=on', 'bio=Hello', 'decks=films', 'form=x', 'icon=star', 'level=b', 'size=m', 'tags=x', 'tags=y', 'title=Ada'])
    expect(await page.evaluate(() => document.querySelectorAll('input[name="sort"]:checked').length)).toBe(0)
    expect(await page.value('#bare input[type="search"]')).toBe('')
    expect(page.errors).toEqual([])
  }, 120_000)

  test('hands the app\'s ref the element of a hydrated control once, however often its attributes change', async () => {
    const site = await shared()

    await using page = await site.open('/form-reset-ref')

    await page.click('#change')
    await page.waitUntil(() => document.querySelector<HTMLInputElement>('input[name="title"]')!.placeholder === 'b')

    expect(await page.evaluate(() => (window as unknown as { refs: string[] }).refs.sort())).toEqual(['icon', 'markdown', 'plain-first', 'select', 'text', 'textarea'])
  }, 120_000)
})

inBrowser('a Segmented busy with a change on a served page', () => {
  test('moves focus back to the checked radio when a pick made by key or click is taken, so focus and the check agree', async () => {
    const site = await shared()

    await using page = await site.open('/segmented-busy')
    const state = async () => page.evaluate(() => ({
      checked: document.querySelector<HTMLInputElement>('input[name="size"]:checked')?.value,
      focused: (document.activeElement as HTMLInputElement | null)?.value,
    }))

    await page.evaluate(() => document.querySelector<HTMLInputElement>('input[value="m"]')!.focus())
    await page.press('ArrowRight')
    await page.waitUntil(() => (window as unknown as { held?: string }).held === 'l')

    // The pick under way is shown as made, and focus is on it.
    expect(await state()).toEqual({ checked: 'l', focused: 'l' })

    // A pick while busy takes nothing: the check goes back and focus goes with it.
    await page.press('ArrowLeft')
    expect(await state()).toEqual({ checked: 'l', focused: 'l' })
    await page.press('ArrowLeft')
    await page.click('.kui-segmented-option:first-child .kui-segmented-label')
    expect(await state()).toEqual({ checked: 'l', focused: 'l' })

    // The refusal puts the first option back, and focus follows it.
    await page.evaluate(() => document.querySelector<HTMLElement>('#release')!.click())
    await page.waitUntil(() => document.querySelector<HTMLInputElement>('input[name="size"]:checked')!.value === 'm')

    expect(await state()).toEqual({ checked: 'm', focused: 'm' })
    expect(page.errors).toEqual([])
  }, 120_000)

  test('leaves focus alone when it has moved off the group before the refusal', async () => {
    const site = await shared()

    await using page = await site.open('/segmented-busy')

    await page.click('.kui-segmented-option:last-child .kui-segmented-label')
    await page.waitUntil(() => (window as unknown as { held?: string }).held === 'l')
    await page.click('#release')
    await page.waitUntil(() => document.querySelector<HTMLInputElement>('input[name="size"]:checked')!.value === 'm')

    expect(await page.evaluate(() => document.activeElement?.id)).toBe('release')
    expect(page.errors).toEqual([])
  }, 120_000)
})

inBrowser('a SaveForm passed an action by a page with a server fence', () => {
  test('calls the action as if the island had imported it, toasting what the page said and what the schema refused', async () => {
    const site = await shared()

    await using page = await site.open('/save-form-action')

    await page.fill('#name', 'Grace')
    await page.click('button[type="submit"]')
    await page.waitFor('.kui-toast-message', { text: 'Saved.' })

    await page.fill('#name', 'G')
    await page.click('button[type="submit"]')
    await page.waitFor('.kui-toast-message', { text: 'Two letters at least' })
    expect(page.errors).toEqual([])
  }, 120_000)
})
