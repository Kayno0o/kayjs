import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'
import Layout from '../tests/fixture/src/components/layout.kay'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

async function layout() {
  mounted = await mountComponent(Layout)

  return mounted.root
}

describe('EmptyState', () => {
  test('renders its title as a heading of the level given, and as a paragraph without one', async () => {
    const root = await layout()

    expect(root.querySelector('#missing [data-part=title]')?.outerHTML).toStartWith('<h1 data-part="title" class="')
    expect(root.querySelector('#empty [data-part=title]')?.tagName).toBe('P')
  })
})

describe('PageHeader', () => {
  test('sets its meta beside the title, before the actions, and its description under the title\'s line, before the children', async () => {
    const root = await layout()
    const parts = (selector: string) => [...root.querySelectorAll(`${selector} > *, ${selector} > [data-part=head] > *`)].map(part => part.getAttribute('data-part') ?? part.tagName)

    expect(parts('#moons')).toEqual(['head', 'title', 'meta', 'actions', 'description', 'P'])
    expect(root.querySelector('#moons [data-part=description]')?.textContent).toBe('Every moon of Jupiter, by distance.')
    expect(parts('#bare')).toEqual(['head', 'title'])
  })
})

describe('FileDrop', () => {
  test('marks itself compact only when asked', async () => {
    const root = await layout()

    expect(root.querySelector('#slim')?.hasAttribute('data-compact')).toBe(true)
    expect(root.querySelector('#zone')?.hasAttribute('data-compact')).toBe(false)
  })
})
