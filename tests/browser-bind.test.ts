import type { TestSite } from '../src/test'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { browserPath, testSite } from '../src/test'
import { scratchDir } from './scratch'

const path = browserPath()

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('bind: on checkboxes, details, files and a dialog in a browser', () => {
  let bound: TestSite

  beforeAll(async () => {
    bound = await testSite({ root: 'tests/fixtures/bind-elements', browser: { path } })
  }, 120_000)

  afterAll(async () => bound?.close())

  it('keeps a box ticked, a details opened and a file picked before the island hydrates', async () => {
    const file = join(await scratchDir('bind-files-'), 'note.txt')
    const page = await bound.open('/')

    try {
      await Bun.write(file, 'hello')
      // The island sits below the fold, so it stays server markup while the person acts on it from script, which scrolls nothing.
      await page.evaluate(() => {
        document.querySelector<HTMLInputElement>('input.ty')!.click()
        document.querySelector<HTMLElement>('details.more summary')!.click()
      })
      await page.upload('input.pick', file)
      expect(await page.text('p.out')).toBe('x shut 0 hidden')
      await page.evaluate(() => scrollTo(0, document.body.scrollHeight))
      await page.waitFor('p.out', { text: 'x,y open 1 hidden' })
      expect(await page.evaluate(() => [document.querySelector<HTMLInputElement>('input.tx')!.checked, document.querySelector<HTMLInputElement>('input.ty')!.checked, document.querySelector<HTMLDetailsElement>('details.more')!.open, document.querySelector<HTMLInputElement>('input.pick')!.files!.length])).toEqual([true, true, true, 1])
      expect(page.errors).toEqual([])
    }
    finally {
      page.close()
    }
  }, 60_000)

  it('closes a modal dialog the signal sets to false, leaving the top layer, and follows its own close', async () => {
    const page = await bound.open('/')

    try {
      await page.evaluate(() => scrollTo(0, document.body.scrollHeight))
      await page.waitFor('button.show')
      await page.click('button.show')
      await page.waitFor('p.out', { text: 'shown' })

      expect(await page.evaluate(() => document.querySelector('dialog.modal')!.matches(':modal'))).toBe(true)

      await page.evaluate(() => document.querySelector<HTMLButtonElement>('button.hide')!.click())
      await page.waitFor('p.out', { text: 'hidden' })

      expect(await page.evaluate(() => [document.querySelector<HTMLDialogElement>('dialog.modal')!.open, document.querySelector('dialog.modal')!.matches(':modal')])).toEqual([false, false])

      await page.click('button.show')
      await page.waitFor('p.out', { text: 'shown' })
      await page.evaluate(() => document.querySelector<HTMLDialogElement>('dialog.modal')!.close())
      await page.waitFor('p.out', { text: 'hidden' })

      expect(page.errors).toEqual([])
    }
    finally {
      page.close()
    }
  }, 60_000)
})
