import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mount, settle } from 'kay/test'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

test('Segmented and Toggle submit like the fields they are, and report each change', async () => {
  const ranges: string[] = []
  const digests: boolean[] = []

  mounted = await mount('src/components/controls.kay', { onRange: (value: string) => ranges.push(value), onDigest: (checked: boolean) => digests.push(checked) })

  const form = mounted.root.querySelector('form')!
  const fields = () => Object.fromEntries(new FormData(form))

  expect(fields()).toEqual({ range: 'day' })

  click(mounted.root.querySelector('input[value="week"]'))
  click(mounted.root.querySelector('.kui-toggle-input'))
  await settle()

  expect(fields()).toEqual({ range: 'week', digest: 'on' })
  expect(ranges).toEqual(['week'])
  expect(digests).toEqual([true])

  click(mounted.root.querySelector('.kui-toggle-input'))
  await settle()

  expect(digests).toEqual([true, false])
})
