import type { TestSite } from '../src/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { browserPath, testSite } from '../src/test'
import { fixtureCopy } from './scratch'

const path = browserPath()

// CI installs Chromium for these: there, a missing browser fails rather than skipping. Run alone: it reads and writes the project's src/ui.ts.
describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('the dev tool\'s Styles tab in a browser', () => {
  let dev: TestSite
  let root = ''
  const inspected = process.env.KAY_INSPECT

  beforeAll(async () => {
    // The elements carry their source position only when the server inspects, as under `kay dev`.
    process.env.KAY_INSPECT = '1'
    root = await fixtureCopy('dev-styles-tab')
    dev = await testSite({ root, browser: { path }, dev: true })
  }, 60_000)

  afterAll(async () => {
    await dev?.close()

    if (inspected === undefined)
      delete process.env.KAY_INSPECT
    else
      process.env.KAY_INSPECT = inspected
  })

  it('lists the hovered component\'s parts and variants, and writes a part to a new src/ui.ts', async () => {
    const view = await dev.open('/')

    try {
      await view.waitUntil(() => document.querySelector('kay-dev')?.shadowRoot?.querySelector('.bar') !== null)
      await view.evaluate(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLButtonElement>('#kay-dev-tab-styles')!.click())
      await view.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector('#kay-dev-styles .note') !== null)
      await view.evaluate(() => document.getElementById('inside')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, composed: true })))
      await view.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector('#kay-dev-styles .heading')?.textContent === 'Panel')

      const shown = await view.evaluate(() => {
        const panel = document.querySelector('kay-dev')!.shadowRoot!.querySelector('#kay-dev-styles')!

        return { parts: [...panel.querySelectorAll('.row .pill')].map(pill => pill.textContent), text: panel.textContent }
      })

      expect(shown.parts.sort()).toEqual(['body', 'root'])
      expect(shown.text).toContain('size:')

      await view.evaluate(() => {
        const panel = document.querySelector('kay-dev')!.shadowRoot!.querySelector('#kay-dev-styles')!
        const box = [...panel.querySelectorAll<HTMLTextAreaElement>('.row textarea')].find(area => area.getAttribute('aria-label') === 'Classes of Panel body')!

        box.value = 'p-6 text-lg'
        box.closest('.row')!.querySelector('button')!.click()
      })
      await view.waitUntil(() => document.querySelector('kay-dev')!.shadowRoot!.querySelector('#kay-dev-styles .note')?.textContent.startsWith('Created src/ui.ts') === true)

      expect(await readFile(join(root, 'src/ui.ts'), 'utf8')).toBe('import { defineUi } from \'kay\'\n\nexport default defineUi({\n  Panel: { parts: { body: \'p-6 text-lg\' } },\n})\n')
    }
    finally {
      view.close()
    }
  }, 60_000)

  it('refuses a write another site sends', async () => {
    const answer = await dev.fetch('/_kay/dev/ui', { method: 'POST', headers: { 'x-kay-dev': '1', 'sec-fetch-site': 'cross-site' }, body: JSON.stringify({ file: 'src/components/panel.kay', part: 'root', classes: 'p-9' }) })

    expect(answer.status).toBe(403)
    expect(await readFile(join(root, 'src/ui.ts'), 'utf8')).not.toContain('p-9')
  })
})
