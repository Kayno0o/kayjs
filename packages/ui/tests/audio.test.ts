import { expect, test } from 'bun:test'
import { chapterAt, clock, cueAt, cuesByChapter, previousStart } from '../src/audio'

const chapters = [{ title: 'A', start: 0 }, { title: 'B', start: 30 }, { title: 'C', start: 90 }]
const cues = [{ start: 0, end: 10, text: 'one' }, { start: 10, end: 30, text: 'two' }, { start: 30, end: 60, text: 'three' }, { start: 95, end: 100, text: 'four' }]

test('the chapter playing is the last started, or none before the first', () => {
  expect([chapterAt(chapters, 0), chapterAt(chapters, 29.9), chapterAt(chapters, 30), chapterAt(chapters, 500)]).toEqual([0, 0, 1, 2])
  expect(chapterAt([{ title: 'A', start: 5 }], 1)).toBe(-1)
  expect(chapterAt([], 1)).toBe(-1)
})

test('a previous step restarts a chapter past its first seconds, goes to the one before within them, and stays on the first', () => {
  expect([previousStart(chapters, 50), previousStart(chapters, 31), previousStart(chapters, 34), previousStart(chapters, 2), previousStart(chapters, 0), previousStart([], 20)]).toEqual([30, 0, 30, 0, 0, 0])
})

test('the cue playing runs from its start up to its end, and none between two', () => {
  expect([cueAt(cues, 0), cueAt(cues, 10), cueAt(cues, 59), cueAt(cues, 70), cueAt(cues, 100)]).toEqual([0, 1, 2, -1, -1])
})

test('cues group under the chapter they start in, keeping each one its index, and empty chapters drop', () => {
  expect(cuesByChapter(chapters, cues).map(group => [group.chapter, group.first, group.cues.map(cue => cue.text)])).toEqual([[0, 0, ['one', 'two']], [1, 2, ['three']], [2, 3, ['four']]])
  expect(cuesByChapter([chapters[0]!, chapters[2]!], cues.slice(0, 3)).map(group => group.chapter)).toEqual([0])
  expect(cuesByChapter([], cues).map(group => [group.chapter, group.cues.length])).toEqual([[-1, 4]])
  expect(cuesByChapter(chapters, [])).toEqual([])
})

test('the clock reads minutes and seconds, and hours from the hour', () => {
  expect([clock(0), clock(59.9), clock(61), clock(3599), clock(3600), clock(3725), clock(Number.NaN), clock(Infinity), clock(-4)]).toEqual(['0:00', '0:59', '1:01', '59:59', '1:00:00', '1:02:05', '0:00', '0:00', '0:00'])
})
