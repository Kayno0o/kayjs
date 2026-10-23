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

test('a Popover and a HoverCard keep the style an app gives them before their own anchor', async () => {
  const style = await styles()

  expect(style('#menu')).toBe('color: red; position-anchor: --kui-popover-menu')
  expect(style('#card')).toMatch(/^color: red; position-anchor: /)
})

test('a QrCode keeps the style an app gives it, image or inline, beside the size it draws', async () => {
  const style = await styles()

  expect(style('#qr-image')).toBe('margin: 1px')
  expect(style('#qr-inline')).toBe('margin: 1px; width: 64px; height: 64px')
  expect(style('#qr-bare')).toBe('margin: 1px')
})

test('a Skeleton keeps the style an app gives it beside its width and height', async () => {
  const style = await styles()

  expect(style('#skeleton')).toBe('margin: 2px; --kui-skeleton-width: 50%;')
  expect(style('#skeleton-bare')).toBe('margin: 2px')
})
