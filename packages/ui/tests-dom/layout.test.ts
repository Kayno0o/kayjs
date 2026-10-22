import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

async function layout() {
  mounted = await mountComponent('src/components/layout.kay')

  return mounted.root
}

describe('EmptyState', () => {
  test('renders its title as a heading of the level given, and as a paragraph without one', async () => {
    const root = await layout()

    expect(root.querySelector('#missing .kui-empty-state-title')?.outerHTML).toBe('<h1 data-part="title" class="kui-empty-state-title">Not found</h1>')
    expect(root.querySelector('#empty .kui-empty-state-title')?.tagName).toBe('P')
  })
})

describe('PageHeader', () => {
  test('sets its meta beside the title, before the actions, and its description under the title\'s line, before the children', async () => {
    const root = await layout()
    const parts = (selector: string) => [...root.querySelectorAll(`${selector} > *, ${selector} > .kui-page-header-head > *`)].map(part => part.className || part.tagName)

    expect(parts('#moons')).toEqual(['kui-page-header-head', 'kui-page-header-title', 'kui-page-header-meta', 'kui-page-header-actions', 'kui-page-header-description', 'P'])
    expect(root.querySelector('#moons .kui-page-header-description')?.textContent).toBe('Every moon of Jupiter, by distance.')
    expect(parts('#bare')).toEqual(['kui-page-header-head', 'kui-page-header-title'])
  })
})

describe('FileDrop', () => {
  test('marks itself compact only when asked', async () => {
    const root = await layout()

    expect(root.querySelector('#slim')?.hasAttribute('data-compact')).toBe(true)
    expect(root.querySelector('#zone')?.hasAttribute('data-compact')).toBe(false)
  })
})
