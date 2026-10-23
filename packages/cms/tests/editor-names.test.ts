import { expect, test } from 'bun:test'
import { viewMembers } from '../src/editor-names'

const ANN = JSON.stringify({ name: 'Ann', page: true })
const BOB = JSON.stringify({ name: 'Bob', page: true })

test('a list stripped of names keeps every member, so a client counting them counts right', () => {
  const seen = viewMembers(undefined, 'cms:posts:hello', [ANN, BOB, ANN], JSON.stringify({ name: '', page: true }))

  expect(seen).toHaveLength(3)
  expect(seen.join('')).not.toContain('Ann')
  expect(seen.join('')).not.toContain('Bob')
})

test('a room that names no editor is left whole', () => {
  expect(viewMembers(undefined, 'open:cms:posts:hello', [ANN], JSON.stringify({ name: '', page: true }))).toEqual([ANN])
})
