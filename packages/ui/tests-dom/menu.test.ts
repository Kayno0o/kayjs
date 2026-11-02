import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import Menus from '../tests/fixture/src/components/menus.kay'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

test('a Menu entry is destructive by its tone or the deprecated danger flag, the tone winning', async () => {
  mounted = await mountComponent(Menus)

  const items = [...mounted.root.querySelectorAll('#by-tone [data-part=item]')].map(item => [item.textContent, item.hasAttribute('data-danger')])

  expect(items).toEqual([['Tone', true], ['Old', true], ['Wins', false], ['Plain', false]])
})

test('a Menu trigger takes a tone, the danger variant being the danger tone', async () => {
  mounted = await mountComponent(Menus)

  const trigger = (id: string) => {
    const button = mounted!.root.querySelector(`[popovertarget="${id}"]`)!

    return [button.getAttribute('data-variant'), button.getAttribute('data-tone')]
  }

  expect([trigger('by-tone'), trigger('plain')]).toEqual([['ghost', 'danger'], ['ghost', 'neutral']])
})

test('a Menu entry with an icon draws it as the icon part, sized and shrunk, and one without writes none', async () => {
  mounted = await mountComponent(Menus)

  const [added, bare] = [...mounted.root.querySelectorAll('#icons [data-part=item]')]

  expect([...added!.querySelectorAll('[data-part=icon]')].map(icon => [...icon.classList])).toEqual([expect.arrayContaining(['size-4', 'shrink-0'])])
  expect(bare!.querySelector('[data-part=icon]')).toBeNull()
})

test('a Menu given a point renders no trigger, opens beside a fixed anchor at the point and reports its state', async () => {
  mounted = await mountComponent(Menus)

  const root = mounted.root
  const menu = root.querySelector<HTMLElement>('#at-point')!

  expect(root.querySelector('[popovertarget="at-point"]')).toBeNull()
  expect(menu.matches(':popover-open')).toBe(false)

  click(root.querySelector('#ask'))
  await settle()

  expect(menu.matches(':popover-open')).toBe(true)
  expect(menu.querySelector('[role=menu]')?.getAttribute('aria-label')).toBe('At a point')

  const anchor = root.querySelector<HTMLElement>('[data-part=anchor]')!

  expect(anchor.getAttribute('style')).toContain('left: 40px')
  expect(anchor.getAttribute('style')).toContain('top: 60px')
  expect(menu.getAttribute('style')).toContain(`position-anchor: ${(/anchor-name: (--[\w-]+)/).exec(anchor.getAttribute('style')!)![1]}`)
  expect(menu.dataset.placement).toBe('bottom-start')
})

test('a Menu at a point runs the entry picked after it closes, and a light dismiss tells the parent', async () => {
  mounted = await mountComponent(Menus)

  const root = mounted.root
  const menu = root.querySelector<HTMLElement>('#at-point')!

  click(root.querySelector('#ask'))
  await settle()
  click(menu.querySelectorAll<HTMLElement>('[data-part=item]')[1]!)
  await settle()

  expect(root.querySelector('#picked')?.textContent).toBe('Second')
  expect(menu.matches(':popover-open')).toBe(false)

  click(root.querySelector('#ask'))
  await settle()
  menu.hidePopover()
  await settle()
  click(root.querySelector('#ask'))
  await settle()

  expect(menu.matches(':popover-open')).toBe(true)
})

test('a Menu entry with an href is a link, new-tab with noopener when it leaves the origin, and a disabled one stays a button', async () => {
  mounted = await mountComponent(Menus)

  const items = [...mounted.root.querySelectorAll('#links [data-part=item]')]
  const [same, away, off, plain] = items as HTMLElement[]

  expect(items.map(item => item.tagName)).toEqual(['A', 'A', 'BUTTON', 'BUTTON'])
  expect(same!.getAttribute('role')).toBe('menuitem')
  expect(same!.getAttribute('href')).toBe('/here')
  expect(same!.hasAttribute('target')).toBe(false)
  expect([away!.getAttribute('target'), away!.getAttribute('rel')]).toEqual(['_blank', 'noopener noreferrer'])
  expect(off!.hasAttribute('disabled')).toBe(true)
  expect(plain!.getAttribute('type')).toBe('button')
})

test('a Menu link closes the menu and runs its onSelect when followed', async () => {
  mounted = await mountComponent(Menus)

  const root = mounted.root
  const menu = root.querySelector<HTMLElement>('#links')!
  const same = menu.querySelector<HTMLAnchorElement>('[data-part=item]')!

  same.addEventListener('click', event => event.preventDefault())
  menu.showPopover()
  await settle()
  click(same)
  await settle()

  expect(root.querySelector('#picked')?.textContent).toBe('Same')
  expect(menu.matches(':popover-open')).toBe(false)
})

test('a Menu link takes Space as Enter, and arrows move across links and buttons', async () => {
  mounted = await mountComponent(Menus)

  const menu = mounted.root.querySelector<HTMLElement>('#links')!
  const list = menu.querySelector<HTMLElement>('[role=menu]')!
  const [same, away] = [...menu.querySelectorAll<HTMLElement>('[data-part=item]')]
  let clicks = 0

  same!.addEventListener('click', (event) => {
    clicks++
    event.preventDefault()
  })
  menu.showPopover()
  await settle()
  same!.focus()
  list.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
  list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))

  expect(clicks).toBe(1)
  expect(document.activeElement).toBe(away!)
})
