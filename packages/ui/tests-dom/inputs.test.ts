import type { Mounted } from 'kay/test'
import type { RangeValue } from '../src/range'
import { afterEach, describe, expect, test } from 'bun:test'
import { mount, settle } from 'kay/test'
import { click } from './dom'

let mounted: Mounted | undefined
// What the fixture reported, and whether the menu still showed as each action ran.
const seen: { range: RangeValue[], planets: string[][], files: string[][], actions: [string, boolean][] } = { range: [], planets: [], files: [], actions: [] }

afterEach(() => {
  mounted?.unmount()
  seen.range = []
  seen.planets = []
  seen.files = []
  seen.actions = []
})

async function inputs(paste = false) {
  mounted = await mount('src/components/inputs.kay', {
    onRange: (value: RangeValue) => seen.range.push(value),
    onPlanets: (value: string[]) => seen.planets.push(value),
    onFiles: (names: string[]) => seen.files.push(names),
    onAction: (name: string) => seen.actions.push([name, document.querySelector('.kui-menu')!.matches(':popover-open')]),
    paste,
  })

  return mounted.root
}

function type(input: Element | null, text: string, event = 'change') {
  (input as HTMLInputElement).value = text
  input!.dispatchEvent(new Event(event, { bubbles: true }))
}

function key(element: Element | null, name: string) {
  element!.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
}

describe('RangeInput', () => {
  test('commits the pair in order once a box changes, and only when the range did', async () => {
    const root = await inputs()
    const [low, high] = root.querySelectorAll<HTMLInputElement>('#range input')

    type(low!, '10')
    type(high!, '3')

    expect(seen.range).toEqual([[10, null], [3, 10]])
    expect([low!.value, high!.value]).toEqual(['3', '10'])

    type(high!, '10')

    expect(seen.range).toHaveLength(2)

    type(low!, '')

    expect(seen.range.at(-1)).toEqual([null, 10])
  })
})

describe('MultiSelect', () => {
  test('opens on a search box past eight options, focused, and filters the options as it is typed into', async () => {
    const root = await inputs()

    root.querySelector<HTMLElement>('#planets')!.showPopover()
    await settle()

    const search = root.querySelector('.kui-multi-select-search')

    expect(document.activeElement).toBe(search)

    type(search, 'ur', 'input')
    await settle()

    expect([...root.querySelectorAll('.kui-multi-select-label')].map(label => label.textContent)).toEqual(['Mercury', 'Saturn', 'Uranus'])

    type(search, 'zz', 'input')
    await settle()

    expect(root.querySelector('.kui-multi-select-empty')?.textContent).toBe('No match')
  })

  test('keeps what is picked in the options\' order, sums it up on the trigger, and posts each value', async () => {
    const root = await inputs()
    const box = (label: string) => [...root.querySelectorAll('.kui-multi-select-option')].find(option => option.textContent === label)!.querySelector('input')
    const summary = () => root.querySelector('.kui-multi-select-summary')?.textContent
    const posted = () => [...root.querySelectorAll<HTMLInputElement>('input[type="hidden"][name="planet"]')].map(input => input.value)

    expect(summary()).toBe('Any')

    click(box('Mars'))
    await settle()

    expect(summary()).toBe('Mars')

    click(box('Venus'))
    await settle()

    expect(seen.planets).toEqual([['mars'], ['venus', 'mars']])
    expect(summary()).toBe('2 selected')
    expect(posted()).toEqual(['venus', 'mars'])

    click(root.querySelectorAll('.kui-multi-select-action')[1]!)
    await settle()

    expect(posted()).toEqual([])

    click(root.querySelectorAll('.kui-multi-select-action')[0]!)
    await settle()

    expect(posted()).toHaveLength(9)
    expect(root.querySelector<HTMLButtonElement>('.kui-multi-select-action')?.disabled).toBe(true)
  })

  test('picks and drops only the options a search shows', async () => {
    const root = await inputs()
    const [all, none] = root.querySelectorAll<HTMLButtonElement>('.kui-multi-select-action')
    const posted = () => [...root.querySelectorAll<HTMLInputElement>('input[type="hidden"][name="planet"]')].map(input => input.value)

    click([...root.querySelectorAll('.kui-multi-select-option')].find(option => option.textContent === 'Venus')!.querySelector('input'))
    type(root.querySelector('.kui-multi-select-search'), 'ur', 'input')
    await settle()

    expect(none!.disabled).toBe(true)

    click(all!)
    await settle()

    expect([posted(), all!.disabled]).toEqual([['mercury', 'venus', 'saturn', 'uranus'], true])

    click(none!)
    await settle()

    expect(posted()).toEqual(['venus'])
  })
})

