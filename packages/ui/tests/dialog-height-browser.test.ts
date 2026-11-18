import { join } from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { testSite } from 'kay/test'

const site = await testSite({ root: join(import.meta.dir, 'fixture'), browser: true })

afterAll(async () => site.close())

const viewport = { width: 1440, height: 900 }

async function measure(path: string, id: string) {
  await using page = await site.open(path, { viewport })

  await page.waitUntil((id) => {
    const dialog = document.querySelector<HTMLDialogElement>(`#${id}`)

    return dialog?.matches(':modal') === true && document.activeElement !== document.body
  }, {}, id)

  return await page.evaluate((id) => {
    const dialog = document.querySelector<HTMLDialogElement>(`#${id}`)!
    const style = getComputedStyle(dialog)

    return {
      height: dialog.getBoundingClientRect().height,
      focused: document.activeElement === dialog,
      ring: style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0,
    }
  }, id)
}

it('a centred modal Dialog holding one line is as tall as its content', async () => {
  expect((await measure('/dialog-height', 'plain')).height).toBeLessThan(300)
}, 60_000)

it('a size="full" Dialog is the viewport height less the margin', async () => {
  expect((await measure('/dialog-height-full', 'full')).height).toBe(viewport.height - 32)
}, 60_000)

it('the dialog element draws no focus ring when it opens', async () => {
  const found = await measure('/dialog-height', 'plain')

  expect(found.focused).toBe(true)
  expect(found.ring).toBe(false)
}, 60_000)
