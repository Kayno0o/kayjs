import { expect, test } from 'bun:test'
import { plainText, sourceOffset } from '../src/editor/caret'

// The source offset of the caret after `rendered.slice(0, caret)` has been read.
const at = (source: string, rendered: string, before: string, markdown = true) => sourceOffset(source, rendered, rendered.indexOf(before) + before.length, markdown)

test('plain text keeps the characters of a source and drops its markup', () => {
  expect(plainText('Some **bold** and [a link](https://x.test/a) and `code`', true).text).toBe('Someboldandalinkandcode')
  expect(plainText('![alt text](a.png) after', true).text).toBe('after')
  expect(plainText('# Title\n\n- one\n- two\n\n1. first\n\n> quoted', true).text).toBe('Titleonetwofirstquoted')
  expect(plainText('---\n\n```ts\nconst a = 1\n```\n\ntext', true).text).toBe('consta=1text')
  expect(plainText('Escaped \\*star\\* and snake_case and <b>tag</b>', true).text).toBe('Escaped*star*andsnake_caseandtag')
  expect(plainText('a *b*', false).text).toBe('a*b*')
})

test('a caret in a paragraph lands at the same place in the source', () => {
  const source = 'First paragraph.\n\nSecond paragraph here.'

  expect(at(source, 'First paragraph.Second paragraph here.', 'Second par')).toBe(source.indexOf('agraph here'))
})

test('markup around the caret does not move it into the markup', () => {
  const source = 'Say **hello** to [the world](https://x.test) now'
  const rendered = 'Say hello to the world now'

  expect(at(source, rendered, 'Say hel')).toBe(source.indexOf('lo**'))
  expect(at(source, rendered, 'to the wo')).toBe(source.indexOf('rld]'))
  expect(at(source, rendered, 'to the world no')).toBe(source.indexOf('w', source.indexOf(') now')))
})

test('a caret in a repeated sentence goes to the occurrence it was in', () => {
  const source = 'Same words.\n\nSame words.\n\nSame words.'
  const rendered = 'Same words.Same words.Same words.'
  const second = rendered.indexOf('Same words.', 1) + 4

  expect(sourceOffset(source, rendered, second, true)).toBe(source.indexOf('Same words.', 1) + 4)
  expect(sourceOffset(source, rendered, rendered.length - 3, true)).toBe(source.length - 3)
})

test('a caret at the very start and the very end', () => {
  expect(sourceOffset('**Hi** there', 'Hi there', 0, true)).toBe(2)
  expect(sourceOffset('Hi there', 'Hi there', 8, true)).toBe(8)
})

test('a plain text is aligned without reading its stars as markup', () => {
  expect(at('2 * 3 = 6', '2 * 3 = 6', '2 * 3', false)).toBe(5)
})

test('a text the source does not hold, as a value the page transforms, gives no place', () => {
  expect(sourceOffset('Hello world', 'HELLO WORLD', 3, true)).toBeUndefined()
  expect(sourceOffset('Hello', '', 0, true)).toBeUndefined()
})

test('a line break in a textarea\'s value is whitespace the page collapses', () => {
  const source = 'Line one\nline two'

  expect(at(source, 'Line one line two', 'Line one line t', false)).toBe(source.indexOf('wo'))
})

test('a long line of dashes with a stray end is read in linear time', () => {
  const started = performance.now()

  expect(plainText(`${'-'.repeat(50_000)}x`, true).text.endsWith('x')).toBe(true)
  expect(performance.now() - started).toBeLessThan(1000)
})

test('a table\'s separator row is markup', () => {
  expect(plainText('| a | b |\n| --- | :-: |\n| c | d |', true).text).toBe('abcd')
})
