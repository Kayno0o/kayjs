import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

test('a Segmented given orientation="vertical" says so to the page and to screen readers, a plain one stays a row', async () => {
  mounted = await mountComponent('src/components/segmented-vertical.kay', {})

  const column = mounted.root.querySelector('#column')!
  const row = mounted.root.querySelector('#row')!

  expect([column.getAttribute('data-orientation'), column.getAttribute('aria-orientation')]).toEqual(['vertical', 'vertical'])
  expect([row.getAttribute('data-orientation'), row.getAttribute('aria-orientation')]).toEqual([null, null])
})

test('a vertical Segmented keeps real radios in one group, so the arrow keys move through them as the column reads', async () => {
  mounted = await mountComponent('src/components/segmented-vertical.kay', {})

  const radios = [...mounted.root.querySelectorAll<HTMLInputElement>('#column input[type="radio"]')]

  expect([radios.length, new Set(radios.map(radio => radio.name)).size, radios.filter(radio => radio.checked).map(radio => radio.value)]).toEqual([3, 1, ['prim']])
})
