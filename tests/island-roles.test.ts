import { describe, expect, it } from 'bun:test'
import { compare, formatComparison, rolesOf } from '../scripts/island-roles'

const document = (islands: { file: string, why?: string, promoted?: boolean }[], routes: { route: string, islands: string[] }[] = []) => ({ built: { sizes: { islands }, routes } })

describe('the island roles diff against main', () => {
  it('reads each file role and cause, and the files of each route, from a build document', () => {
    const roles = rolesOf(document([{ file: 'a.kay', why: '`onClick`, line 2', promoted: false }, { file: 'b.kay', why: 'a function', promoted: true }], [{ route: '/', islands: ['b.kay', 'a.kay'] }]))

    expect(roles).toEqual({ files: { 'a.kay': { promoted: false, why: '`onClick`, line 2' }, 'b.kay': { promoted: true, why: 'a function' } }, routes: { '/': ['a.kay', 'b.kay'] } })
    expect(rolesOf({})).toEqual({ files: {}, routes: {} })
  })

  it('passes a component that is an island on both sides, or that main had promoted, and prints a changed cause', () => {
    const main = { app: rolesOf(document([{ file: 'a.kay', why: 'x', promoted: false }, { file: 'b.kay', why: 'y', promoted: true }])) }
    const branch = { app: rolesOf(document([{ file: 'a.kay', why: 'z', promoted: false }, { file: 'b.kay', why: 'y', promoted: false }])) }
    const result = compare(main, branch)

    expect(result.violations).toEqual([])
    expect(result.changes.map(change => [change.file, change.before, change.after])).toEqual([['a.kay', 'island', 'island'], ['b.kay', 'promoted', 'island']])
    expect(formatComparison(result)).toContain('app: a.kay: island -> island, z (was x)')
  })

  it('fails a component that was static on main and is an island now, by its file role and by a route that loads it', () => {
    const main = { app: rolesOf(document([], [{ route: '/', islands: [] }])) }
    const branch = { app: rolesOf(document([{ file: 'c.kay', why: '`ref`, line 1', promoted: false }], [{ route: '/', islands: ['c.kay'] }])) }
    const result = compare(main, branch)

    expect(result.violations.map(change => change.file)).toEqual(['c.kay'])
    expect(formatComparison(result)).toContain('FAIL     app: c.kay: none -> island, `ref`, line 1')
  })

  it('does not fail a component that became promoted, or an island that went static, and says so when nothing changed', () => {
    const main = { app: rolesOf(document([{ file: 'a.kay', why: 'x', promoted: false }])) }
    const promoted = compare({ app: rolesOf(document([])) }, { app: rolesOf(document([{ file: 'p.kay', why: 'f', promoted: true }])) })

    expect(promoted.violations).toEqual([])
    expect(promoted.changes.map(change => change.after)).toEqual(['promoted'])
    expect(compare(main, { app: rolesOf(document([])) }).violations).toEqual([])
    expect(formatComparison(compare(main, main))).toBe('no role changed')
  })

  it('reports a target that failed to build on either side as an error rather than a pass', () => {
    const roles = rolesOf(document([]))
    const result = compare({ a: { error: 'boom' }, b: roles }, { a: roles, b: { error: 'bang' }, c: roles })

    expect(result.errors).toHaveLength(3)
    expect(result.errors[0]).toContain('the build on main failed: boom')
    expect(result.errors[1]).toContain('the build on this branch failed: bang')
    expect(result.errors[2]).toContain('main did not build it')
  })
})
