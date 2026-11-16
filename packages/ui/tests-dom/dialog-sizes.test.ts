import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import DialogSizes from '../tests/fixture/src/components/dialog-sizes.kay'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

async function open() {
  mounted = await mountComponent(DialogSizes, {})
  await settle()

  return (id: string) => mounted!.root.querySelector<HTMLDialogElement>(`#${id}`)!
}

test('a Dialog is medium and padded by default, and says its size and bare to the stylesheet only when given', async () => {
  const dialog = await open()

  expect([dialog('plain').getAttribute('data-size'), dialog('plain').getAttribute('data-bare')]).toEqual([null, null])
  expect([dialog('full').getAttribute('data-size'), dialog('full').getAttribute('data-bare')]).toEqual(['full', ''])
  expect(dialog('small').getAttribute('data-size')).toBe('sm')
})

test('a bare Dialog keeps its title and holds its content in a body the stylesheet leaves no inset or scroll', async () => {
  const dialog = await open()

  expect(dialog('full').querySelector('h2[data-part=title]')?.textContent).toBe('Full')
  expect(dialog('full').querySelector('.kui-dialog [data-part=body] #canvas')).not.toBeNull()
})

test('a Dialog placed on a side is the side panel: named for it, slid in from that edge, with the same parts, and wide by its size', async () => {
  const dialog = await open()
  const aside = dialog('aside')

  expect(aside.getAttribute('data-size')).toBe('lg')
  expect([aside.classList.contains('kui-side-panel'), aside.classList.contains('kui-dialog'), dialog('plain').classList.contains('kui-dialog')]).toEqual([true, false, true])
  expect(aside.querySelector('h2[data-part=title]')?.textContent).toBe('Aside')
  expect(aside.querySelector('[data-part=body]')?.textContent).toBe('Body')
})
