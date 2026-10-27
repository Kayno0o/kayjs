import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'
import Gestures from '../tests/fixture/src/components/mounted-gestures.kay'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

test('type, click and press drive a TextInput, a Select and a Segmented as a browser does', async () => {
  const told: string[] = []

  mounted = await mountComponent(Gestures, { onTold: (line: string) => told.push(line) })

  const { root, type, click, press } = mounted

  await type('#name', 'Ada')
  expect(told).toEqual(['input Ada'])

  await press('Enter')
  expect(told).toEqual(['input Ada', 'change Ada'])

  await type('#level', 'High')
  expect(told.at(-1)).toBe('level high')

  await click('input[value="large"]')
  expect(told.at(-1)).toBe('size large')
  expect(root.querySelector<HTMLInputElement>('input[value="large"]')!.checked).toBe(true)
})
