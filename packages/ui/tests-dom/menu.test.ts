import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import MenuItems from '../tests/fixture/src/components/menu-items.kay'
import MenuSource from '../tests/fixture/src/components/menu-source.kay'
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

test('a Menu link opens in a new tab for an absolute or protocol-relative address alone', async () => {
  const { isExternal } = await import('../src/outside')

  expect(['/a', 'a/b', '?q=1', '#x', 'https://x.org', 'http://x.org', '//x.org/a'].map(href => isExternal(href))).toEqual([false, false, false, false, true, true, true])
})

test('a Menu @trigger replaces the icon button with a labelled button or an avatar, keeping popovertarget, aria-haspopup and aria-expanded', async () => {
  mounted = await mountComponent(Menus)

  for (const [id, trigger] of [['labelled', '#labelled-trigger'], ['avatar', '#avatar-trigger']] as const) {
    const button = mounted.root.querySelector<HTMLElement>(trigger)!
    const menu = mounted.root.querySelector<HTMLElement>(`#${id}`)!

    expect([button.getAttribute('popovertarget'), button.getAttribute('aria-haspopup'), button.getAttribute('aria-expanded')]).toEqual([id, 'menu', 'false'])

    menu.showPopover()
    await settle()
    expect(button.getAttribute('aria-expanded')).toBe('true')

    menu.hidePopover()
    await settle()
    expect(button.getAttribute('aria-expanded')).toBe('false')
  }

  expect(mounted.root.querySelector('#avatar-trigger span')).not.toBeNull()
})

async function source() {
  const calls: string[] = []

  mounted = await mountComponent(MenuSource, { calls })

  const root = mounted.root

  return { root, calls, menu: root.querySelector<HTMLElement>('#source')!, show: () => click(root.querySelector('#show')), hide: () => click(root.querySelector('#hide')), texts: () => [...root.querySelectorAll('#source [role=menu] > *')].map(one => one.textContent) }
}

test('a Menu given a function loads its entries each time it opens, with a loading row meanwhile', async () => {
  const { root, calls, menu, show, hide, texts } = await source()

  show()
  await settle()
  expect(menu.matches(':popover-open')).toBe(true)
  expect(texts()).toEqual(['Loading…'])

  click(root.querySelector('#answer'))
  await settle()
  expect(texts()).toEqual(['Alpha', 'Beta'])
  expect(document.activeElement?.textContent).toBe('Alpha')

  hide()
  await settle()
  show()
  await settle()
  expect(calls).toEqual(['load', 'load'])
  expect(texts()).toEqual(['Loading…'])
})

test('a Menu whose entries fail to load says so and loads them again from its retry entry', async () => {
  const { root, calls, show, texts } = await source()

  show()
  await settle()
  click(root.querySelector('#refuse'))
  await settle()
  expect(texts()).toEqual(['Could not load.', 'Try again'])

  click(root.querySelector('#source [data-part=item]'))
  await settle()
  expect(texts()).toEqual(['Loading…'])

  click(root.querySelector('#answer'))
  await settle()
  expect(texts()).toEqual(['Alpha', 'Beta'])
  expect(calls).toEqual(['load', 'load'])
})

test('a Menu draws an entry with its item block, the entry keeping its button or link', async () => {
  mounted = await mountComponent(MenuSource, { calls: [] })

  const [rename, away] = [...mounted.root.querySelectorAll('#drawn [data-part=item]')]

  expect([rename!.tagName, rename!.querySelector('.row')?.textContent, rename!.querySelector('.hint')?.textContent]).toEqual(['BUTTON', 'Rename', 'F2'])
  expect([away!.tagName, away!.getAttribute('href')]).toEqual(['A', '/away'])
})

function key(element: Element | null, name: string) {
  element!.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
}

const labelOf = (element: Element | null) => element?.getAttribute('data-label')

async function richMenu(calls: string[]) {
  mounted = await mountComponent(MenuItems, { calls })

  return mounted.root
}

