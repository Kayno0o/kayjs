import type { Mounted } from 'kay/test'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import ReplacedMoreBlocks from '../tests/fixture/src/components/replaced-more-blocks.kay'
import { click } from './dom'

// happy-dom never fires the observer the virtual list measures with.
class Resize {
  observe = () => undefined
  unobserve = () => undefined
  disconnect = () => undefined
}

const { ResizeObserver } = globalThis
let mounted: Mounted | undefined

beforeEach(() => {
  Object.assign(globalThis, { ResizeObserver: Resize })
})

afterEach(() => {
  mounted?.unmount()
  Object.assign(globalThis, { ResizeObserver })
})

describe('Tree, steps, virtual list and toaster blocks, the items replaced with the same keys', () => {
  test('keep the nodes of the block, which reads the new item', async () => {
    mounted = await mountComponent(ReplacedMoreBlocks, {})

    const { root } = mounted
    const kinds = ['tree', 'actions', 'step', 'virtual', 'toast']
    const find = (kind: string) => [...root.querySelectorAll<HTMLInputElement>(`input[data-block=${kind}]`)].at(-1)
    const before = kinds.map(find)

    expect(kinds.filter((_, index) => !before[index])).toEqual([])

    click(root.querySelector('#bump'))
    await settle()

    expect(kinds.filter((kind, index) => find(kind) !== before[index])).toEqual([])
    expect(find('virtual')!.dataset.index).toBe('1')
    expect(kinds.map(kind => find(kind)!.value.slice(-1))).toEqual(['1', '1', '1', '1', '1'])
  })
})
