import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

async function header() {
  mounted = await mountComponent('src/components/app-header.kay')

  const { root } = mounted

  return {
    root,
    main: root.querySelector<HTMLElement>('#header')!,
    bare: root.querySelector<HTMLElement>('#bare')!,
    link: (label: string) => [...root.querySelectorAll<HTMLAnchorElement>('#header .kui-site-nav-link')].find(link => link.textContent === label)!,
  }
}

test('draws the brand, then the one nav, then the end area, and nothing for a slot left out', async () => {
  const view = await header()

  expect([...view.main.children].map(child => child.classList[0])).toEqual(['kui-app-header-brand', 'kui-site-nav', 'kui-app-header-end'])
  expect(view.main.querySelector('.kui-app-header-brand #brand')!.textContent).toBe('Moons')
  expect(view.main.querySelector('.kui-app-header-end #user')!.textContent).toBe('Ada')
  expect([...view.bare.children].map(child => child.tagName)).toEqual(['NAV'])
  expect(view.main.querySelectorAll('nav')).toHaveLength(1)
  expect(view.main.querySelector('nav')!.getAttribute('aria-label')).toBe('Main')
})

test('is sticky unless told not to', async () => {
  const view = await header()

  expect(view.main.hasAttribute('data-sticky')).toBe(true)
  expect(view.bare.hasAttribute('data-sticky')).toBe(false)
})

test('marks the section holding the page as current, draws icons decoratively and escapes a label', async () => {
  const view = await header()

  expect(view.link('Charts').getAttribute('aria-current')).toBe('true')
  expect(view.link('Home').getAttribute('aria-current')).toBeNull()
  expect(view.link('Home').querySelector('svg')!.getAttribute('aria-hidden')).toBe('true')
  expect(view.link('<b>Data</b>').querySelector('b')).toBeNull()
  expect(view.link('<b>Data</b>').querySelector('svg')).toBeNull()
})

test('folds its links into a popover the menu button opens', async () => {
  const view = await header()
  const toggle = view.main.querySelector<HTMLButtonElement>('.kui-site-nav-toggle')!
  const list = view.main.querySelector<HTMLElement>('.kui-site-nav-list')!

  expect(list.hasAttribute('popover')).toBe(true)
  expect(toggle.getAttribute('popovertarget')).toBe(list.id)
})
