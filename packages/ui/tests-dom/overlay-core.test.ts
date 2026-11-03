import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import OverlayCore from '../tests/fixture/src/components/overlay-core.kay'
import { click } from './dom'

let mounted: Mounted | undefined
const closed: string[] = []

afterEach(() => {
  mounted?.unmount()
  closed.length = 0
})

async function open() {
  mounted = await mountComponent(OverlayCore, { onClosed: (name: string) => closed.push(name) })
  await settle()

  return (id: string) => mounted!.root.querySelector<HTMLDialogElement>(`#${id}`)!
}

test('a Dialog has a close button named Close in its head, which closes it through onOpenChange', async () => {
  const dialog = await open()
  const button = dialog('plain').querySelector<HTMLElement>('[data-part=head] button')!

  expect(button.getAttribute('aria-label')).toBe('Close')
  click(button)
  await settle()

  expect(closed).toEqual(['plain'])
})

test('closeLabel names the close button and actions sit before it', async () => {
  const dialog = await open()

  expect(dialog('named').querySelector('[data-part=head] [aria-label=Dismiss]')).not.toBeNull()
  expect([...dialog('named').querySelectorAll('[data-part=head] button')].map(button => button.id || button.getAttribute('aria-label'))).toEqual(['prev', 'Dismiss'])
})

test('a dirty Dialog keeps its close button disabled', async () => {
  const dialog = await open()

  expect(dialog('busy').querySelector('[data-part=head] button')!.getAttribute('aria-disabled')).toBe('true')
})

test('a Dialog with a closeHref and no handler links its close control there and shows beside the page when not modal', async () => {
  const dialog = await open()
  const link = dialog('linked').querySelector('[data-part=head] a')

  expect(link?.getAttribute('href')).toBe('/back')
  expect(dialog('linked').open).toBe(true)
  expect(dialog('linked').getAttribute('data-modal')).toBe('false')
})

test('@header and @close replace the head line and the close button of a Dialog and a SidePanel', async () => {
  const dialog = await open()

  expect(dialog('header').querySelector('[data-part=head]')?.textContent).toBe('Mine')
  expect(dialog('header').querySelector('[data-part=title]')).toBeNull()
  expect(dialog('close').querySelector('[data-part=head] #bye')).not.toBeNull()
  expect(dialog('close').querySelector('[data-part=head] [aria-label=Close]')).toBeNull()
  expect(dialog('close').querySelector('[data-part=title]')?.textContent).toBe('Close')
  expect(dialog('panel-header').querySelector('[data-part=head]')?.textContent).toBe('Mine')
  expect(dialog('panel-close').querySelector('[data-part=head] #panel-bye')).not.toBeNull()
  expect(dialog('panel-close').querySelector('[data-part=head] [aria-label=Close]')).toBeNull()
})

test('a SidePanel takes the size names of a Dialog', async () => {
  const dialog = await open()

  expect(dialog('panel-sm').getAttribute('data-size')).toBe('sm')
})
