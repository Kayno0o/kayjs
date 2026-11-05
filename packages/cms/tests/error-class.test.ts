import { describe, expect, it } from 'bun:test'
import { KayError } from 'kay/library'
import { ForgeError, SaveConflictError } from '../src/files'
import { UnreadReferrersError } from '../src/references'
import { UnknownCollectionError } from '../src/store'

describe('the cms errors', () => {
  it('tell a conflict from an existing entry by kind, both answering 409', () => {
    const conflict = new SaveConflictError('abc')
    const exists = new SaveConflictError(undefined, true)

    expect(conflict).toBeInstanceOf(KayError)
    expect([conflict.code, conflict.kind, conflict.name, conflict.status, conflict.current]).toEqual(['save-conflict', 'conflict', 'SaveConflictError', 409, 'abc'])
    expect([exists.kind, exists.status]).toEqual(['exists', 409])
  })

  it('carry the forge\'s status and cause, and 404 for an unknown collection', () => {
    const cause = new Error('boom')
    const forge = new ForgeError(422, 'refused', { cause })
    const unknown = new UnknownCollectionError('No collection x')

    expect(forge).toBeInstanceOf(KayError)
    expect([forge.code, forge.kind, forge.name, forge.status]).toEqual(['forge-refused', 'forge-refused', 'ForgeError', 422])
    expect(forge.cause).toBe(cause)
    expect([unknown.code, unknown.name, unknown.status, unknown.message]).toEqual(['unknown-collection', 'UnknownCollectionError', 404, 'No collection x'])
    expect(new UnreadReferrersError(['a', 'b']).names).toEqual(['a', 'b'])
  })
})
