import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { previewUrl } from '../src/server'
import { browserPath, testSite } from '../src/test'

const path = browserPath()

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('edit mode in a browser', () => {
  it('shows a draft through the page swap, the island showing it kept alive, or where the schema refuses it', async () => {
    const secret = 'a-preview-secret-long-enough-for-kay-0123456789'
    const cms = await testSite({ root: 'tests/fixtures/cms', preview: { secret }, inlineStyles: false, browser: { path }, extensions: [{ name: 'editor', editor: `src/components/draft-editor.kay` }] })

    try {
      const editor = await cms.open(previewUrl('/marks/launch', { edit: true }))

      await editor.waitFor('h1', { text: 'Launch day' })
      await editor.click('button.count')
      await editor.click('button.draft')
      await editor.waitFor('h1', { text: 'Draft title' })

      expect(await editor.text('article h2')).toBe('Drafted')
      expect(await editor.text('button.count')).toBe('Clicked 1')
      expect(await editor.text('ul.edited')).toBe('news:launch')
      expect(await editor.path()).toBe('/marks/launch')

      await editor.click('button.refused')
      await editor.waitFor('p.issues', { text: '[{"collection":"news","slug":"launch","path":"title","message":"Title is not valid"}]' })

      // The entry the schema refuses shows its saved text.
      await editor.waitFor('h1', { text: 'Launch day' })

      // One entry refused leaves the other its preview.
      await editor.click('button.mixed')
      await editor.waitFor('h1', { text: 'Mixed title' })
      await editor.waitFor('p.issues', { text: '"slug":"roadmap"' })

      // A field typed in inside the editor keeps the focus and the caret across the swap each key shows, typed at its end or in its middle.
      const typed = async (key: string, title: string, caret: number) => {
        await editor.type(key)
        await editor.waitUntil(text => document.querySelector('h1')?.textContent === text, {}, title)

        expect(await editor.evaluate(() => [document.activeElement?.className, (document.activeElement as HTMLInputElement).selectionStart])).toEqual(['title', caret])
      }

      await editor.click('input.title')

      for (const [index, key] of [...'Typed'].entries())
        await typed(key, 'Typed'.slice(0, index + 1), index + 1)

      await editor.press('ArrowLeft')
      await editor.press('ArrowLeft')
      await typed('x', 'Typxed', 4)

      // Leaving the page while a draft renders keeps the page gone to.
      await editor.click('button.slow')
      await editor.click('a.away')
      await editor.waitFor('h1', { text: 'Next year' })
      await Bun.sleep(800)

      expect(await editor.text('h1')).toBe('Next year')
      expect(await editor.path()).toBe('/marks/roadmap')
      // The editor lived on through the navigation, given the entries of the page gone to.
      expect(await editor.text('button.count')).toBe('Clicked 1')
      expect(await editor.text('ul.edited')).toBe('news:roadmap')

      // Out of edit mode, the next page swapped in leaves the editor and its stylesheet out.
      const sheets = await editor.count('link[rel="stylesheet"]')

      // The page left from links back to the first, which no prefetch in edit mode holds.
      await editor.evaluate(async () => {
        await fetch('/_kay/preview?exit&path=/')
        document.querySelector('a.away')!.setAttribute('href', '/marks/launch')
      })
      await editor.click('a.away')
      await editor.waitFor('h1', { text: 'Launch day' })

      expect(await editor.count('ul.edited')).toBe(0)
      expect(await editor.count('link[rel="stylesheet"]')).toBe(sheets - 1)
      expect(editor.errors).toEqual([])
    }
    finally {
      await cms.close()
    }
  }, 60_000)
})
