import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { browserPath, testSite } from 'kay/test'
import { ui } from '../src/extension'

const path = browserPath()

describe('a MarkdownEditor with previewHtml', () => {
  let site: Awaited<ReturnType<typeof testSite>>

  beforeAll(async () => {
    site = await testSite({ root: `${import.meta.dir}/fixture`, extensions: [ui()], browser: path === undefined ? undefined : { path } })
  }, 120_000)

  afterAll(async () => site.close())

  it('draws the given preview in the server markup', async () => {
    const { html } = await site.visit('/markdown-preview')

    expect(html).toContain('<h1>Title</h1><p>Body</p>')
    expect(html).toContain('role="region"')
  })

  it.skipIf(path === undefined && (process.env.CI ?? '') === '')('keeps the pane as it is until an edit, then shows what preview answers, at the same height', async () => {
    await using page = await site.open('/markdown-preview')
    const read = async () => page.evaluate(() => {
      const body = document.querySelector('.kui-markdown-preview-body')!

      return { height: body.getBoundingClientRect().height, text: body.textContent }
    })

    const before = await read()

    await Bun.sleep(500)
    expect(await read()).toEqual(before)
    expect(before.text).toBe('TitleBody')

    await page.evaluate(() => {
      const area = document.querySelector<HTMLTextAreaElement>('#editor')!

      area.value = '# Title\nEdited'
      area.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await Bun.sleep(800)

    const after = await read()

    expect(after.text).toBe('TitleEdited!')
    expect(after.height).toBe(before.height)
  })
})
