import type { QueuedJob } from '../src/runtime/queue-jobs'
import type { JobStore } from '../src/server'
import type { TestSite } from '../src/test'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { chromium } from 'playwright-core'
import { jobs, JOBS_LIVE_ID } from '../src/runtime/queue-jobs'
import { memoryJobs, pgJobs, queue, sqliteJobs } from '../src/server'
import { jobsEntry, RECHECK_MS } from '../src/server/queue-live'
import { browserPath, testSite } from '../src/test'
import { gates, scans } from './fixtures/live-jobs/src/jobs'
import { cleanUpAfterFile, freshPg, kinds, pgIt, replicas, sqlitePath } from './job-stores'
import { Feed, JSON_POST, pagesOf, proofsOf } from './live-helpers'

cleanUpAfterFile()

// The failed runs and the cases that log on purpose.
const errors = spyOn(console, 'error').mockImplementation(() => undefined)

const ROOT = 'tests/fixtures/live-jobs'
// Long enough for a process following a queue to read it again a few times.
const HEARD_MS = RECHECK_MS * 4

let queues = 0

async function until(done: () => boolean, within = HEARD_MS): Promise<void> {
  for (let waited = 0; !done(); waited += 10) {
    if (waited > within)
      throw new Error('the list never came')

    await Bun.sleep(10)
  }
}

// Follows a queue's list as a connection does, for as long as the test holds it.
function follow(name: string): { list: () => QueuedJob[], [Symbol.dispose]: () => void } {
  const entry = jobsEntry(name)!
  const stop = entry.watch(() => undefined)

  return { list: entry.value, [Symbol.dispose]: stop }
}

const shown = (list: QueuedJob[]) => list.map(job => [(job.payload as { n: number } | undefined)?.n, job.status])

// A store of the app's own, lacking the optional methods named.
function without(store: JobStore, ...methods: ('live' | 'jobs')[]): JobStore {
  const copy = { ...store }

  for (const method of methods)
    delete copy[method]

  return copy
}

async function gateCount(held: PromiseWithResolvers<void>[], count: number): Promise<void> {
  await until(() => held.length >= count)
}

describe.each(kinds)('a queue with live, $name', ({ open }) => {
  it('shows its waiting and running jobs, as live gives their payloads, as they are added, taken, done and failed', async () => {
    const store = await open()
    const held: PromiseWithResolvers<void>[] = []
    const name = `live-${++queues}`
    const listed = queue<{ n: number, secret: string }>(name, async ({ n }) => {
      const gate = Promise.withResolvers<void>()

      held.push(gate)
      await gate.promise

      if (n === 2)
        throw new Error('boom')
    }, { store, live: ({ n }) => ({ n }), attempts: 1 })

    using following = follow(name)

    await listed.enqueue({ n: 1, secret: 's' }, { key: 'one' })
    await listed.enqueue({ n: 2, secret: 's' }, { delay: '1ms' })
    await until(() => following.list().length === 2)
    expect(following.list()[0]).toMatchObject({ key: 'one', status: 'waiting', attempts: 0, payload: { n: 1 } })
    expect(JSON.stringify(following.list())).not.toContain('secret')

    await Bun.sleep(5)

    const draining = listed.drain()

    await gateCount(held, 1)
    await until(() => shown(following.list()).join() === [[1, 'running'], [2, 'waiting']].join())
    held[0]!.resolve()
    await gateCount(held, 2)
    await until(() => shown(following.list()).join() === [[2, 'running']].join())
    held[1]!.resolve()
    await draining
    await until(() => following.list().length === 0)
  })

  it('reads the list again at the next render once a change was made with no tab following', async () => {
    const store = await open()
    const name = `live-${++queues}`
    const listed = queue<{ n: number }>(name, () => undefined, { store, live: true })

    await until(() => Array.isArray(jobs(name)))
    await listed.enqueue({ n: 3 })
    await until(() => shown(jobs(name)).join() === [[3, 'waiting']].join())
    await listed.drain()
    await until(() => jobs(name).length === 0)
  })
})

describe('a queue with live across processes', () => {
  it('hears the jobs another process adds and takes in a shared SQLite file while a tab follows it', async () => {
    const path = await sqlitePath()
    const name = `live-${++queues}`

    queue<{ n: number }>(name, () => undefined, { store: sqliteJobs(path), live: true })

    const other = sqliteJobs(path)

    using following = follow(name)

    await other.add({ id: 'elsewhere', queue: name, payload: '[{"n":1},4]', attempts: 0, runAt: Date.now() })
    await until(() => shown(following.list()).join() === [[4, 'waiting']].join())
    await other.claim(name, Date.now(), Date.now() + 60_000)
    await until(() => shown(following.list()).join() === [[4, 'running']].join())
    await other.complete('elsewhere')
    await until(() => following.list().length === 0)
  })

  pgIt('hears the jobs a replica adds and takes in Postgres while a tab follows it', async () => {
    await freshPg()

    const [own, replica] = replicas(2)
    const name = `live-${++queues}`

    queue<{ n: number }>(name, () => undefined, { store: pgJobs(own!), live: true })

    const other = pgJobs(replica!)

    using following = follow(name)

    await other.add({ id: 'elsewhere', queue: name, payload: '[{"n":1},5]', attempts: 0, runAt: Date.now() })
    await until(() => shown(following.list()).join() === [[5, 'waiting']].join())
    await other.claim(name, Date.now(), Date.now() + 60_000)
    await until(() => shown(following.list()).join() === [[5, 'running']].join())
  })
})