test('a Menu draws checkbox and radio entries with their role and state, headings and shortcuts', async () => {
  const root = await richMenu([])
  const rich = root.querySelector('#rich')!

  expect([...rich.querySelectorAll('[data-part=heading]')].map(heading => heading.textContent)).toEqual(['Show', 'Sort'])
  expect([...rich.querySelectorAll('[role=menuitemcheckbox]')].map(box => [labelOf(box), box.getAttribute('aria-checked')])).toEqual([['Word wrap', 'false'], ['Ruler', 'true']])
  expect([...rich.querySelectorAll('[role=menuitemradio]')].map(radio => [labelOf(radio), radio.getAttribute('aria-checked')])).toEqual([['Name', 'true'], ['Date', 'false']])
  expect([...rich.querySelectorAll('[data-part=shortcut]')].map(hint => hint.textContent)).toEqual(['Alt+Z', 'Ctrl+S'])
})

test('a checkbox with closeOnSelect false keeps the menu open and reports the new state, one the app leaves uncontrolled keeps its own', async () => {
  const calls: string[] = []
  const root = await richMenu(calls)
  const rich = root.querySelector<HTMLElement>('#rich')!

  rich.showPopover()
  await settle()
  click(rich.querySelector('[role=menuitemcheckbox]'))
  await settle()

  expect(rich.matches(':popover-open')).toBe(true)
  expect(rich.querySelector('[role=menuitemcheckbox]')!.getAttribute('aria-checked')).toBe('true')

  click(rich.querySelectorAll('[role=menuitemcheckbox]')[1]!)
  await settle()

  expect(calls).toEqual(['wrap true', 'ruler false'])
  expect(rich.matches(':popover-open')).toBe(false)
  expect(rich.querySelectorAll('[role=menuitemcheckbox]')[1]!.getAttribute('aria-checked')).toBe('false')
})

test('picking a radio checks it alone in its group and reports its value once; picking the checked one reports nothing', async () => {
  const calls: string[] = []
  const root = await richMenu(calls)
  const rich = root.querySelector<HTMLElement>('#rich')!
  const radios = () => [...rich.querySelectorAll('[role=menuitemradio]')].map(radio => radio.getAttribute('aria-checked'))

  click(rich.querySelectorAll('[role=menuitemradio]')[1]!)
  await settle()

  expect(radios()).toEqual(['false', 'true'])

  click(rich.querySelectorAll('[role=menuitemradio]')[1]!)

  expect(calls).toEqual(['sort date'])

  const own = [...root.querySelectorAll('#own [role=menuitemradio]')]

  expect(own.map(radio => radio.getAttribute('aria-checked'))).toEqual(['false', 'true'])
  click(own[0]!)
  await settle()
  expect([...root.querySelectorAll('#own [role=menuitemradio]')].map(radio => radio.getAttribute('aria-checked'))).toEqual(['true', 'false'])
})

test('ArrowRight opens a submenu and focuses its first entry, ArrowLeft closes it, and an entry of it closes the whole menu', async () => {
  const calls: string[] = []
  const root = await richMenu(calls)
  const rich = root.querySelector<HTMLElement>('#rich')!
  const trigger = rich.querySelector<HTMLElement>('[aria-haspopup=menu][role=menuitem]')!
  const panel = document.getElementById(trigger.getAttribute('popovertarget')!)!

  rich.showPopover()
  await settle()
  trigger.focus()
  key(trigger, 'ArrowRight')
  await settle()

  expect(panel.matches(':popover-open')).toBe(true)
  expect(document.activeElement?.textContent).toBe('Copy link')

  key(document.activeElement, 'ArrowDown')

  expect(document.activeElement?.textContent).toBe('Email')

  key(document.activeElement, 'ArrowLeft')
  await settle()

  expect(panel.matches(':popover-open')).toBe(false)
  expect(rich.matches(':popover-open')).toBe(true)

  key(trigger, 'ArrowRight')
  await settle()
  click(panel.querySelector('[data-part=item]'))
  await settle()

  expect(calls).toEqual(['link'])
  expect(rich.matches(':popover-open')).toBe(false)
})

test('typing letters moves to the next entry starting with them, a repeated letter cycling', async () => {
  const root = await richMenu([])
  const own = root.querySelector<HTMLElement>('#own')!

  own.showPopover()
  await settle()
  key(document.activeElement, 'a')

  expect(document.activeElement?.textContent).toBe('Apple')

  key(document.activeElement, 'a')

  expect(document.activeElement?.textContent).toBe('Avocado')

  await Bun.sleep(750)
  key(document.activeElement, 'b')

  expect(document.activeElement?.textContent).toBe('Banana')
})

