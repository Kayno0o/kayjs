import { expect, mock, test } from 'bun:test'

const content = await import('../src/kay/content')

void mock.module('../src/kay/content', () => ({ ...content, collections: async () => {
  throw new Error('the database is down')
} }))

const { cms } = await import('../src/extension')
const { workingTree } = await import('../src/files')

test('a check that cannot read the collections is a warning, as at boot, not an error', async () => {
  const found = await cms({ files: workingTree(), guard: () => undefined }).check!()

  expect(found).toHaveLength(1)
  expect(found[0]?.severity).toBeUndefined()
  expect(found[0]?.message).toContain('could not be checked')
  expect(found[0]?.message).toContain('the database is down')
})
