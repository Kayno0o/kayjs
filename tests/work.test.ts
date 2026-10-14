import type { Action } from '../src/runtime'
import type { ClientBuild } from '../src/server/client'
import process from 'node:process'
import { describe, expect, it, setSystemTime, spyOn } from 'bun:test'
import { stringify } from 'devalue'
import { clientDir } from '../src/build/assets'
import { resolveProject } from '../src/project'
import { action, actionStub } from '../src/runtime/action'
import { newServerIslands, withServerIslands } from '../src/runtime/html'
import { digest, sha256, solveWork } from '../src/runtime/work'
import { servePages } from '../src/server/app'
import { memoryRates } from '../src/server/protection'
import { STAMP_HOLE } from '../src/server/stamp'
import { freshWork, signWork, workRefusal, workScript } from '../src/server/work'
import { freshFieldWork, verifyWork, workChallenge } from '../src/server/work-scope'
import { testSite } from '../src/test'

const routes = 'tests/fixtures/production/src/routes'
const ROUTE = '/_kay/action/tests/fixtures/production/src/routes/work.kay'
// Held in a variable so tsc leaves the .kay import to Bun.
const PAGE = './fixtures/production/src/routes/work.kay'
const SCOPED_PAGE = './fixtures/navigation/src/routes/scoped.kay'
const WORK = /<script type="application\/json" data-kay-work>(.*?)<\/script>/
const client: ClientBuild = { entry: '/_kay/entry.js', entryImports: [], islands: {}, styles: new Map(), pages: new Map(), dir: clientDir(process.cwd()), navigation: true }
const app = await servePages(resolveProject(process.cwd(), { routes, security: false }), async () => client)

async function challenges(): Promise<Record<string, string>> {
  const html = await (await app.handle(new Request('http://localhost/work'))).text()

  return JSON.parse(WORK.exec(html)![1]!) as Record<string, string>
}

// A form post as the page swap sends it, or as the browser does with `navigate` false; the solution in the header kay's script puts it in.
async function post(name: string, work?: string, { navigate = true, fields = {} }: { navigate?: boolean, fields?: Record<string, string> } = {}): Promise<Response> {
  const headers: Record<string, string> = { origin: 'http://localhost', referer: 'http://localhost/work', ...(navigate && { 'x-kay-navigate': '1' }), ...(work !== undefined && { 'x-kay-work': work }) }

  return app.handle(new Request(`http://localhost${ROUTE}/${name}`, { method: 'POST', headers, body: new URLSearchParams({ message: 'hello', ...fields }) }))
}

async function errorOf(response: Response): Promise<string | undefined> {
  return (/<p class="error">(.*?)<\/p>/).exec(await response.text())?.[1]
}