test('two checkboxes with the same label keep their own state, and an id keeps it with the entry', async () => {
  const calls: string[] = []
  const root = await richMenu(calls)
  const boxes = () => [...root.querySelectorAll('#twins [role=menuitemcheckbox]')].map(box => box.getAttribute('aria-checked'))

  expect(boxes()).toEqual(['false', 'true', 'false'])

  click(root.querySelectorAll('#twins [role=menuitemcheckbox]')[0]!)
  await settle()

  expect(boxes()).toEqual(['true', 'true', 'false'])

  click(root.querySelectorAll('#twins [role=menuitemcheckbox]')[2]!)
  await settle()

  expect(boxes()).toEqual(['true', 'true', 'true'])
  expect(calls).toEqual(['first true', 'third true'])
})

test('a heading is a group naming the entries up to the next rule, and radios sharing a radioGroup sit in a group of their own', async () => {
  const root = await richMenu([])
  const rich = root.querySelector('#rich')!
  const [show, sort] = [...rich.querySelectorAll<HTMLElement>('[data-part=heading]')]
  const owned = (element: HTMLElement) => element.getAttribute('aria-owns')!.split(' ').map(id => document.getElementById(id)!)

  expect([show!.getAttribute('role'), show!.getAttribute('aria-labelledby')]).toEqual(['group', show!.id])
  expect(owned(show!).map(element => labelOf(element))).toEqual(['Word wrap', 'Ruler'])

  const [radios] = owned(sort!)

  expect(radios!.getAttribute('role')).toBe('group')
  expect(radios!.getAttribute('aria-labelledby')).toBe(sort!.id)
  expect(owned(radios!).map(element => element.getAttribute('role'))).toEqual(['menuitemradio', 'menuitemradio'])
})

test('a submenu follows open from the page and tells it whenever it opens or closes, and left alone the menu holds it', async () => {
  const calls: string[] = []
  const root = await richMenu(calls)
  const ctl = root.querySelector<HTMLElement>('#ctl')!
  const trigger = ctl.querySelector<HTMLElement>('[aria-haspopup=menu][role=menuitem]')!
  const panel = document.getElementById(trigger.getAttribute('popovertarget')!)!

  ctl.showPopover()
  await settle()
  trigger.focus()
  key(trigger, 'ArrowRight')
  await settle()

  expect(panel.matches(':popover-open')).toBe(true)
  expect(calls).toEqual(['sub true'])

  key(document.activeElement, 'ArrowLeft')
  await settle()

  expect(panel.matches(':popover-open')).toBe(false)
  expect(calls).toEqual(['sub true', 'sub false'])

  const share = root.querySelector('#rich [aria-haspopup=menu][role=menuitem]') as HTMLElement
  const own = document.getElementById(share.getAttribute('popovertarget')!)!

  root.querySelector<HTMLElement>('#rich')!.showPopover()
  await settle()
  share.focus()
  key(share, 'ArrowRight')

  expect(own.matches(':popover-open')).toBe(true)
})

test('a submenu opens when the pointer rests on its entry without taking the focus, and closes when the pointer moves to a sibling', async () => {
  const root = await richMenu([])
  const rich = root.querySelector<HTMLElement>('#rich')!
  const trigger = rich.querySelector<HTMLElement>('[aria-haspopup=menu][role=menuitem]')!
  const panel = document.getElementById(trigger.getAttribute('popovertarget')!)!
  const over = (element: Element) => element.dispatchEvent(new Event('pointerover', { bubbles: true }))

  rich.showPopover()
  await settle()
  over(trigger)

  expect(panel.matches(':popover-open')).toBe(false)

  await Bun.sleep(250)

  expect(panel.matches(':popover-open')).toBe(true)
  expect(rich.contains(document.activeElement) && panel.contains(document.activeElement)).toBe(false)

  over(panel.querySelector('[data-part=item]')!)

  expect(panel.matches(':popover-open')).toBe(true)

  over(rich.querySelector('[role=menuitemcheckbox]')!)

  expect(panel.matches(':popover-open')).toBe(false)

  over(trigger)
  over(rich.querySelector('[role=menuitemcheckbox]')!)
  await Bun.sleep(250)

  expect(panel.matches(':popover-open')).toBe(false)
})
