import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

async function open() {
  const told: number[] = []

  mounted = await mountComponent('src/components/radio-group.kay', { onChange: (value: number) => told.push(value) })

  const root = mounted.root
  const radios = () => [...root.querySelectorAll<HTMLInputElement>('input[name="plan"]')]

  return { root, told, radios, checked: () => radios().find(radio => radio.checked)?.value ?? null }
}

test('draws real radios, the first checked, a disabled option and a description beside its label', async () => {
  const { root, radios, checked } = await open()
  const first = radios()[0]!
  const described = root.querySelector(`#${first.getAttribute('aria-describedby')?.split(' ').at(0)}`)

  expect([radios().length, checked(), radios().map(radio => radio.disabled)]).toEqual([3, '1', [false, true, false]])
  expect(root.querySelector('[role="radiogroup"]')).not.toBeNull()
  expect(described?.textContent).toBe('Up to 3 sites')
  expect(root.querySelector('.kui-radio-choice')?.textContent).toBe('Free')
  expect(radios()[2]!.getAttribute('aria-describedby')?.split(' ').length).toBe(1)
})

test('tells onChange the option\'s own number, and a reset goes back to the start', async () => {
  const { root, radios, told, checked } = await open()

  click(radios()[2]!)
  await settle()

  expect([told, checked()]).toEqual([[3], '3'])

  click(root.querySelector('#reset'))
  await settle()

  expect([told, checked()]).toEqual([[3, 1], '1'])
})

test('a FormField around it shows the message and marks each radio invalid', async () => {
  const { root, radios } = await open()

  expect(root.querySelector('.kui-form-field-issue')?.textContent).toBe('Pick a plan')
  expect(radios().map(radio => radio.getAttribute('aria-invalid'))).toEqual(['true', 'true', 'true'])
})