describe('a queue with live on a store of its own', () => {
  it('lists with jobs() and state() when the store has no live()', async () => {
    const name = `live-${++queues}`
    const listed = queue<{ n: number }>(name, () => undefined, { store: without(memoryJobs(), 'live'), live: true })

    using following = follow(name)

    await listed.enqueue({ n: 6 })
    await until(() => shown(following.list()).join() === [[6, 'waiting']].join())
  })

  it('logs a store that lists no jobs, and a live that throws or gives what a browser cannot be sent, once each', async () => {
    errors.mockClear()

    const blind = `live-${++queues}`

    queue<{ n: number }>(blind, () => undefined, { store: without(memoryJobs(), 'live', 'jobs'), live: true })
    expect(jobs(blind)).toEqual([])
    expect(jobs(blind)).toEqual([])

    const throwing = `live-${++queues}`
    const thrown = queue<{ n: number }>(throwing, () => undefined, { store: memoryJobs(), live: () => {
      throw new Error('nope')
    } })

    await thrown.enqueue({ n: 1 })
    expect(jobs(throwing)).toMatchObject([{ status: 'waiting' }])
    expect(jobs(throwing)[0]!.payload).toBeUndefined()

    const unsendable = `live-${++queues}`
    const classy = queue<{ n: number }>(unsendable, () => undefined, { store: memoryJobs(), live: () => ({ run: () => 1 }) })

    await classy.enqueue({ n: 1 })
    expect(jobs(unsendable)).toEqual([])

    const logged = errors.mock.calls.map(call => String(call[0]))

    expect(logged.filter(line => line.includes(`queue('${blind}')`))).toHaveLength(1)
    expect(logged.filter(line => line.includes(`queue('${throwing}')'s live threw`))).toHaveLength(1)
    expect(logged.filter(line => line.includes(`queue('${unsendable}')'s live gives what a browser cannot be sent`))).toHaveLength(1)
  })

  it('refuses a read of a queue declared without live', () => {
    queue('not-live', () => undefined, { store: memoryJobs() })
    expect(() => jobs('not-live')).toThrow('names no queue declared with `live`')
    expect(jobsEntry('not-live')).toBeUndefined()
  })
})

describe('a page reading a queue\'s jobs', () => {
  let site: TestSite

  beforeAll(async () => {
    site = await testSite({ root: ROOT })
  }, 120_000)

  afterAll(async () => {
    await site?.close()
  })

  async function connect(path: string, watch: [string, string][]): Promise<Response> {
    const { html } = await site.visit(path)

    return site.fetch('/_kay/live', { ...JSON_POST, body: JSON.stringify({ proofs: proofsOf(pagesOf(html)), watch }) })
  }

  it('writes the list into the page as live gives it, and follows it from the connection the page proves', async () => {
    await scans.enqueue({ target: 'alpha.example', token: 'hidden' })

    const { html } = await site.visit('/')

    expect(html).toContain('alpha.example')
    expect(html).not.toContain('hidden')
    expect(pagesOf(html).flatMap(page => page.values).filter(([id]) => id === JOBS_LIVE_ID).map(([, key]) => key)).toEqual(['scans'])

    const feed = new Feed(await connect('/', [[JOBS_LIVE_ID, 'scans']]))
    const [[, , first]] = await feed.next() as [[string, string, QueuedJob[]]]

    expect(first.map(job => job.payload)).toEqual([{ target: 'alpha.example' }])
    await scans.enqueue({ target: 'beta.example', token: 'hidden' })

    const [[, , second]] = await feed.next() as [[string, string, QueuedJob[]]]

    expect(second.map(job => job.payload)).toEqual([{ target: 'alpha.example' }, { target: 'beta.example' }])
    await feed.close()
    await scans.remove(() => true)
  })

  it('refuses a connection to a queue its page did not read, or one with no live', async () => {
    expect((await connect('/', [[JOBS_LIVE_ID, 'quiet']])).status).toBe(403)
    expect((await connect('/plain', [[JOBS_LIVE_ID, 'scans']])).status).toBe(403)
  })

  it('fails the render of a page reading a queue with no live', async () => {
    expect((await site.visit('/quiet')).status).toBe(500)
  })

  it('keeps a page reading no queue free of the list', async () => {
    expect((await site.visit('/plain')).html).not.toContain(JOBS_LIVE_ID)
  })
})

const chrome = browserPath() ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined)

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(chrome === undefined && (process.env.CI ?? '') === '')('an island reading a queue\'s jobs, in a browser', () => {
  let site: TestSite

  beforeAll(async () => {
    site = await testSite({ root: ROOT, browser: { path: chrome } })
  }, 120_000)

  afterAll(async () => {
    await site?.close()
    gates.splice(0)
  })

  it('shows the jobs as they wait, run, finish and fail, with no code of the app', async () => {
    await scans.remove(() => true)
    await scans.enqueue({ target: 'one.example', token: 't' })
    await using page = await site.open('/')

    await page.waitUntil(() => document.querySelector('p.count')?.textContent === '1')
    await scans.enqueue({ target: 'two.example', token: 't' })
    await page.waitUntil(() => document.querySelectorAll('ul.scans li[data-status="waiting"]').length === 2)

    const draining = scans.drain()

    await until(() => gates.length === 1)
    await page.waitUntil(() => document.querySelector('ul.scans li[data-status="running"]')?.textContent === 'one.example')
    gates[0]!.resolve()
    await until(() => gates.length === 2)
    await page.waitUntil(() => document.querySelector('p.count')?.textContent === '1' && document.querySelector('ul.scans li[data-status="running"]')?.textContent === 'two.example')
    gates[1]!.resolve()
    await draining
    await page.waitUntil(() => document.querySelector('p.count')?.textContent === '0')
    expect(page.errors).toEqual([])
  }, 60_000)
})