describe('proof-of-work', () => {
  it('hashes as SHA-256 does, every length a challenge takes', () => {
    for (let length = 0; length < 56; length++) {
      const text = 'kay'.repeat(20).slice(0, length)

      expect(sha256(text)).toBe(new Bun.CryptoHasher('sha256').update(text).digest('hex'))
    }

    expect(() => digest('k'.repeat(56))).toThrow('under 56 characters')
    expect(() => digest('café')).toThrow('ASCII text only')
    expect(solveWork('1.sälz.00000000000000000000000000000000000000000000000000000000000000000.1.s')).toBeUndefined()
  })

  it('gives a page the challenges of the actions its forms post to, which the browser solves', async () => {
    const page = await challenges()

    expect(Object.keys(page).sort()).toEqual([`${ROUTE}/faked`, `${ROUTE}/gated`, `${ROUTE}/solve`])
    expect(solveWork(page[`${ROUTE}/solve`]!)).toStartWith(`${page[`${ROUTE}/solve`]}.`)
    expect(solveWork('not.a.challenge')).toBeUndefined()
  })

  it('lets a post with its solution through once, and refuses one without, with a fresh challenge to solve', async () => {
    const solution = solveWork((await challenges())[`${ROUTE}/solve`]!)!
    const passed = await post('solve', solution)

    expect(passed.status).toBe(303)

    const replayed = await post('solve', solution)

    expect(replayed.status).toBe(422)
    expect(await errorOf(replayed)).toBe('422 This form could not be checked; send it again')

    const missing = await post('solve')

    expect(await errorOf(missing)).toBe('422 Turn JavaScript on to send this form')
    expect((await post('solve', solveWork(missing.headers.get('x-kay-work')!))).status).toBe(303)
    expect(await errorOf(await post('solve', `${solution.slice(0, solution.lastIndexOf('.'))}.7`))).toBe('422 This form could not be checked; send it again')
  })

  it('refuses as expired a challenge past its maxAge, forged or another action\'s', async () => {
    const page = await challenges()
    const start = Date.now()

    try {
      setSystemTime(start + 86_400_000 + 1000)
      expect(await errorOf(await post('solve', solveWork(page[`${ROUTE}/solve`]!)))).toBe('422 This form has expired; send it again')
    }
    finally {
      setSystemTime()
    }

    const solution = solveWork(page[`${ROUTE}/gated`]!)!

    expect(await errorOf(await post('solve', solution))).toBe('422 This form has expired; send it again')
    expect(await errorOf(await post('solve', solution.replace(/\.[\w-]+\.(\d+)$/, '.forged.$1')))).toBe('422 This form has expired; send it again')
  })

  it('lets a form posted without JavaScript through on its stamp when the action has minTime too, and still checks a solution sent', async () => {
    const html = await (await app.handle(new Request('http://localhost/work'))).text()
    const stamp = (/name="kay_since" value="([^"]+)"/).exec(html)![1]!
    const start = Date.now()

    try {
      setSystemTime(start + 2000)
      expect((await post('gated', undefined, { navigate: false, fields: { kay_since: stamp } })).status).toBe(303)
      expect(await errorOf(await post('gated', 'forged', { navigate: false, fields: { kay_since: stamp } }))).toBe('422 This form has expired; send it again')
      // Checked by `minTime` alone, an empty header as no header.
      expect((await post('gated', '', { navigate: false, fields: { kay_since: stamp } })).status).toBe(303)
      expect(await errorOf(await post('solve', undefined, { navigate: false }))).toBe('422 Turn JavaScript on to send this form')
    }
    finally {
      setSystemTime()
    }
  })

  it('answers a wrong solution as if it went through when pretend says so, a missing one refused in the site\'s words', async () => {
    const solution = solveWork((await challenges())[`${ROUTE}/faked`]!)!
    const wrong = await post('faked', `${solution.slice(0, solution.lastIndexOf('.'))}.${Number(solution.slice(solution.lastIndexOf('.') + 1)) + 1}`)

    expect(wrong.status).toBe(303)
    expect(await errorOf(await post('faked'))).toBe('422 missing!')
  })

  it('solves the challenge a call is refused with, then sends it again', async () => {
    const solve = actionStub(`${ROUTE}/solve`) as (input: { message: string }) => Promise<number>
    const sent: (string | null)[] = []
    const fetched = spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init: RequestInit) => {
      const request = new Request(new URL(url, 'http://localhost'), { ...init, headers: { ...init.headers as Record<string, string>, origin: 'http://localhost' } })

      sent.push(request.headers.get('x-kay-work'))

      return app.handle(request)
    }) as unknown as typeof fetch)

    try {
      expect(await solve({ message: 'hello' })).toBe(5)
      expect(sent[0]).toBeNull()
      expect(sent[1]).toMatch(/\.\d+$/)

      const call = await app.handle(new Request(`http://localhost${ROUTE}/solve`, { method: 'POST', headers: { 'origin': 'http://localhost', 'content-type': 'application/json', 'x-kay-action': '1' }, body: stringify({ message: 'hi' }) }))

      expect(call.status).toBe(422)
      expect(call.headers.get('x-kay-work')).not.toBeNull()
    }
    finally {
      fetched.mockRestore()
    }
  })

  it('passes the challenge from kay/test\'s submit and call, unless the test sends its own header', async () => {
    const site = await testSite({ routes, security: false })
    const { solve } = await import(PAGE) as { solve: Action<{ message: string }, number> }

    expect((await site.submit(solve, { message: 'hello' }, { from: '/work' })).html).toContain('<p class="solved">Solved 5</p>')
    expect(await site.call(solve, { message: 'hello' })).toBe(5)
    expect((await site.submit(solve, { message: 'hello' }, { from: '/work', headers: { 'x-kay-work': '' } })).html).toContain('<p class="error">422 Turn JavaScript on to send this form</p>')
  })

  it('leaves a prerendered page a mark the server fills in with a fresh challenge per visit', async () => {
    const solve = action({} as never, () => 0, { proofOfWork: { difficulty: 50, maxAge: '1m' } })

    ;(solve as { url: string }).url = '/_kay/action/a'

    const script = workScript(new Set([solve as never]), true)
    const marks = [...script.matchAll(STAMP_HOLE)]

    expect(marks).toHaveLength(1)

    const fresh = () => (JSON.parse(WORK.exec(freshWork(marks[0]![2]!))![1]!) as Record<string, string>)['/_kay/action/a']!
    const first = fresh()

    expect(first).not.toBe(fresh())
    expect([...'<p>"kay-work:%"</p>'.matchAll(STAMP_HOLE)]).toEqual([])
    expect(solveWork(first)).toBeDefined()
    expect(Number.parseInt(first.slice(0, first.indexOf('.')), 36) - Date.now()).toBeLessThanOrEqual(60_000)
    expect(signWork('/_kay/action/a', 50, 1000).split('.')[3]).toBe((50).toString(36))
  })

  it('refuses a difficulty it cannot use as the action is declared', () => {
    expect(() => action({} as never, () => 0, { proofOfWork: 0 })).toThrow('proofOfWork\'s difficulty is 0')
    expect(() => action({} as never, () => 0, { proofOfWork: 1.5 })).toThrow('whole number')
  })
})

describe('workChallenge', () => {
  const SCOPED = /data-kay-work="([^"]+)"/

  it('gives a form field a challenge the action checks itself, solved once by kay/test as the browser does', async () => {
    const site = await testSite({ routes: 'tests/fixtures/navigation/src/routes', security: false })
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
