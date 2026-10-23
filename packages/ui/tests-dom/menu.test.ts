import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

test('a Menu entry is destructive by its tone or the deprecated danger flag, the tone winning', async () => {
  mounted = await mountComponent('src/components/menus.kay')

  const items = [...mounted.root.querySelectorAll('#by-tone [data-part=item]')].map(item => [item.textContent, item.hasAttribute('data-danger')])

  expect(items).toEqual([['Tone', true], ['Old', true], ['Wins', false], ['Plain', false]])
})

test('a Menu trigger takes a tone, the danger variant being the danger tone', async () => {
  mounted = await mountComponent('src/components/menus.kay')

  const trigger = (id: string) => {
    const button = mounted!.root.querySelector(`[popovertarget="${id}"]`)!

    return [button.getAttribute('data-variant'), button.getAttribute('data-tone')]
  }

  expect([trigger('by-tone'), trigger('plain')]).toEqual([['ghost', 'danger'], ['ghost', 'neutral']])
})

test('a Menu entry with an icon draws it as the icon part, sized and shrunk, and one without writes none', async () => {
  mounted = await mountComponent('src/components/menus.kay')

  const [added, bare] = [...mounted.root.querySelectorAll('#icons [data-part=item]')]

  expect([...added!.querySelectorAll('[data-part=icon]')].map(icon => [...icon.classList])).toEqual([expect.arrayContaining(['size-4', 'shrink-0'])])
  expect(bare!.querySelector('[data-part=icon]')).toBeNull()
})

test('a Menu given a point renders no trigger, opens beside a fixed anchor at the point and reports its state', async () => {
  mounted = await mountComponent('src/components/menus.kay')

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
  mounted = await mountComponent('src/components/menus.kay')

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
