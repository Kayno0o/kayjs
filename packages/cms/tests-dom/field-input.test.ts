import type { Mounted } from 'kay/test'
import type { Field } from '../src/fields'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import { createDrafts } from '../src/drafts'

const ENTRY = { collection: 'posts', slug: 'hello' }
const TAGS: Field = { key: 'tags', label: 'Tags', hint: undefined, required: false, kind: 'list', numbered: true, item: { key: 0, label: 'Tag', hint: undefined, required: false, kind: 'text' } }
let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

async function open(items: string[]) {
  const drafts = createDrafts({ show: async () => ({}) })

  drafts.open({ ...ENTRY, data: { tags: items } })
  mounted = await mountComponent('src/components/list-field.kay', { drafts, field: TAGS })

  return { drafts, root: mounted.root }
}

const said = () => document.querySelector('[data-kui-announce]')?.textContent?.trim()

test('the buttons of a list item move it, reorder the saved value and say the item by the place it left', async () => {
  const { drafts, root } = await open(['a', 'b', 'c'])

  root.querySelectorAll<HTMLButtonElement>('[data-kcms-row]')[0]!.querySelector<HTMLButtonElement>('[data-kcms-move="down"]')!.click()
  await settle()

  expect(drafts.value(ENTRY, 'tags')).toEqual(['b', 'a', 'c'])
  await Bun.sleep(150)
  expect(said()).toBe('Moved Item 1 to 2 of 3')
})

test('Alt with an arrow in a field of an item moves it, and a move past either end changes nothing', async () => {
  const { drafts, root } = await open(['a', 'b', 'c'])
  const rows = () => root.querySelectorAll<HTMLElement>('[data-kcms-row]')
  const press = (row: HTMLElement, key: string) => row.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key, altKey: true, bubbles: true, cancelable: true }))

  press(rows()[2]!, 'ArrowUp')
  await settle()

  expect(drafts.value(ENTRY, 'tags')).toEqual(['a', 'c', 'b'])

  press(rows()[0]!, 'ArrowUp')
  press(rows()[2]!, 'ArrowDown')
  await settle()

  expect(drafts.value(ENTRY, 'tags')).toEqual(['a', 'c', 'b'])
})
