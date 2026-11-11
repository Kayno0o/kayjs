import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import OldHeads from '../tests/fixture/src/components/overlay-heads-old.kay'
import OverlayHeads from '../tests/fixture/src/components/overlay-heads.kay'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
})

async function root(component: typeof OverlayHeads = OverlayHeads) {
  mounted = await mountComponent(component, {})
  await settle()

  return mounted.root
}

test('a title block is drawn inside the title element of a Dialog, a SidePanel and a FormDialog, and the label is the accessible name', async () => {
  const page = await root()

  for (const [id, name, text] of [['dialog-heading', 'Rename planet', 'Mars'], ['panel-heading', 'Details of Venus', 'Venus'], ['form-heading', 'Edit moon', 'Phobos']] as const) {
    const dialog = page.querySelector(`#${id}`)?.closest('dialog') ?? page.querySelector(`#${id} dialog`)!

    expect(dialog.getAttribute('aria-label')).toBe(name)
    expect(dialog.querySelector('[data-part="title"] em')?.textContent).toBe(text)
    expect(dialog.querySelector('[data-part="title"]')?.textContent).toBe(text)
  }

  expect(page.querySelector('#dialog-plain [data-part="title"]')?.textContent).toBe('Plain')
})

test('a title block with no label names the dialog through its heading, and a ConfirmDelete takes one too', async () => {
  const page = await root()
  const dialog = page.querySelector('#dialog-markup')?.closest('dialog') ?? page.querySelector('#dialog-markup dialog')!
  const heading = dialog.querySelector('[data-part="title"]')!

  expect(dialog.hasAttribute('aria-label')).toBe(false)
  expect(heading.id).not.toBe('')
  expect(dialog.getAttribute('aria-labelledby')).toBe(heading.id)
  expect(page.querySelector('#confirm-title [data-part="title"] em')?.textContent).toBe('Sirius')
  expect(page.querySelector('#dialog-plain')?.closest('dialog')?.hasAttribute('aria-labelledby') ?? page.querySelector('#dialog-plain dialog')?.hasAttribute('aria-labelledby')).toBe(false)
})

test('the heading block of 1.96 still draws in the title element beside the title string that names the dialog', async () => {
  const page = await root(OldHeads)

  for (const [id, name, text] of [['dialog-heading', 'Rename planet', 'Mars'], ['panel-heading', 'Details of Venus', 'Venus'], ['form-heading', 'Edit moon', 'Phobos']] as const) {
    const dialog = page.querySelector(`#${id}`)?.closest('dialog') ?? page.querySelector(`#${id} dialog`)!

    expect(dialog.getAttribute('aria-label')).toBe(name)
    expect(dialog.querySelector('[data-part="title"]')?.textContent).toBe(text)
  }
})

test('a details block is drawn under the message of the dialog, and nothing is drawn without one', async () => {
  const page = await root()

  expect([...page.querySelectorAll('#confirm-details [data-part="details"] li')].map(item => item.textContent)).toEqual(['Phobos', 'Deimos'])
  expect(page.querySelector('#confirm-details [data-part="message"]')?.textContent).toBe('Delete 2 moons?')
  expect(page.querySelector('#confirm-plain [data-part="details"]')).toBeNull()
})

test('an inline confirm keeps the message as its accessible name and draws no details', async () => {
  const page = await root()

  expect(page.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Delete 2 moons?')
  expect(page.querySelector('[data-part="details"] p')).toBeNull()
})
