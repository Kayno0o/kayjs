import type { Mounted } from 'kay/test'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import OverlayOpen from '../tests/fixture/src/components/overlay-open.kay'
import { untilHolds } from '../tests/until'
import { click } from './dom'

let mounted: Mounted | undefined
const closed: string[] = []

afterEach(() => {
  mounted?.unmount()
  closed.length = 0
})

async function page() {
  mounted = await mountComponent(OverlayOpen, { onClosed: (name: string) => closed.push(name) })
  await settle()

  const root = mounted.root

  return {
    root,
    dialog: (id: string) => root.querySelector<HTMLDialogElement>(`#${id}`)!,
    open: async (id: string) => {
      click(root.querySelector(`#open-${id}`))
      await settle()
    },
  }
}

test('opening a Dialog focuses the first control of its body, not the close button', async () => {
  const { dialog, open } = await page()

  await open('fields')
  expect(document.activeElement?.id).toBe('first')
  expect(dialog('fields').querySelector('[data-part=head] [aria-label=Close]')).not.toBeNull()
})

test('a body drawn by the same signal that opens the overlay still takes the focus, on every reopen', async () => {
  const { dialog, open } = await page()

  for (const [id, input] of [['lazy', 'lazy-input'], ['plazy', 'plazy-input'], ['kept', 'kept-input']] as const) {
    for (let round = 0; round < 2; round++) {
      await open(id)
      expect(dialog(id).open, `${id} ${round}`).toBe(true)
      expect(document.activeElement?.id, `${id} ${round}`).toBe(input)
      dialog(id).close()
      await settle()
    }
  }
})

test('an autofocus control keeps the focus, and a body with no control leaves it on the dialog', async () => {
  const { dialog, open } = await page()

  await open('auto')
  expect(document.activeElement?.id).not.toBe('one')
  await open('bare')
  expect(document.activeElement).toBe(dialog('bare'))
})

test('a Dialog or a SidePanel with a closeHref and dirty has a close link that is disabled: no href, aria-disabled, no click', async () => {
  const { dialog, open } = await page()

  for (const id of ['ddirty', 'pdirty']) {
    await open(id)

    const link = dialog(id).querySelector<HTMLElement>('[data-part=head] [aria-label=Close]')!

    expect(link.getAttribute('aria-disabled')).toBe('true')
    expect(link.hasAttribute('href')).toBe(false)
    click(link)
    await settle()
    expect(dialog(id).open).toBe(true)
  }

  expect(closed).toEqual([])
})

test('a Dialog with a closeHref and no handler follows it on Escape', async () => {
  const { dialog, open } = await page()
  const happy = window as unknown as { happyDOM: { setURL: (url: string) => void } }

  happy.happyDOM.setURL('http://localhost/overlays')
  await open('esc')
  expect(dialog('esc').querySelector('a[aria-label=Close]')?.getAttribute('href')).toBe('/dialog-esc')
  // Escape ends in the dialog's close event, which the test raises as the browser would.
  dialog('esc').close()
  await settle()
  expect(dialog('esc').open).toBe(false)
  await untilHolds(() => location.pathname === '/dialog-esc')
})

test('a Dialog with a closeHref and an onOpenChange keeps the link and tells the handler too', async () => {
  const { dialog, open } = await page()

  await open('both')
  expect(dialog('both').querySelector('a[aria-label=Close]')?.getAttribute('href')).toBe('/dialog-both')
  dialog('both').close()
  await settle()
  expect(closed).toEqual(['both'])
})

test('a Dialog the server rendered open is opened again as a modal, with no close event', async () => {
  const show = spyOn(HTMLDialogElement.prototype, 'showModal')

  try {
    const { dialog } = await page()

    expect(dialog('hydrated').open).toBe(true)
    expect(show).toHaveBeenCalled()
    expect(closed).toEqual([])
    expect(document.activeElement?.id).toBe('hydrated-input')
  }
  finally {
    show.mockRestore()
  }
})

test('typing inside a Dialog or a SidePanel locks a click outside: Escape alone with no footer, nothing with one, and it clears on reopen', async () => {
  const { dialog, open } = await page()

  for (const [id, locked] of [['dtype', 'closerequest'], ['dfooter', 'none'], ['ptype', 'closerequest'], ['pfooter', 'none']] as const) {
    await open(id)
    expect(dialog(id).getAttribute('closedby')).toBe('any')
    dialog(id).querySelector('input')!.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    expect(dialog(id).getAttribute('closedby')).toBe(locked)
    dialog(id).close()
    await settle()
    await open(id)
    expect(dialog(id).getAttribute('closedby')).toBe('any')
    dialog(id).close()
    await settle()
  }
})

test('a CommandPalette takes the size names, and a FormDialog passes size, level, actions and closeLabel to its Dialog', async () => {
  const { open, root } = await page()
  const form = () => root.querySelector('dialog[aria-label=Form]')!

  expect(root.querySelector('#palette')?.getAttribute('data-size')).toBe('sm')
  await open('form')
  expect(form().getAttribute('data-size')).toBe('lg')
  expect(form().querySelector('h3[data-part=title]')?.textContent).toBe('Form')
  expect(form().querySelector('[data-part=head] #form-actions')).not.toBeNull()
  expect(form().querySelector('[data-part=head] [aria-label=Shut]')).not.toBeNull()
})
