import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, test } from 'bun:test'
import { mount } from 'kay/test'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

async function layout() {
  mounted = await mount('src/components/layout.kay')

  return mounted.root
}

describe('EmptyState', () => {
  test('renders its title as a heading of the level given, and as a paragraph without one', async () => {
    const root = await layout()

    expect(root.querySelector('#missing .kui-empty-state-title')?.outerHTML).toBe('<h1 class="kui-empty-state-title">Not found</h1>')
    expect(root.querySelector('#empty .kui-empty-state-title')?.tagName).toBe('P')
  })
})
