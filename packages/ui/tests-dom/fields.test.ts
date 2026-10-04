import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, test } from 'bun:test'
import { mount, settle } from 'kay/test'
import { click } from './dom'

let mounted: Mounted | undefined
const planets: string[] = []
const commits: string[] = []

afterEach(() => {
  mounted?.unmount()
  planets.length = 0
  commits.length = 0
})

async function fields() {
  mounted = await mount('src/components/fields.kay', { onPlanet: (value: string) => planets.push(value), onCommit: (value: string) => commits.push(value) })

  return mounted.root
}

function type(input: HTMLInputElement, value: string, event = 'input') {
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

  test('leaves a number being typed as it is spelled when its parent writes back the same figure', async () => {
    const root = await fields()
    const input = root.querySelector<HTMLInputElement>('#amount')!

    type(input, '2.50')
    await settle()

    expect(root.querySelector('#figure')?.textContent).toBe('2.5')
    expect(input.value).toBe('2.50')
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
})
