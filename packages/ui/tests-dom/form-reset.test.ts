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

const state = (root: HTMLElement) => JSON.parse(root.querySelector('#state')!.textContent) as Record<string, unknown>

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
  click(root.querySelector('input[name="sort"][value="l"]'))
  type(root, '#formname', 'y')
  type(root, '#level', 'c', 'change')
  click(root.querySelector('.kui-multi-select-trigger'))
  click(root.querySelectorAll('.kui-multi-select-checkbox')[0] ?? null)
  click(root.querySelectorAll('.kui-multi-select-checkbox')[2] ?? null)
  type(root, '#title', 'Grace')
  type(root, '#bio', 'Bye')
  type(root, '#notes', '# Other')
  type(root, 'input[aria-label="Range from"]', '4', 'change')
  type(root, 'input[aria-label="Range to"]', '9', 'change')
  click(root.querySelector('#named .kui-icon-grid-option[aria-label="moon"]'))
  click(root.querySelector('#bare .kui-icon-grid-option[aria-label="moon"]'))
  type(root, '#fixed', 'a', 'change')
  type(root, '#bare input[type="search"]', 'mo')
  await settle()
}

const START = { agree: true, power: false, free: false, decks: ['films'], size: 'm', level: 'b', tags: ['x', 'y'], title: 'Ada', bio: 'Hello', notes: '# Notes', range: [2, 8], icon: 'star', bare: 'star', heard: 'b', refd: true, form: 'x' }

describe('a form reset', () => {
  test('puts every signal-driven control and the page signal behind it back on its start', async () => {
    const root = await form()

    expect(state(root)).toEqual(START)
    await edit(root)
    expect(state(root)).toEqual({ agree: false, power: true, free: true, decks: ['games'], size: 'l', level: 'c', tags: ['y', 'z'], title: 'Grace', bio: 'Bye', notes: '# Other', range: [4, 9], icon: 'moon', bare: 'moon', heard: 'a', refd: true, form: 'y' })

    click(root.querySelector('#reset'))
    await settle()

    expect(state(root)).toEqual(START)
    expect(root.querySelector<HTMLInputElement>('#bare input[type="search"]')!.value).toBe('')
    expect(root.querySelector('input[name="sort"]:checked')).toBeNull()
  })

  test('shows the start in the controls themselves, and submits it', async () => {
    const root = await form()

    await edit(root)
    root.querySelector<HTMLFormElement>('#form')!.reset()
    await settle()

    const data = new FormData(root.querySelector('form')!)

    expect([...data].map(([name, value]) => `${name}=${String(value)}`).sort()).toEqual(['agree=on', 'decks=films', 'icon=star', 'level=b', 'size=m', 'tags=x', 'tags=y', 'title=Ada', 'bio=Hello', 'form=x'].sort())
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

// A change the app is still answering when the form resets.
describe('a form reset during a change under way', () => {
  const checked = (root: HTMLElement, selector: string) => [...root.querySelectorAll<HTMLInputElement>(selector)].map(one => one.checked).join()
  const CASES = [
    { name: 'a Checkbox', selector: 'input[name="agree"]', changed: 'agree=false', restored: 'agree=true', shown: (root: HTMLElement) => checked(root, 'input[name="agree"]'), back: 'true' },
    { name: 'a Toggle', selector: 'input[name="power"]', changed: 'power=true', restored: 'power=false', shown: (root: HTMLElement) => checked(root, 'input[name="power"]'), back: 'false' },
    { name: 'a ChipGroup', selector: 'input[name="decks"][value="games"]', changed: 'decks=films,games', restored: 'decks=films', shown: (root: HTMLElement) => checked(root, 'input[name="decks"]'), back: 'true,false' },
    { name: 'a Segmented', selector: 'input[name="size"][value="l"]', changed: 'size=l', restored: 'size=m', shown: (root: HTMLElement) => checked(root, 'input[name="size"]'), back: 'false,true,false' },
  ]

  for (const { name, selector, changed, restored, shown, back } of CASES) {
    for (const answer of [true, false]) {
      test(`waits for ${name}'s change to ${answer ? 'be accepted' : 'be refused'}, then has its start back, told to the app unless the refusal already did`, async () => {
        const gate = Promise.withResolvers<boolean>()
        const told: string[] = []

        mounted = await mount('src/components/form-reset-busy.kay', {
          answer: async (control: string, value: unknown) => {
            told.push(`${control}=${String(value)}`)

            return told.length === 1 ? gate.promise : undefined
          },
        })
        await settle()

        const root = mounted.root

        click(root.querySelector(selector))
        click(root.querySelector('#reset'))
        await settle()

        expect(told).toEqual([changed])

        gate.resolve(answer)
        await settle()

        expect(told).toEqual(answer ? [changed, restored] : [changed])
        expect(shown(root)).toBe(back)
        expect(root.querySelector('[aria-busy="true"]')).toBeNull()
      })
    }
  }

  async function waiting() {
    const gate = Promise.withResolvers<boolean>()
    const told: string[] = []

    mounted = await mount('src/components/form-reset-busy.kay', {
      answer: async (control: string, value: unknown) => {
        told.push(`${control}=${String(value)}`)

        return told.length === 1 ? gate.promise : undefined
      },
    })
    await settle()

    return { gate, told, root: mounted.root }
  }

  test('twice in a row restores once', async () => {
    const { gate, told, root } = await waiting()

    click(root.querySelector('input[name="size"][value="l"]'))
    click(root.querySelector('#reset'))
    click(root.querySelector('#reset'))
    await settle()
    gate.resolve(true)
    await settle()

    expect(told).toEqual(['size=l', 'size=m'])
  })

  test('leaves a Segmented on its start when a click meets the wait', async () => {
    const { gate, told, root } = await waiting()

    click(root.querySelector('input[name="size"][value="l"]'))
    click(root.querySelector('#reset'))
    await settle()
    click(root.querySelector('input[name="size"][value="s"]'))
    await settle()

    expect(told).toEqual(['size=l'])
    expect(root.querySelector<HTMLInputElement>('input[name="size"]:checked')!.value).toBe('m')

    gate.resolve(true)
    await settle()

    expect(told).toEqual(['size=l', 'size=m'])
    expect(root.querySelector<HTMLInputElement>('input[name="size"]:checked')!.value).toBe('m')
  })

  test('is dropped once the control is gone', async () => {
    const { gate, told, root } = await waiting()

    click(root.querySelector('input[name="agree"]'))
    click(root.querySelector('#reset'))
    await settle()
    mounted!.unmount()
    gate.resolve(true)
    await settle()

    expect(told).toEqual(['agree=false'])
  })
})

describe('the app\'s ref on a control', () => {
  test('gets the element once, however often the control\'s attributes change', async () => {
    const got: string[] = []

    mounted = await mount('src/components/form-reset-ref.kay', { got: (name: string, element: Element) => got.push(`${name}:${element.tagName}`) })
    await settle()
    click(mounted.root.querySelector('#change'))
    await settle()

    expect(got.sort()).toEqual(['markdown:TEXTAREA', 'select:SELECT', 'text:INPUT', 'textarea:TEXTAREA'])
  })
})
