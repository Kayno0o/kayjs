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

  expect(fields()).toEqual({ range: 'day', sharing: 'private' })

  click(mounted.root.querySelector('input[value="week"]'))
  click(mounted.root.querySelector('input[name="digest"]'))
  await settle()

  expect(fields()).toEqual({ range: 'week', digest: 'on', sharing: 'private' })
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

test('a Toggle goes back when onChange throws, and waits on any promise-like it answers', async () => {
  let answer: () => unknown = () => {
    throw new Error('offline')
  }
  const logged = spyOn(console, 'error').mockImplementation(() => undefined)

  mounted = await mount('src/components/controls.kay', { onRange: () => undefined, onDigest: () => undefined, onPublish: () => answer() })

  const input = mounted.root.querySelector<HTMLInputElement>('input[name="public"]')!

  try {
    click(input)
    await settle()

    expect([input.checked, logged.mock.calls.map(([, error]) => error)]).toEqual([false, [new Error('offline')]])

    // A promise-like of another library, not a \`Promise\`.
    answer = () => ({ then: (resolve: (value: boolean) => void) => resolve(false) })
    click(input)
    await settle()

    expect(input.checked).toBe(false)
  }
  finally {
    logged.mockRestore()
  }
})

test('a Toggle leaves the switch where its parent set it while a refused change was under way', async () => {
  const logged = spyOn(console, 'error').mockImplementation(() => undefined)

  mounted = await mount('src/components/controls.kay', { onRange: () => undefined, onDigest: () => undefined, onPublish: async () => Promise.reject(new Error('refused')), mirror: true })

  const input = mounted.root.querySelector<HTMLInputElement>('input[name="public"]')!

  click(input)
  await settle()
  logged.mockRestore()

  expect(input.checked).toBe(true)
})

test('a Segmented group whose change is under way is busy and picks nothing else, and goes back once the change is refused', async () => {
  const calls: string[] = []
  const settles: ((answer: boolean | Error | void) => void)[] = []
  const logged = spyOn(console, 'error').mockImplementation(() => undefined)

  mounted = await mount('src/components/controls.kay', {
    onRange: () => undefined,
    onDigest: () => undefined,
    onShare: async (value: string) => {
      calls.push(value)

      return new Promise<boolean | void>((resolve, reject) => settles.push(answer => answer instanceof Error ? reject(answer) : resolve(answer)))
    },
  })

  const { root } = mounted
  const radio = (value: string) => root.querySelector<HTMLInputElement>(`input[name="sharing"][value="${value}"]`)!
  const state = () => [[...root.querySelectorAll<HTMLInputElement>('input[name="sharing"]')].find(input => input.checked)?.value, root.querySelector('#share')!.getAttribute('aria-busy')]

  try {
    click(radio('link'))
    await settle()
    click(radio('public'))
    await settle()

    expect([state(), calls]).toEqual([['link', 'true'], ['link']])

    settles.at(-1)!(false)
    await settle()

    expect(state()).toEqual(['private', null])

    click(radio('public'))
    await settle()
    settles.at(-1)!(new Error('refused'))
    await settle()

    expect(state()).toEqual(['private', null])

    click(radio('public'))
    await settle()
    settles.at(-1)!()
    await settle()

    expect([state(), calls]).toEqual([['public', null], ['link', 'public', 'public']])
    expect(logged.mock.calls.map(([, error]) => error)).toEqual([new Error('refused')])
  }
  finally {
    logged.mockRestore()
  }
})

test('a Segmented group leaves the option its parent picked while a refused change was under way', async () => {
  const logged = spyOn(console, 'error').mockImplementation(() => undefined)

  mounted = await mount('src/components/controls.kay', { onRange: () => undefined, onDigest: () => undefined, onShare: async () => Promise.reject(new Error('refused')), mirror: true })

  const link = mounted.root.querySelector<HTMLInputElement>('input[name="sharing"][value="link"]')!

  click(link)
  await settle()
  logged.mockRestore()

  expect(link.checked).toBe(true)
})
