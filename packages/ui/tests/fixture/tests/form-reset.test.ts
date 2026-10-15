import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, test } from 'bun:test'
import { browserPath, testSite } from 'kay/test'

const ROOT = join(import.meta.dir, '..')
const path = browserPath()
const START = { agree: true, power: false, free: false, decks: ['films'], size: 'm', level: 'b', tags: ['x', 'y'], title: 'Ada', bio: 'Hello', notes: '# Notes', range: [2, 8], icon: 'star', bare: 'star', heard: 'b', refd: true, form: 'x' }

// CI installs Chromium: there, a missing browser fails rather than skipping.
describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('a form reset on a served page', () => {
  test('puts every control of the hydrated page, a field named form and a Segmented with none picked included, back on its start', async () => {
    const site = await testSite({ root: ROOT, browser: { path } })

    try {
      const page = await site.open('/form-reset')
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

      expect(await state()).toMatchObject({ agree: false, power: true, free: true, decks: ['games'], size: 'l', level: 'c', title: 'Grace', form: 'y', icon: 'moon' })

      await page.click('#reset')
      await page.waitUntil(() => JSON.parse(document.querySelector('#state')!.textContent!).form === 'x')

      expect(await state()).toEqual(START)
      expect(await page.evaluate(() => [...new FormData(document.querySelector('form')!)].map(([name, value]) => `${name}=${String(value)}`).sort())).toEqual(['agree=on', 'bio=Hello', 'decks=films', 'form=x', 'icon=star', 'level=b', 'size=m', 'tags=x', 'tags=y', 'title=Ada'])
      expect(await page.evaluate(() => document.querySelectorAll('input[name="sort"]:checked').length)).toBe(0)
      expect(await page.value('#bare input[type="search"]')).toBe('')
      expect(page.errors).toEqual([])
    }
    finally {
      await site.close()
    }
  }, 120_000)

  test('hands the app\'s ref the element of a hydrated control once, however often its attributes change', async () => {
    const site = await testSite({ root: ROOT, browser: { path } })

    try {
      const page = await site.open('/form-reset-ref')

      await page.click('#change')
      await page.waitUntil(() => document.querySelector<HTMLInputElement>('input[name="title"]')!.placeholder === 'b')

      expect(await page.evaluate(() => (window as unknown as { refs: string[] }).refs.sort())).toEqual(['icon', 'markdown', 'plain-first', 'select', 'text', 'textarea'])
    }
    finally {
      await site.close()
    }
  }, 120_000)
})
