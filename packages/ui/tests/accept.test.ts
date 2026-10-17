import { expect, test } from 'bun:test'
import { acceptsFile } from '../src/accept'

test('matches a type, a family or an extension, and takes anything without an accept', () => {
  expect(acceptsFile(undefined, { name: 'a.bin', type: 'application/x-foo' })).toBe(true)
  expect(acceptsFile('image/*', { name: 'a.png', type: 'image/png' })).toBe(true)
  expect(acceptsFile('image/png', { name: 'a.svg', type: 'image/svg+xml' })).toBe(false)
  expect(acceptsFile('.svg', { name: 'logo.SVG', type: 'image/svg+xml' })).toBe(true)
  expect(acceptsFile('.svg', { name: 'logo.png', type: '' })).toBe(false)
})

test('takes a file with no type against a type token, leaving the receiver to read its extension', () => {
  expect(acceptsFile('text/csv,application/pdf', { name: 'table.csv', type: '' })).toBe(true)
  expect(acceptsFile('image/*', { name: 'noextension', type: '' })).toBe(true)
})
