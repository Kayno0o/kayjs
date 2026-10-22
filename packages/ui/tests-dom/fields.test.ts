import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import { click } from './dom'

let mounted: Mounted | undefined
const planets: string[] = []
const commits: string[] = []
const filters: string[] = []
const left: string[] = []
const picks: unknown[] = []

afterEach(() => {
  mounted?.unmount()
  planets.length = 0
  commits.length = 0
  filters.length = 0
  left.length = 0
  picks.length = 0
})

async function fields() {
  mounted = await mountComponent('src/components/fields.kay', { onPlanet: (value: string) => planets.push(value), onCommit: (value: string) => commits.push(value), onFilter: (query: string) => filters.push(query), onLeave: (id: string) => left.push(id), onPicked: (picked: unknown) => picks.push(picked) })

  return mounted.root
}

function type(input: HTMLInputElement | HTMLTextAreaElement, value: string, event = 'input') {
  input.value = value
  input.dispatchEvent(new Event(event, { bubbles: true }))
}

describe('TextInput', () => {
  test('reports what is typed, commits on change, and shows what its parent writes', async () => {
    const root = await fields()
    const input = root.querySelector<HTMLInputElement>('#name')!

    expect(input.value).toBe('Ada')

    type(input, 'Grace')
    await settle()

    expect(root.querySelector('#echo')?.textContent).toBe('Grace')

    type(input, 'Grace', 'change')
    click(root.querySelector('#clear'))
    await settle()

    expect(commits).toEqual(['Grace'])
    expect(input.value).toBe('')
  })

  test('hands its own blur to an onBlur it is given', async () => {
    const root = await fields()
    const input = root.querySelector<HTMLInputElement>('#name')!

    input.focus()
    input.blur()
    await settle()

    expect(left).toEqual(['name'])
  })

  test('leaves a number being typed as it is spelled when its parent writes back the same figure', async () => {
    const root = await fields()
    const input = root.querySelector<HTMLInputElement>('#amount')!

    type(input, '2.50')
    await settle()

    expect(root.querySelector('#figure')?.textContent).toBe('number 2.5')
    expect(input.value).toBe('2.50')
  })

  test('hands a number box back as a number, or null once emptied, and empties it when its parent writes null', async () => {
    const root = await fields()
    const input = root.querySelector<HTMLInputElement>('#amount')!

    expect(input.value).toBe('2')

    type(input, '')
    await settle()

    expect(root.querySelector('#figure')?.textContent).toBe('none')

    type(input, '0')
    await settle()

    expect(root.querySelector('#figure')?.textContent).toBe('number 0')

    type(input, '3', 'change')
    type(input, '', 'change')

    expect(picks).toEqual([3, null])

    click(root.querySelector('#reset'))
    await settle()

    expect(input.value).toBe('')
  })

  test('keeps what is typed with no value nor onInput, as a plain field of a form', async () => {
    const root = await fields()
    const input = root.querySelector<HTMLInputElement>('#plain')!

    expect(input.value).toBe('')

    type(input, 'ada@kaynooo.fr')
    type(input, 'ada@kaynooo.fr', 'change')
    input.dispatchEvent(new Event('blur'))
    await settle()

    expect(input.value).toBe('ada@kaynooo.fr')
  })
})

describe('Textarea', () => {
  test('leaves the box as typed while focused, and takes the parent\'s reading of it once left', async () => {
    const root = await fields()
    const area = root.querySelector<HTMLTextAreaElement>('#roster')!

    expect(area.value).toBe('Ada\nGrace')

    area.focus()
    type(area, 'Ada\nGrace\n\nLin ')
    await settle()

    expect(root.querySelector('#names')?.textContent).toBe('Ada\nGrace\nLin')
    expect(area.value).toBe('Ada\nGrace\n\nLin ')

    area.blur()
    await settle()

    expect(area.value).toBe('Ada\nGrace\nLin')
    expect(left).toEqual(['roster'])
  })
})

describe('Textarea cleared by its parent', () => {
  test('refuses any write of the parent while focused, an empty one included', async () => {
    const root = await fields()
    const area = root.querySelector<HTMLTextAreaElement>('#draft')!

    area.focus()
    type(area, 'Hello')
    await settle()
    expect(area.value).toBe('Hello')

    root.querySelector<HTMLButtonElement>('#send')!.click()
    await settle()
    expect(area.value).toBe('Hello')

    root.querySelector<HTMLButtonElement>('#restore')!.click()
    await settle()
    expect(area.value).toBe('Hello')
    expect(root.querySelector<HTMLTextAreaElement>('#live')!.value).toBe('Back')
  })

  test('takes any write while focused behind writeFocused', async () => {
    const root = await fields()
    const live = root.querySelector<HTMLTextAreaElement>('#live')!

    live.focus()
    root.querySelector<HTMLButtonElement>('#restore')!.click()
    await settle()
    expect(live.value).toBe('Back')
  })
})

describe('Select', () => {
  test('reports the option picked, with a disabled row while its options load', async () => {
    const root = await fields()
    const select = root.querySelector<HTMLSelectElement>('#planet')!

    expect([...select.options].map(option => [option.value, option.disabled])).toEqual([['', true], ['mars', false], ['earth', false]])
    expect(select.value).toBe('mars')

    select.value = 'earth'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()

    expect(planets).toEqual(['earth'])
  })

  test('hands back the option\'s own value, a number for a number option, and the empty string for the empty option', async () => {
    const root = await fields()
    const pick = (id: string, value: string) => {
      const select = root.querySelector<HTMLSelectElement>(id)!

      select.value = value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    }

    expect(root.querySelector<HTMLSelectElement>('#level')!.value).toBe('1')

    pick('#level', '2')
    pick('#kind', 'page')
    pick('#kind', '')
    await settle()

    expect(picks).toEqual([2, 'page', ''])
  })

  test('submits the form holding it once an option is picked, when asked', async () => {
    const root = await fields()
    const select = root.querySelector<HTMLSelectElement>('#filters select')!

    select.value = '7d'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()

    expect(filters).toEqual(['7d'])
  })
})