describe('FileDrop', () => {
  // A drop or a paste as the browser sends it, its files in `dataTransfer` or `clipboardData`.
  function files(...names: string[]) {
    return names.map(name => new File(['x'], name, { type: name.endsWith('.png') ? 'image/png' : name.endsWith('.svg') ? 'image/svg+xml' : 'text/plain' }))
  }

  test('takes the first dropped file its accept allows, and lights up while files hover it', async () => {
    const root = await inputs()
    const zone = root.querySelector('#drop')!
    const dataTransfer = { types: ['Files'], files: files('notes.txt', 'moon.png', 'logo.svg') }

    zone.dispatchEvent(Object.assign(new Event('dragover', { bubbles: true, cancelable: true }), { dataTransfer }))
    await settle()

    expect(zone.hasAttribute('data-dragging')).toBe(true)
    expect(root.querySelector('#pick')?.textContent).toBe('Drop it')

    zone.dispatchEvent(Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer }))
    await settle()

    expect(seen.files).toEqual([['moon.png']])
    expect(zone.hasAttribute('data-dragging')).toBe(false)
  })

  test('stays lit while the files move onto its own content, and goes dark once they leave it', async () => {
    const root = await inputs()
    const zone = root.querySelector('#drop')!
    const leave = (relatedTarget: Element) => zone.dispatchEvent(Object.assign(new Event('dragleave', { bubbles: true }), { relatedTarget }))

    zone.dispatchEvent(Object.assign(new Event('dragover', { bubbles: true, cancelable: true }), { dataTransfer: { types: ['Files'], files: [] } }))
    leave(root.querySelector('#pick')!)
    await settle()

    expect(zone.hasAttribute('data-dragging')).toBe(true)

    leave(document.body)
    await settle()

    expect(zone.hasAttribute('data-dragging')).toBe(false)
  })

  test('opens the picker from its content, and takes a paste outside a text field when asked', async () => {
    const root = await inputs(true)
    let opened = 0

    root.querySelector('.kui-file-drop-input')!.addEventListener('click', () => opened++)
    click(root.querySelector('#pick'))

    expect(opened).toBe(1)

    const paste = (target: Element) => target.dispatchEvent(Object.assign(new Event('paste', { bubbles: true, cancelable: true }), { clipboardData: { files: files('moon.png') } }))

    paste(root.querySelector('#field')!)
    paste(document.body)

    expect(seen.files).toEqual([['moon.png']])
  })
})

describe('Menu', () => {
  test('focuses its first entry on opening, moves past disabled ones with the arrows, and runs an action once closed', async () => {
    const root = await inputs()
    const menu = root.querySelector<HTMLElement>('.kui-menu')!
    const focused = () => document.activeElement?.textContent

    expect(root.querySelector(`[popovertarget="${menu.id}"]`)?.className).toBe('kui-icon-btn row-actions')
    expect(root.querySelector(`[popovertarget="${menu.id}"]`)?.getAttribute('aria-haspopup')).toBe('menu')

    menu.showPopover()
    await settle()

    expect(focused()).toBe('Rename')

    key(document.activeElement, 'ArrowDown')

    expect(focused()).toBe('Delete')

    key(document.activeElement, 'ArrowDown')

    expect(focused()).toBe('Rename')

    click(root.querySelectorAll('.kui-menu-item')[2]!)

    expect(seen.actions).toEqual([['delete', false]])
  })

  test('closes on Tab, a menu being one stop', async () => {
    const root = await inputs()
    const menu = root.querySelector<HTMLElement>('.kui-menu')!

    menu.showPopover()
    await settle()
    key(document.activeElement, 'Tab')

    expect(menu.matches(':popover-open')).toBe(false)
  })
})
