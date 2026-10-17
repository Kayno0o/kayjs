import { expect, test } from 'bun:test'
import { missingKindLines, missingKinds } from '../src/kinds'

const custom = (kind: string) => ({ 'type': 'string', 'x-kay': { kind } })
const posts = { name: 'posts', schema: { type: 'object', properties: { color: custom('color'), tags: { type: 'array', items: custom('mood') }, theme: { type: 'object', properties: { accent: custom('color') } }, cover: { 'type': 'string', 'x-kay': { kind: 'image' } } } } }
const pages = { name: 'pages', schema: { type: 'object', properties: { color: custom('color') } } }

test('lists the custom kinds with no component, in lists and groups too, each with the collections naming it', () => {
  expect([...missingKinds([posts, pages], new Set(['mood']))]).toEqual([['color', ['posts', 'pages']]])
  expect([...missingKinds([posts], new Set(['color', 'mood']))]).toEqual([])
})

test('reads the components off the project\'s src/cms/fields folder', () => {
  // The fixture app has a color component and none for mood.
  const root = `${import.meta.dir}/fixture`
  const lines = missingKindLines(root, [{ name: 'products', schema: { type: 'object', properties: { color: custom('color'), mood: custom('mood') } } }])

  expect(lines).toEqual(['no editor for the mood kind that products uses: add src/cms/fields/mood.kay, until then it is edited as JSON'])
})

test('reports nothing for a root without src, as an executable has', () => {
  expect(missingKindLines(`${import.meta.dir}/fixture/src/cms`, [posts])).toEqual([])
})
