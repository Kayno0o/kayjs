import { describe, expect, it } from 'bun:test'
import { memoryAuth } from '../src/memoryStore'
import { storeProblems } from '../src/own'
import { auth } from '../src/pages'

const MISSING = (): boolean => false

describe('auth() whose store needs @kaynooo/pg-orm', () => {
  it('reports the package to add when a SQLite or Postgres store is built and it is not installed', () => {
    const [problem, ...rest] = storeProblems({}, MISSING)

    expect(rest).toEqual([])
    expect(problem?.severity).toBe('error')
    expect(problem?.message).toContain('@kaynooo/pg-orm is not installed')
    expect(problem?.help).toBe('bun add @kaynooo/pg-orm')
    expect(storeProblems({ store: { url: 'sqlite://data/users.sqlite' } }, MISSING)).toHaveLength(1)
  })

  it('reports nothing when it is installed, or when the app gives the store itself', () => {
    expect(storeProblems({}, () => true)).toEqual([])
    expect(storeProblems({ store: () => memoryAuth() }, MISSING)).toEqual([])
    expect(storeProblems({ store: memoryAuth() }, MISSING)).toEqual([])
  })

  it('is the check of the extension auth() builds with no module, and of no other', async () => {
    expect(await auth().check?.()).toEqual([])
    expect(auth({ module: './src/auth' }).check).toBeUndefined()
  })
})
