import { expect, test } from 'bun:test'
import { collectionInfo } from 'kay/content'
import { registerCollections } from '../../../src/content/edit'
import { fieldsOf } from '../src/fields'

test('how a schema says a field is entered reaches the form through collectionInfo', async () => {
  const config = await import('./fixture/src/content.config') as Record<string, unknown>
  const before = registerCollections(Object.entries(config) as Parameters<typeof registerCollections>[0])

  try {
    const info = await collectionInfo('profiles', { counts: false })

    expect(info?.description).toBe('Who edits the site')
    expect(fieldsOf(info!.schema)[1]).toMatchObject({ key: 'nickname', kind: 'text', placeholder: 'Jo', when: 'name' })
  }
  finally {
    registerCollections(before)
  }
})
