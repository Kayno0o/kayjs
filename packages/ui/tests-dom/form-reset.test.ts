import type { Mounted } from 'kay/test'
import type { IconChoice } from '../src/icon-picker'
import { afterEach, describe, expect, test } from 'bun:test'
import { trustHtml } from 'kay'
import { mount, settle } from 'kay/test'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

function choice(name: string): IconChoice {
  return { name, icon: { 'viewBox': '0 0 24 24', 'width': '1em', 'height': '1em', 'aria-hidden': 'true', 'innerHTML': trustHtml(`<path data-icon="${name}"/>`) } }
}

const ICONS = ['star', 'moon'].map(choice)

async function form() {
  mounted = await mount('src/components/form-reset.kay', { search: async () => ICONS })
  await settle()

  return mounted.root
}

const state = (root: HTMLElement) => JSON.parse(root.querySelector('#state')!.textContent!) as Record<string, unknown>

function type(root: HTMLElement, selector: string, value: string, event = 'input') {
  const field = root.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector)!

  field.value = value
  field.dispatchEvent(new Event(event, { bubbles: true }))
}

// Every control moved off its start, as a person would.
async function edit(root: HTMLElement) {
  click(root.querySelector('input[name="agree"]'))
  click(root.querySelector('input[name="power"]'))
  click(root.querySelector('#free'))
  click(root.querySelector('input[name="decks"][value="games"]'))
  click(root.querySelector('input[name="decks"][value="films"]'))
  click(root.querySelector('input[name="size"][value="l"]'))
  type(root, '#level', 'c', 'change')
  click(root.querySelector('.kui-multi-select-trigger'))
  click(root.querySelectorAll('.kui-multi-select-checkbox')[0] ?? null)
  click(root.querySelectorAll('.kui-multi-select-checkbox')[2] ?? null)
  type(root, '#title', 'Grace')
  type(root, '#bio', 'Bye')
  type(root, '#notes', '# Other')
  type(root, 'input[aria-label="Range from"]', '4', 'change')
  type(root, 'input[aria-label="Range to"]', '9', 'change')
  click(root.querySelector('.kui-icon-grid-option[aria-label="moon"]'))
  await settle()
}

const START = { agree: true, power: false, free: false, decks: ['films'], size: 'm', level: 'b', tags: ['x', 'y'], title: 'Ada', bio: 'Hello', notes: '# Notes', range: [2, 8], icon: 'star' }

describe('a form reset', () => {
  test('puts every signal-driven control and the page signal behind it back on its start', async () => {
    const root = await form()

    expect(state(root)).toEqual(START)
    await edit(root)
    expect(state(root)).toEqual({ agree: false, power: true, free: true, decks: ['games'], size: 'l', level: 'c', tags: ['y', 'z'], title: 'Grace', bio: 'Bye', notes: '# Other', range: [4, 9], icon: 'moon' })

    click(root.querySelector('#reset'))
    await settle()

    expect(state(root)).toEqual(START)
  })

  test('shows the start in the controls themselves, and submits it', async () => {
    const root = await form()

    await edit(root)
    root.querySelector<HTMLFormElement>('#form')!.reset()
    await settle()

    const data = new FormData(root.querySelector('form')!)

    expect([...data].map(([name, value]) => `${name}=${String(value)}`).sort()).toEqual(['agree=on', 'decks=films', 'icon=star', 'level=b', 'size=m', 'tags=x', 'tags=y', 'title=Ada', 'bio=Hello'].sort())
    expect(root.querySelector<HTMLInputElement>('input[name="agree"]')!.checked).toBe(true)
    expect(root.querySelector<HTMLInputElement>('input[name="power"]')!.checked).toBe(false)
    expect([...root.querySelectorAll<HTMLInputElement>('.kui-multi-select-checkbox')].map(box => box.checked)).toEqual([true, true, false])
    expect(root.querySelector('.kui-multi-select-trigger')!.getAttribute('aria-label')).toBe('Tags: 2 selected')
    expect(root.querySelector<HTMLInputElement>('input[aria-label="Range from"]')!.value).toBe('2')
  })

  test('on a form left as it started tells the page nothing', async () => {
    const root = await form()

    root.querySelector<HTMLFormElement>('#form')!.reset()
    await settle()

    expect(state(root)).toEqual(START)
  })

  test('that something cancels leaves the controls where they are', async () => {
    const root = await form()

    root.querySelector('#form')!.addEventListener('reset', event => event.preventDefault())
    await edit(root)
    root.querySelector<HTMLFormElement>('#form')!.reset()
    await settle()

    expect(state(root).title).toBe('Grace')
  })

  test('can be run twice in a row', async () => {
    const root = await form()

    await edit(root)
    click(root.querySelector('#reset'))
    await settle()
    await edit(root)
    click(root.querySelector('#reset'))
    await settle()

    expect(state(root)).toEqual(START)
  })
})
