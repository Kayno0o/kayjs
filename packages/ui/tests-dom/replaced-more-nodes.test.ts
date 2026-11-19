import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import ReplacedMoreNodes from '../tests/fixture/src/components/replaced-more-nodes.kay'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => mounted?.unmount())

test('the middle of a relation graph and the popup of a map marker keep their nodes when the centre or the marker is replaced under its key', async () => {
  mounted = await mountComponent(ReplacedMoreNodes, {})

  const { root } = mounted
  const kinds = ['middle', 'popup']
  const find = (kind: string) => root.querySelector<HTMLInputElement>(`input[data-block=${kind}]`)
  const before = kinds.map(find)

  expect(kinds.filter((_, index) => !before[index])).toEqual([])
  click(root.querySelector('#bump'))
  await settle()
  expect(kinds.filter((kind, index) => find(kind) !== before[index])).toEqual([])
  expect(kinds.map(kind => find(kind)!.value)).toEqual(['Centre1', 'Marker1:0'])
})
