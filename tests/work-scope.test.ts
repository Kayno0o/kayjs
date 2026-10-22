import type { Action } from '../src/runtime'
import process from 'node:process'
import { describe, expect, it, setSystemTime } from 'bun:test'
import { newServerIslands, withServerIslands } from '../src/runtime/html'
import { solveWork } from '../src/runtime/work'
import { memoryRates } from '../src/server/protection'
import { STAMP_HOLE } from '../src/server/stamp'
import { signWork, workRefusal } from '../src/server/work'
import { freshFieldWork, verifyWork, workChallenge } from '../src/server/work-scope'
import { testSite } from '../src/test'

// Held in a variable so tsc leaves the .kay import to Bun.
const SCOPED_PAGE = './fixtures/navigation/src/routes/scoped.kay'

describe('workChallenge', () => {
  const SCOPED = /data-kay-work="([^"]+)"/

  it('gives a form field a challenge the action checks itself, solved once by kay/test as the browser does', async () => {
    const site = await testSite({ root: 'tests/fixtures/navigation', security: false })
    const { contact } = await import(SCOPED_PAGE) as { contact: Action<{ message: string, proof?: string }, number> }
    const page = await site.visit('/scoped')
    const challenge = SCOPED.exec(page.html)![1]!

    expect((await site.submit(contact, { message: 'hello' }, { from: page })).html).toContain('<p class="sent">Sent 5</p>')
    // Without JavaScript the field posts empty; a solution goes through once.
    expect((await site.submit(contact, { message: 'hello', proof: '' }, { from: page })).html).toContain('<p class="error">missing</p>')
    expect((await site.submit(contact, { message: 'hello', proof: solveWork(challenge)! }, { from: page })).html).toContain('<p class="error">wrong</p>')
  })

  it('refuses as expired a challenge of another scope, an action\'s, an easier one, one past its maxAge or signed before the key changed', async () => {
    const solved = solveWork(workChallenge('contact', { difficulty: 50, maxAge: '1m' }))!

    expect(await verifyWork(solved, 'newsletter')).toBe('expired')
    expect(await verifyWork(solveWork(signWork('contact', 50, 60_000)), 'contact')).toBe('expired')
    expect(await workRefusal('contact', solved, memoryRates())).toBe('expired')
    expect(await verifyWork(solved, 'contact', { difficulty: 51 })).toBe('expired')
    expect(await verifyWork(`${solved.slice(0, solved.lastIndexOf('.'))}.x`, 'contact')).toBe('wrong')
    expect(await verifyWork(undefined, 'contact')).toBe('missing')

    setSystemTime(Date.now() + 61_000)

    try {
      expect(await verifyWork(solved, 'contact')).toBe('expired')
    }
    finally {
      setSystemTime()
    }

    // In a process of its own, as the key it switches to would outlive the test.
    const restart = Bun.spawn([process.execPath, '-e', `import { solveWork } from ${JSON.stringify(`${import.meta.dir}/../src/runtime/work.ts`)}
import { useStampSecret } from ${JSON.stringify(`${import.meta.dir}/../src/server/stamp.ts`)}
import { verifyWork, workChallenge } from ${JSON.stringify(`${import.meta.dir}/../src/server/work-scope.ts`)}
const before = solveWork(workChallenge('contact', { difficulty: 50 }))
useStampSecret('a session secret of at least thirty-two characters', 'session')
console.log(JSON.stringify([await verifyWork(before, 'contact'), await verifyWork(solveWork(workChallenge('contact', { difficulty: 50 })), 'contact', { difficulty: 50 }) ?? null]))`], { stdout: 'pipe' })

    expect(JSON.parse(await new Response(restart.stdout).text())).toEqual(['expired', null])
  })

  it('leaves a prerendered page a mark the server fills in with a fresh challenge per visit', async () => {
    const mark = withServerIslands(newServerIslands(true), () => workChallenge('contact', { difficulty: 50, maxAge: '1m' }))
    const holes = [...`<input type="hidden" name="proof" data-kay-work="${mark}">`.matchAll(STAMP_HOLE)]

    expect(holes).toHaveLength(1)

    const fresh = () => SCOPED.exec(freshFieldWork(holes[0]![3]!))![1]!
    const first = fresh()

    expect(first).not.toBe(fresh())
    expect(Number.parseInt(first.slice(0, first.indexOf('.')), 36) - Date.now()).toBeLessThanOrEqual(60_000)
    expect(await verifyWork(solveWork(first), 'contact', { difficulty: 50 })).toBeUndefined()
  })

  it('refuses a difficulty it cannot use', () => {
    expect(() => workChallenge('contact', { difficulty: 0 })).toThrow('difficulty is 0')
    expect(() => workChallenge('contact', { difficulty: 1.5 })).toThrow('whole number')
  })
})
