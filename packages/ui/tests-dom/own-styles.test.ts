import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

async function styles() {
  mounted = await mountComponent('src/components/own-styles.kay', {})

  return (selector: string) => mounted!.root.querySelector(selector)!.getAttribute('style')
}

test('an app\'s style comes after the component\'s own declarations, so it wins', async () => {
  const style = await styles()

  expect(style('#menu')).toBe('position-anchor: --kui-popover-menu; color: red; position-anchor: --mine')
  expect(style('#card')).toMatch(/^position-anchor: .+; color: red; position-anchor: --mine$/)
  expect(style('#qr-image')).toBe('margin: 1px')
  expect(style('#qr-inline')).toBe('width: 64px; height: 64px; margin: 1px; width: 10px')
  expect(style('#qr-bare')).toBe('margin: 1px')
  expect(style('#skeleton')).toBe('--kui-skeleton-width: 50%; margin: 2px; --kui-skeleton-width: 9px')
  expect(style('#skeleton-bare')).toBe('margin: 2px')
  expect(style('#zoom')).toBe('touch-action: pan-y; touch-action: auto')
  expect(style('#masonry')).toMatch(/--kui-masonry-gap: 12px;.*--kui-masonry-gap: 1px$/)
  expect(style('#split')).toBe('--kui-split-list-width: 260px; --kui-split-list-width: 5px')
})
