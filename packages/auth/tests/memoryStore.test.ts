import { expect, test } from 'bun:test'
import { memoryStore } from '../src/memoryStore'
import { storeContract } from './helpers/storeContract'

storeContract('memoryStore', async () => memoryStore())

test('memoryStore lists audit entries of one millisecond newest added first', async () => {
  const store = memoryStore()
  const at = new Date('2026-01-01T00:00:00Z')

  for (const id of ['a1', 'a2', 'a3'])
    await store.audit!.add({ id, userId: 'u1', event: 'signed-in', detail: 'password', ip: '10.0.0.1', userAgent: 'Firefox', actorId: null, at })

  expect((await store.audit!.list({ limit: 10 })).map(found => found.id)).toEqual(['a3', 'a2', 'a1'])
  // Twice, as listing must not reorder what the store holds.
  expect((await store.audit!.list({ limit: 10 })).map(found => found.id)).toEqual(['a3', 'a2', 'a1'])
})
