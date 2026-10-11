import { describe, expect, test } from 'bun:test'
import { boardKeyTarget, edgeScroll, insertionBar, keyTarget, nearestBox, offsetOf, readingIndex, targetIndex } from '../src/dnd/geometry'

const ITEMS = [{ mid: 20 }, { mid: 60 }, { mid: 100 }, { mid: 140 }]

describe('targetIndex', () => {
  test('keeps the dragged item in place while the pointer stays between its neighbours', () => {
    expect(targetIndex(ITEMS, 1, 50)).toBe(1)
  })

  test('lands past every other item whose middle the pointer has crossed, in either direction', () => {
    expect(targetIndex(ITEMS, 0, 120)).toBe(2)
    expect(targetIndex(ITEMS, 3, 10)).toBe(0)
  })

  test('never counts the dragged item itself', () => {
    expect(targetIndex(ITEMS, 0, 30)).toBe(0)
  })
})

describe('offsetOf', () => {
  test('slides the items a downward drag passes up by the dragged item\'s height', () => {
    expect([0, 1, 2, 3].map(index => offsetOf(index, 0, 2, 40))).toEqual([0, -40, -40, 0])
  })

  test('slides the items an upward drag passes down', () => {
    expect([0, 1, 2, 3].map(index => offsetOf(index, 3, 1, 40))).toEqual([0, 40, 40, 0])
  })
})

describe('keyTarget', () => {
  test('moves a focused handle\'s item one place per arrow key', () => {
    expect(keyTarget('ArrowUp', 2, 4)).toBe(1)
    expect(keyTarget('ArrowDown', 2, 4)).toBe(3)
  })

  test('holds an item at either end of the list where it is', () => {
    expect(keyTarget('ArrowUp', 0, 4)).toBe(0)
    expect(keyTarget('ArrowDown', 3, 4)).toBe(3)
  })

  test('moves nothing on any other key', () => {
    expect(keyTarget('Enter', 1, 4)).toBeNull()
  })
})

describe('edgeScroll', () => {
  const bounds = { top: 0, bottom: 800 }

  test('stays still while the pointer is away from both edges', () => {
    expect(edgeScroll(400, bounds)).toBe(0)
  })

  test('scrolls down, faster the nearer the pointer gets to the bottom edge', () => {
    expect(edgeScroll(760, bounds)).toBeGreaterThan(0)
    expect(edgeScroll(799, bounds)).toBeGreaterThan(edgeScroll(760, bounds))
  })

  test('scrolls up near the top edge, at full speed once the pointer is past it', () => {
    expect(edgeScroll(10, bounds)).toBeLessThan(0)
    expect(edgeScroll(-20, bounds)).toBe(edgeScroll(0, bounds))
  })
})

const ROW = [
  { left: 0, top: 0, right: 40, bottom: 40 },
  { left: 50, top: 0, right: 90, bottom: 40 },
  { left: 0, top: 50, right: 40, bottom: 90 },
]

describe('readingIndex', () => {
  test('counts the boxes on the pointer\'s row whose middle it has passed', () => {
    expect(readingIndex(ROW, { x: 10, y: 20 })).toBe(0)
    expect(readingIndex(ROW, { x: 30, y: 20 })).toBe(1)
    expect(readingIndex(ROW, { x: 95, y: 20 })).toBe(2)
  })

  test('counts every box on a row above the pointer, however far right they sit', () => {
    expect(readingIndex(ROW, { x: 5, y: 70 })).toBe(2)
    expect(readingIndex(ROW, { x: 5, y: 120 })).toBe(3)
  })
})

describe('nearestBox', () => {
  const containers = [{ left: 0, top: 0, right: 200, bottom: 100 }, { left: 0, top: 110, right: 200, bottom: 210 }]

  test('picks the container the pointer is level with, and the nearest one in the gap between them', () => {
    expect(nearestBox({ x: 500, y: 150 }, containers)).toBe(1)
    expect(nearestBox({ x: 100, y: 104 }, containers)).toBe(0)
    expect(nearestBox({ x: 100, y: 0 }, [])).toBe(-1)
  })
})

describe('insertionBar', () => {
  const container = { left: 0, top: 0, right: 200, bottom: 100 }

  test('stands before the box taking the slot, after the last box, or at the start of an empty container', () => {
    expect(insertionBar(container, ROW, 1)).toEqual({ left: 47, top: 0, height: 40 })
    expect(insertionBar(container, ROW, 3)).toEqual({ left: 43, top: 50, height: 40 })
    expect(insertionBar(container, [], 0)).toEqual({ left: 3, top: 3, height: 94 })
  })
})

describe('boardKeyTarget', () => {
  const sizes = [3, 0, 2]

  test('moves within a container by one place, held inside it', () => {
    expect(boardKeyTarget('ArrowLeft', 0, 1, sizes)).toEqual({ container: 0, index: 0 })
    expect(boardKeyTarget('ArrowLeft', 0, 0, sizes)).toEqual({ container: 0, index: 0 })
    expect(boardKeyTarget('ArrowRight', 0, 2, sizes)).toEqual({ container: 0, index: 2 })
  })

  test('moves into the next or previous container at the same slot, or after its last item', () => {
    expect(boardKeyTarget('ArrowDown', 0, 2, sizes)).toEqual({ container: 1, index: 0 })
    expect(boardKeyTarget('ArrowUp', 2, 1, sizes)).toEqual({ container: 1, index: 0 })
    expect(boardKeyTarget('ArrowDown', 1, 0, [3, 1, 5])).toEqual({ container: 2, index: 0 })
    expect(boardKeyTarget('ArrowUp', 0, 1, sizes)).toEqual({ container: 0, index: 1 })
  })

  test('ignores any other key', () => {
    expect(boardKeyTarget('Enter', 0, 0, sizes)).toBe(null)
  })
})
