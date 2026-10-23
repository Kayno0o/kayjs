import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'
import { clock } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  clock.stop()
  mounted?.unmount()
})

async function switchers() {
  mounted = await mountComponent('src/components/app-switchers.kay')

  clock.start()

  const { root } = mounted
  const tiles = (id: string) => [...root.querySelectorAll<HTMLAnchorElement>(`#${id} [data-part=tile]`)]

  return { root, tiles, trigger: (id: string) => root.querySelector<HTMLButtonElement>(`[popovertarget=${id}]`)! }
}

function press(key: string) {
  document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

test('names the trigger and the panel, the label and the icon being replaceable', async () => {
  const view = await switchers()

  expect([view.trigger('plain').getAttribute('aria-label'), view.trigger('named').getAttribute('aria-label')]).toEqual(['Apps', 'Our apps'])
  expect(view.root.querySelector('#plain [data-part=grid]')!.getAttribute('aria-label')).toBe('Apps')
  expect(view.root.querySelector('#plain')!.getAttribute('data-placement')).toBe('bottom-end')
  expect(view.trigger('plain').querySelector('svg')).not.toBeNull()
})

test('marks the current app, draws a letter for an app with no icon and the tooltip of one with a description', async () => {
  const view = await switchers()
  const plain = view.tiles('plain')

  expect(plain.map(tile => tile.getAttribute('aria-current'))).toEqual([null, 'true', null, null, null])
  expect(plain[0]!.querySelector('svg')).not.toBeNull()
  expect(plain[1]!.querySelector('[data-part=initial]')!.textContent).toBe('A')
  expect(plain[2]!.getAttribute('data-tooltip')).toBe('Telescope')
})

test('keeps tiles in the same tab, even to another origin, unless the switcher or the app asks for a new one', async () => {
  const view = await switchers()

  expect(view.tiles('plain').map(tile => tile.getAttribute('target'))).toEqual(['_self', '_self', '_self', '_self', '_self'])
  expect(view.tiles('named').map(tile => [tile.getAttribute('target'), tile.getAttribute('rel')])).toEqual(Array.from({ length: 5 }, () => ['_blank', 'noopener']))
})

test('replaces a tile\'s text with the tile snippet', async () => {
  const view = await switchers()

  expect(view.tiles('custom').map(tile => tile.querySelector('[data-part=name] em')!.textContent)).toEqual(['Atlas!', 'Aurora!'])
})

test('opens on the current tile and walks the tiles with the arrow keys, three to a row', async () => {
  const view = await switchers()
  const tiles = view.tiles('plain')

  view.root.querySelector<HTMLElement>('#plain')!.showPopover()
  await clock.settle()

  expect(document.activeElement).toBe(tiles[1]!)

  press('ArrowRight')
  expect(document.activeElement).toBe(tiles[2]!)
  press('ArrowDown')
  expect(document.activeElement).toBe(tiles[2]!)
  press('ArrowLeft')
  press('ArrowLeft')
  expect(document.activeElement).toBe(tiles[0]!)
  press('ArrowDown')
  expect(document.activeElement).toBe(tiles[3]!)
  press('ArrowUp')
  expect(document.activeElement).toBe(tiles[0]!)
  press('ArrowLeft')
  expect(document.activeElement).toBe(tiles[4]!)
  press('Home')
  expect(document.activeElement).toBe(tiles[0]!)
  press('End')
  expect(document.activeElement).toBe(tiles[4]!)
})

test('follows the browser closing the panel', async () => {
  const view = await switchers()
  const panel = view.root.querySelector<HTMLElement>('#plain')!

  view.root.querySelector<HTMLElement>('#plain')!.showPopover()
  await clock.settle()

  expect(panel.matches(':popover-open')).toBe(true)

  panel.hidePopover()
  await clock.settle()

  expect(view.trigger('plain').getAttribute('aria-expanded')).toBe('false')
})
