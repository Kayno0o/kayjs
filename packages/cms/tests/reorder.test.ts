import { describe, expect, it } from 'bun:test'
import { keyDirection, reordered, reorderKey, targetOf, unfoldAround } from '../src/editor/reorder'

function key(name: string, held: Partial<Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>> = {}): KeyboardEvent {
  return { key: name, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...held } as KeyboardEvent
}

describe('reordered', () => {
  it('puts the item taken out back at its new place', () => {
    expect(reordered(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
    expect(reordered(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c'])
    expect(reordered(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c'])
  })

  it('leaves the list it was given as it was', () => {
    const items = ['a', 'b']

    reordered(items, 0, 1)

    expect(items).toEqual(['a', 'b'])
  })
})

describe('targetOf', () => {
  it('steps one place, and stops at either end', () => {
    expect(targetOf('up', 1, 3)).toBe(0)
    expect(targetOf('down', 1, 3)).toBe(2)
    expect(targetOf('up', 0, 3)).toBeUndefined()
    expect(targetOf('down', 2, 3)).toBeUndefined()
  })
})

describe('keyDirection', () => {
  it('reads Alt and Shift with an arrow, and nothing else', () => {
    expect(keyDirection(key('ArrowUp', { altKey: true, shiftKey: true }))).toBe('up')
    expect(keyDirection(key('ArrowDown', { altKey: true, shiftKey: true }))).toBe('down')
    expect(keyDirection(key('ArrowUp'))).toBeUndefined()
    expect(keyDirection(key('ArrowUp', { altKey: true }))).toBeUndefined()
    expect(keyDirection(key('ArrowUp', { altKey: true, shiftKey: true, ctrlKey: true }))).toBeUndefined()
    expect(keyDirection(key('a', { altKey: true }))).toBeUndefined()
  })
})

describe('reorderKey', () => {
  function pressed(name: string, held: Partial<KeyboardEvent> = {}) {
    const event = {
      ...key(name, { altKey: true, shiftKey: true }),
      defaultPrevented: false,
      ...held,
      preventDefault() {
        this.defaultPrevented = true
      },
    }

    return event
  }

  it('stops the key at either end of the list, where the item cannot move', () => {
    const first = pressed('ArrowUp')
    const last = pressed('ArrowDown')

    expect(reorderKey(first, 0, 3)).toEqual({ direction: 'up', to: undefined })
    expect(first.defaultPrevented).toBe(true)
    expect(reorderKey(last, 2, 3)).toEqual({ direction: 'down', to: undefined })
    expect(last.defaultPrevented).toBe(true)
  })

  it('leaves the key to a textarea, where it selects a paragraph on macOS', () => {
    const inText = pressed('ArrowUp', { target: { tagName: 'TEXTAREA' } as unknown as EventTarget })

    expect(reorderKey(inText, 1, 3)).toBeUndefined()
    expect(inText.defaultPrevented).toBe(false)
  })

  it('moves the item otherwise, and leaves other keys and taken ones alone', () => {
    const middle = pressed('ArrowUp')
    const plain = pressed('a')
    const taken = pressed('ArrowUp', { defaultPrevented: true })

    expect(reorderKey(middle, 1, 3)).toEqual({ direction: 'up', to: 0 })
    expect(middle.defaultPrevented).toBe(true)
    expect(reorderKey(plain, 1, 3)).toBeUndefined()
    expect(plain.defaultPrevented).toBe(false)
    expect(reorderKey(taken, 1, 3)).toBeUndefined()
  })
})

describe('unfoldAround', () => {
  // A field under nested folded items: each body is hidden until its fold button is clicked, the inner one nearest.
  function nested(stuck = false) {
    const clicked: string[] = []
    const bodies = ['outer', 'inner'].map((name) => {
      const body = { hidden: true, closest: () => ({ querySelector: () => ({ click: () => {
        clicked.push(name)

        if (!stuck)
          body.hidden = false
      } }) }) }

      return body
    })
    const field = { closest: () => [...bodies].reverse().find(body => body.hidden) ?? null } as unknown as Element

    return { field, clicked }
  }

  it('unfolds each folded item the field sits in, the nearest first', () => {
    const { field, clicked } = nested()

    unfoldAround(field)

    expect(clicked).toEqual(['inner', 'outer'])
  })

  it('stops at a body that stays folded', () => {
    const { field, clicked } = nested(true)

    unfoldAround(field)

    expect(clicked).toEqual(['inner'])
  })

  it('leaves a field in no folded item alone', () => {
    const field = { closest: () => null } as unknown as Element

    expect(() => unfoldAround(field)).not.toThrow()
  })
})
