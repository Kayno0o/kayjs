import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

async function open() {
  mounted = await mountComponent('src/components/dialog-sizes.kay', {})
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

  expect(dialog('full').querySelector('h2.kui-dialog-title')?.textContent).toBe('Full')
  expect(dialog('full').querySelector('.kui-dialog-body #canvas')).not.toBeNull()
})
