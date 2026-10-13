import { describe, expect, test } from 'bun:test'
import { editing } from '../src/editing'

interface Friend {
  id: number
  name: string
}

describe('editing', () => {
  test('opens on a row or a draft, each taking the place of the other, and forgets both once closed', () => {
    const friend = editing<Friend, { name: string }>()
    const ada = { id: 1, name: 'Ada' }
    const state = () => [friend.open(), friend.row(), friend.draft()]

    expect(state()).toEqual([false, undefined, undefined])

    friend.edit(ada)

    expect(state()).toEqual([true, ada, undefined])
    expect(friend.row()).toBe(ada)

    friend.create({ name: 'Grace' })

    expect(state()).toEqual([true, undefined, { name: 'Grace' }])

    friend.close()

    expect(state()).toEqual([false, undefined, undefined])
  })

  test('opens on nothing to start from when the draft is left out, and holds a function row as it is', () => {
    const blank = editing<() => string>()
    const greet = () => 'hi'

    blank.create()

    expect([blank.open(), blank.draft()]).toEqual([true, undefined])

    blank.edit(greet)

    expect(blank.row()).toBe(greet)
  })
})
