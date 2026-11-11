import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'
import OldItemNames from '../tests/fixture/src/components/old-item-names.kay'

let mounted: Mounted | undefined

afterEach(() => mounted?.unmount())

test('item names from before 1.99 still draw: text, value, title, id and url', async () => {
  mounted = await mountComponent(OldItemNames)

  const { root } = mounted
  const text = (selector: string) => root.querySelector(selector)?.textContent ?? ''

  expect(text('#timeline')).toContain('Home')
  expect(text('#accordion')).toContain('Mars')
  expect(root.querySelector('#audio [data-part=title]')?.textContent).toBe('Intro')
  expect(root.querySelector('#audio a[href="https://example.com/intro"]')).not.toBeNull()
  expect(root.querySelector('#gallery [aria-label="Mars"]')).not.toBeNull()
  expect(root.querySelector('[data-part=tile][aria-current=true]')?.textContent).toContain('Atlas')
})
