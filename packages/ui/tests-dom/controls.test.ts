import type { Mounted } from 'kay/test'
import { afterEach, expect, spyOn, test } from 'bun:test'
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

  expect(fields()).toMatchObject({ range: 'day' })

  click(mounted.root.querySelector('input[value="week"]'))
  click(mounted.root.querySelector('input[name="digest"]'))
  await settle()

  expect(fields()).toMatchObject({ range: 'week', digest: 'on' })
  expect(ranges).toEqual(['week'])
  expect(digests).toEqual([true])

  click(mounted.root.querySelector('input[name="digest"]'))
  await settle()

  expect(digests).toEqual([true, false])
})

test('a Toggle whose change is under way is busy and flips no further, and goes back once the change is refused', async () => {
  const calls: boolean[] = []
  const settles: ((answer: boolean | Error | void) => void)[] = []
  const logged = spyOn(console, 'error').mockImplementation(() => undefined)

  mounted = await mount('src/components/controls.kay', {
    onRange: () => undefined,
    onDigest: () => undefined,
    onPublish: async (checked: boolean) => {
      calls.push(checked)

      return new Promise<boolean | void>((resolve, reject) => settles.push(answer => answer instanceof Error ? reject(answer) : resolve(answer)))
    },
  })

  const input = mounted.root.querySelector<HTMLInputElement>('input[name="public"]')!
  const state = () => [input.checked, input.getAttribute('aria-busy')]

  try {
    click(input)
    await settle()
    click(input)
    await settle()

    expect([state(), calls]).toEqual([[true, 'true'], [true]])

    settles.at(-1)!(false)
    await settle()

    expect(state()).toEqual([false, null])

    click(input)
    await settle()
    settles.at(-1)!(new Error('refused'))
    await settle()

    expect(state()).toEqual([false, null])

    click(input)
    await settle()
    settles.at(-1)!()
    await settle()

    expect([state(), calls]).toEqual([[true, null], [true, true, true]])
    expect(logged.mock.calls.map(([, error]) => error)).toEqual([new Error('refused')])
  }
  finally {
    logged.mockRestore()
  }
})
