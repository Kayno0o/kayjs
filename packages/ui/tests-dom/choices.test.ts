import type { Mounted } from 'kay/test'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { mount, settle } from 'kay/test'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

test('Checkbox and ChipGroup submit like the fields they are, and report each change', async () => {
  const agreed: boolean[] = []
  const picks: string[][] = []

  mounted = await mount('src/components/choices.kay', { onAgree: (checked: boolean) => agreed.push(checked), onDecks: (value: string[]) => picks.push(value) })

  const fields = () => {
    const data = new FormData(mounted!.root.querySelector('form')!)

    return [data.get('terms'), data.getAll('decks')]
  }

  expect(fields()).toEqual([null, ['films', 'games']])
  expect([...mounted.root.querySelectorAll('.kui-checkbox')].map(box => box.textContent)).toEqual(['I agreev2', 'Select all', 'Some'])
  expect(mounted.root.querySelector('.kui-chip-group')?.getAttribute('aria-label')).toBe('Decks')

  click(mounted.root.querySelector('input[name="terms"]'))
  click(mounted.root.querySelector('input[value="books"]'))
  click(mounted.root.querySelector('input[value="games"]'))
  click(mounted.root.querySelector('input[value="music"]'))
  await settle()

  expect([fields(), agreed, picks]).toEqual([['on', ['films', 'books']], [true], [['films', 'games', 'books'], ['films', 'books']]])
})

test('a Checkbox is indeterminate while its parent says so, a click toggling it from checked', async () => {
  mounted = await mount('src/components/choices.kay', { onAgree: () => undefined })

  const all = mounted.root.querySelector<HTMLInputElement>('#all')!
  const kept = mounted.root.querySelector<HTMLInputElement>('#kept')!

  expect([all.indeterminate, all.checked, kept.indeterminate]).toEqual([true, false, true])

  // A browser clears it on a click, which happy-dom does not.
  for (const box of [all, kept]) {
    box.indeterminate = false
    click(box)
  }
  await settle()

  expect([all.indeterminate, all.checked, kept.indeterminate, kept.checked]).toEqual([false, true, true, true])

  click(mounted.root.querySelector('#mix'))
  await settle()

  expect([all.indeterminate, all.checked]).toEqual([true, true])
})

test('a Checkbox whose change is under way is busy and ticks no further, and goes back once the change is refused', async () => {
  const settles: ((answer: boolean | Error | void) => void)[] = []
  const logged = spyOn(console, 'error').mockImplementation(() => undefined)

  mounted = await mount('src/components/choices.kay', {
    onAgree: async () => new Promise<boolean | void>((resolve, reject) => settles.push(answer => answer instanceof Error ? reject(answer) : resolve(answer))),
  })

  const input = mounted.root.querySelector<HTMLInputElement>('input[name="terms"]')!
  const state = () => [input.checked, input.getAttribute('aria-busy')]

  try {
    click(input)
    await settle()
    click(input)
    await settle()

    expect([state(), settles.length]).toEqual([[true, 'true'], 1])

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

    expect(state()).toEqual([true, null])
    expect(logged.mock.calls.map(([, error]) => error as unknown)).toEqual([new Error('refused')])
  }
  finally {
    logged.mockRestore()
  }
})

test('a ChipGroup whose change is under way is busy and ticks nothing else, and goes back once the change is refused', async () => {
  const settles: ((answer: boolean | Error | void) => void)[] = []
  const logged = spyOn(console, 'error').mockImplementation(() => undefined)

  mounted = await mount('src/components/choices.kay', {
    onAgree: () => undefined,
    onDecks: async () => new Promise<boolean | void>((resolve, reject) => settles.push(answer => answer instanceof Error ? reject(answer) : resolve(answer))),
  })

  const group = mounted.root.querySelector('.kui-chip-group')!
  const state = () => [[...group.querySelectorAll<HTMLInputElement>('input:checked')].map(box => box.value), group.getAttribute('aria-busy')]

  try {
    click(group.querySelector('input[value="books"]'))
    await settle()
    click(group.querySelector('input[value="films"]'))
    await settle()

    expect([state(), settles.length]).toEqual([[['films', 'games', 'books'], 'true'], 1])

    settles.at(-1)!(false)
    await settle()

    expect(state()).toEqual([['films', 'games'], null])

    click(group.querySelector('input[value="games"]'))
    await settle()
    settles.at(-1)!(new Error('refused'))
    await settle()

    expect(state()).toEqual([['films', 'games'], null])

    click(group.querySelector('input[value="games"]'))
    await settle()
    settles.at(-1)!()
    await settle()

    expect(state()).toEqual([['films'], null])
    expect(logged.mock.calls.map(([, error]) => error as unknown)).toEqual([new Error('refused')])
  }
  finally {
    logged.mockRestore()
  }
})
