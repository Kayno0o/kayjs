import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

type Told = [name: string, value: number | string | null]

async function open(answer: (name: string, value: number | string | null) => unknown = () => undefined) {
  const told: Told[] = []

  mounted = await mountComponent('src/components/segmented-number.kay', { onChange: (name: string, value: number | string | null) => {
    told.push([name, value])

    return answer(name, value)
  } })

  const root = mounted.root
  const checked = (name: string) => root.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value ?? null
  const state = () => JSON.parse(root.querySelector('#state')!.textContent) as { size: number, held: number | null }
  const pick = async (name: string, value: number) => {
    click(root.querySelector(`input[name="${name}"][value="${value}"]`))
    await settle()
  }

  return { root, told, checked, state, pick }
}

test('shows the number its parent passes as the checked radio, 0 included', async () => {
  const { checked } = await open()

  expect([checked('size'), checked('held')]).toEqual(['10', '0'])
})

test('tells onChange the option\'s own number, 0 included, never its text', async () => {
  const { told, state, pick, checked } = await open()

  await pick('size', 25)
  await pick('size', 0)

  expect(told).toEqual([['size', 25], ['size', 0]])
  expect([state().size, checked('size')]).toEqual([0, '0'])
})

test('picks none while the parent passes null, and the radio of a number again once it goes back to one', async () => {
  const { root, state, pick, checked, told } = await open()

  click(root.querySelector('#none'))
  await settle()

  expect([state().held, checked('held')]).toEqual([null, null])

  await pick('held', 0)

  expect([state().held, checked('held'), told]).toEqual([0, '0', [['held', 0]]])
})

test('a reset puts the radios back on their start and tells onChange the number, or null for none', async () => {
  const { root, told, state, pick, checked } = await open()

  await pick('size', 25)
  await pick('held', 10)
  click(root.querySelector('#reset'))
  await settle()

  expect([checked('size'), checked('held'), state()]).toEqual(['10', '0', { size: 10, held: 0 }])
  expect(told.slice(2).sort()).toEqual([['held', 0], ['size', 10]])
})

test('a reset of a group that started with none tells onChange null', async () => {
  const { root, told, pick, checked } = await open()

  await pick('sort', 25)
  click(root.querySelector('#reset'))
  await settle()

  expect([checked('sort'), told.at(-1)]).toEqual([null, ['sort', null]])
})

test('puts the previous number back when the change is refused, and holds the group busy meanwhile', async () => {
  const gate = Promise.withResolvers<boolean>()
  const { root, told, checked, pick } = await open(async () => gate.promise)

  await pick('fixed', 25)

  expect(root.querySelector('input[name="fixed"]')!.closest('[aria-busy]')?.getAttribute('aria-busy')).toBe('true')

  click(root.querySelector('input[name="fixed"][value="0"]'))
  await settle()

  expect([told, checked('fixed')]).toEqual([[['fixed', 25]], '25'])

  gate.resolve(false)
  await settle()

  expect(checked('fixed')).toBe('10')
})

test('tells a number from the same text apart, by the option\'s place', async () => {
  const { root, told, checked } = await open()
  const radios = () => [...root.querySelectorAll<HTMLInputElement>('input[name="mixed"]')].map(radio => radio.checked)

  expect(radios()).toEqual([true, false])

  click(root.querySelectorAll('input[name="mixed"]')[1] ?? null)
  await settle()
  click(root.querySelector('#reset'))
  await settle()

  expect([told, radios(), checked('mixed')]).toEqual([[['mixed', '1'], ['mixed', 1]], [true, false], '1'])
})
