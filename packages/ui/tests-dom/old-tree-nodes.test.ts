import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'
import OldTreeNodes from '../tests/fixture/src/components/old-tree-nodes.kay'

let mounted: Mounted | undefined

afterEach(() => mounted?.unmount())

test('tree nodes keyed by id, as before 1.100, still draw', async () => {
  mounted = await mountComponent(OldTreeNodes)

  expect(mounted.root.querySelector('#tree [aria-selected=true]')?.textContent).toContain('Leaf')
})
