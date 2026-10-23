import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'
import Stats from '../tests/fixture/src/components/stats.kay'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

async function stats() {
  mounted = await mountComponent(Stats, {})

  return (id: string) => mounted!.root.querySelector(`#${id}`)!
}

test('a Stat is the inline pill unless variant is tile, which marks the root for the stylesheet', async () => {
  const stat = await stats()

  expect([stat('plain').getAttribute('data-variant'), stat('tile').getAttribute('data-variant')]).toEqual([null, 'tile'])
  expect(stat('tile').className).toContain('kui-stat-badge')
})

test('a tile keeps the figure first and the label after it, as the pill does', async () => {
  const stat = await stats()

  expect([...stat('tile').children].map(child => child.getAttribute('data-part'))).toEqual(['value', 'label'])
})

test('tone colours the value through the root, so an app targets no inner class', async () => {
  const stat = await stats()

  expect([stat('toned').getAttribute('data-tone'), stat('plain').getAttribute('data-tone')]).toEqual(['danger', null])
})
