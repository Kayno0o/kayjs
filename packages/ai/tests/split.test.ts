import { expect, it } from 'bun:test'
import { splitMarkdown } from '../src/split'

const paragraph = (name: string, size: number) => `${name} ${'x'.repeat(size)}\n\n`

it('keeps a text that fits whole', () => {
  expect(splitMarkdown('a\n\nb\n', 100)).toEqual(['a\n\nb\n'])
  expect(splitMarkdown('', 10)).toEqual([''])
})

it('cuts between blocks and every part joins back to the text', () => {
  const text = `${paragraph('one', 40) + paragraph('two', 40) + paragraph('three', 40)}end`
  const parts = splitMarkdown(text, 100)

  expect(parts.length).toBeGreaterThan(1)
  expect(parts.join('')).toBe(text)
  for (const part of parts)
    expect(part.length).toBeLessThanOrEqual(100)
  expect(parts.slice(0, -1).every(part => part.endsWith('\n\n'))).toBe(true)
})

it('never cuts a code fence, even past the limit, nor takes a shorter marker for its end', () => {
  const code = '```ts\nconst a = 1\n\n~~~\n\n````\nstill code\n\n```\n\n'
  const text = paragraph('before', 30) + code + paragraph('after', 30)
  const parts = splitMarkdown(text, 50)

  expect(parts.join('')).toBe(text)
  expect(parts.filter(part => part.includes('```ts'))).toHaveLength(1)
  expect(parts.find(part => part.includes('```ts'))).toContain('still code')
})

it('keeps a fence that is never closed to the end, in one part', () => {
  const text = `${paragraph('a', 60)}\`\`\`\ncode\n\nmore\n\nand more`
  const parts = splitMarkdown(text, 50)

  expect(parts.join('')).toBe(text)
  expect(parts.at(-1)!.startsWith('```')).toBe(true)
})

it('cuts a paragraph longer than the limit at its line breaks, keeping CRLF', () => {
  const text = Array.from({ length: 10 }, (_, index) => `line ${index} xxxxxxxx`).join('\r\n')
  const parts = splitMarkdown(text, 60)

  expect(parts.join('')).toBe(text)
  expect(parts.length).toBeGreaterThan(2)
  for (const part of parts)
    expect(part.length).toBeLessThanOrEqual(60)
})

it('leaves a single line longer than the limit whole', () => {
  const text = `${'y'.repeat(200)}\n\nnext`

  expect(splitMarkdown(text, 50).join('')).toBe(text)
  expect(splitMarkdown(text, 50)[0]).toBe(`${'y'.repeat(200)}\n\n`)
})
