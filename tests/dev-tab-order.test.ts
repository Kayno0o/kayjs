import type { TestSite } from '../src/test'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { browserPath, testSite } from '../src/test'

const path = browserPath()

// The overlay's badges and the tab order problems the tool lists, read in the page.
function overlay() {
  const root = document.querySelector('kay-dev')!.shadowRoot!

  return {
    badges: [...root.querySelectorAll('.tab-badge')].map(badge => [badge.textContent, badge.className.replace('tab-badge', '').trim()]),
    lines: root.querySelectorAll('.tab-order path').length,
    jumps: root.querySelectorAll('.tab-order path.jump').length,
    traps: root.querySelectorAll('.tab-trap').length,
    problems: [...root.querySelectorAll('#kay-dev-problems .problem pre')].map(pre => pre.textContent.split('\n').slice(0, -1).join('\n')).filter(text => (/^a11y (?:tab-order|focus-not|keyboard)/).test(text)),
  }
}

describe.skipIf(path === undefined)('the tab order overlay of the dev tool', () => {
  let dev: TestSite

  beforeAll(async () => {
    dev = await testSite({ routes: 'tests/fixtures/dev-tab-order/src/routes', browser: { path }, dev: true, onError: () => undefined })
  }, 60_000)

  afterAll(async () => dev?.close())

  it('numbers each element the keyboard reaches in Tab order, draws a line between them and flags what goes wrong', async () => {
    const page = await dev.open('/', { strict: false })

    expect(await page.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('.tab-badge').length)).toBe(0)
    await page.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLButtonElement>('.head button[title="Show the tab order"]')!.click())
    await page.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('#kay-dev-problems .problem').length >= 4)

    const shown = await page.evaluate(overlay)

    // The element with a positive tabindex first, then the rest in the document's order, the inert one left out.
    expect(shown.badges).toEqual([['1', ''], ['2 !', 'jump'], ['3', ''], ['4', ''], ['5 !', 'hidden-focus'], ['6', '']])
    expect(shown.lines).toBe(5)
    expect(shown.jumps).toBe(1)
    expect(shown.traps).toBe(2)
    expect(shown.problems.map(problem => problem.slice(0, problem.indexOf(': ')))).toEqual(['a11y tab-order-jump', 'a11y focus-not-visible', 'a11y keyboard-trap', 'a11y keyboard-trap'])
    expect(shown.problems.map(problem => problem.split('\n').slice(1))).toEqual([['  body > main > slot > button'], ['  body > main > button:nth-of-type(2)'], ['  body > main > div:nth-of-type(2)'], ['  body > main > div:nth-of-type(1)']])
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true)
  }, 60_000)

  it('follows a page swap and goes when switched off', async () => {
    const page = await dev.open('/', { strict: false })

    await page.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLButtonElement>('.head button[title="Show the tab order"]')!.click())
    await page.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('.tab-badge').length === 6)
    await page.click('a.top')
    await page.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('.tab-badge').length === 2)

    expect((await page.evaluate(overlay)).badges).toEqual([['1', ''], ['2', '']])

    // An island or a script adding an element.
    await page.evaluate(() => document.querySelector('main')!.append(Object.assign(document.createElement('button'), { textContent: 'Three' })))
    await page.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelectorAll('.tab-badge').length === 3)
    await page.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLButtonElement>('.head button[title="Show the tab order"]')!.click())

    expect((await page.evaluate(overlay)).badges).toEqual([])
  }, 60_000)
})
