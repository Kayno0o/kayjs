import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mount, settle } from 'kay/test'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

async function nav() {
  mounted = await mount('src/components/site-nav.kay')

  const { root } = mounted
  const toggle = root.querySelector<HTMLButtonElement>('.site-nav-toggle')!

  return {
    root,
    toggle,
    open: () => [root.querySelector('.site-nav')!.hasAttribute('data-open'), toggle.getAttribute('aria-expanded')],
    link: (label: string) => [...root.querySelectorAll<HTMLAnchorElement>('.site-nav-link')].find(link => link.textContent === label)!,
  }
}

function escape(element: Element) {
  element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
}

test('the toggle opens and closes the links it controls', async () => {
  const view = await nav()

  expect(view.open()).toEqual([false, 'false'])
  expect(view.root.querySelector(`#${view.toggle.getAttribute('aria-controls')}`)!.classList.contains('site-nav-list')).toBe(true)

  click(view.toggle)
  await settle()

  expect(view.open()).toEqual([true, 'true'])

  click(view.toggle)
  await settle()

  expect(view.open()).toEqual([false, 'false'])
})

test('Escape closes the open menu and hands the focus back to the toggle, leaving a closed one alone', async () => {
  const view = await nav()

  view.link('Data').focus()
  escape(view.link('Data'))
  await settle()

  expect(document.activeElement).toBe(view.link('Data'))

  click(view.toggle)
  await settle()
  view.link('Data').dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
  await settle()

  expect(view.open()).toEqual([true, 'true'])

  escape(view.link('Data'))
  await settle()

  expect(view.open()).toEqual([false, 'false'])
  expect(document.activeElement).toBe(view.toggle)
})

test('closes once a link is followed, or once another page is on screen', async () => {
  const view = await nav()

  click(view.toggle)
  await settle()
  click(view.link('Later'))
  await settle()

  expect(view.open()).toEqual([false, 'false'])

  click(view.toggle)
  await settle()
  click(view.root.querySelector('#next'))
  await settle()

  expect(view.open()).toEqual([false, 'false'])
  expect([view.link('Home').getAttribute('aria-current'), view.link('Data').getAttribute('aria-current')]).toEqual([null, 'page'])
})
