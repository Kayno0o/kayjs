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
  expect([...mounted.root.querySelectorAll('.kui-checkbox')].map(box => box.textContent)).toEqual(['I agreev2', 'Select all'])
  expect(mounted.root.querySelector('.kui-chip-group')?.getAttribute('aria-label')).toBe('Decks')

  click(mounted.root.querySelector('input[name="terms"]'))
  click(mounted.root.querySelector('input[value="books"]'))
  click(mounted.root.querySelector('input[value="games"]'))
  click(mounted.root.querySelector('input[value="music"]'))
  await settle()

  expect([fields(), agreed, picks]).toEqual([['on', ['films', 'books']], [true], [['films', 'games', 'books'], ['films', 'books']]])
})

test('a Checkbox starts indeterminate when its parent says so, and a click ticks it', async () => {
  mounted = await mount('src/components/choices.kay', { onAgree: () => undefined })

  const all = mounted.root.querySelector<HTMLInputElement>('#all')!

  expect([all.indeterminate, all.checked]).toEqual([true, false])

  click(all)
  await settle()

  expect([all.indeterminate, all.checked]).toEqual([false, true])
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
    expect(logged.mock.calls.map(([, error]) => error)).toEqual([new Error('refused')])
  }
  finally {
    logged.mockRestore()
  }
})
