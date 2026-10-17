import { describe, expect, it } from 'bun:test'
import { keyDirection, reordered, targetOf } from '../src/editor/reorder'

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
  it('reads Alt with an arrow, and nothing else', () => {
    expect(keyDirection(key('ArrowUp', { altKey: true }))).toBe('up')
    expect(keyDirection(key('ArrowDown', { altKey: true }))).toBe('down')
    expect(keyDirection(key('ArrowUp'))).toBeUndefined()
    expect(keyDirection(key('ArrowUp', { altKey: true, shiftKey: true }))).toBeUndefined()
    expect(keyDirection(key('a', { altKey: true }))).toBeUndefined()
  })
})
