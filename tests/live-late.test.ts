import type { LiveRequest } from '../src/runtime/live-value'
import type { TestSite } from '../src/test'
import { resolve } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { liveId } from '../src/build/live-ids'
import { browserPath, testSite } from '../src/test'
import { Feed, JSON_POST, pagesOf, proofsOf } from './live-helpers'

const ROOT = 'tests/fixtures/live-late'
const idOf = (name: string) => liveId('/app/src/live.ts', '/app', name)
const VISITORS = idOf('visitors')
const SECRET = idOf('secret')
// A keyed value another fixture declares: the proof of a page here does not cover it.
const ROOM = idOf('room')
const chrome = browserPath()

type Values = typeof import('./fixtures/live-late/src/live')

async function values(): Promise<Values> {
  return import(resolve(ROOT, 'src/live.ts')) as Promise<Values>
}

describe('the live values an island imports but its render does not read', () => {
  it('are proven by the page, a value no island imports and a keyed one refused', async () => {
    const late = await testSite({ root: ROOT })

    try {
      const { visitors } = await values()

      visitors.set(5)

      const { html } = await late.visit('/')
      const pages = pagesOf(html)
      const ask = async (watch: LiveRequest['watch']) => late.fetch('/_kay/live', { ...JSON_POST, body: JSON.stringify({ proofs: proofsOf(pages), watch } satisfies LiveRequest) })

      expect(html).not.toContain('class="late"')
      expect(pages.flatMap(page => page.values)).toEqual([[VISITORS, '', 5]])

      const feed = new Feed(await ask([[VISITORS, '']]))

      expect(await feed.next()).toEqual([[VISITORS, '', 5]])
      await feed.close()
      expect((await ask([[SECRET, '']])).status).toBe(403)
      expect((await ask([[ROOM, 'lobby']])).status).toBe(403)
    }
    finally {
      await late.close()
    }
  })
})

describe.skipIf(chrome === undefined && (process.env.CI ?? '') === '')('a live value an island reads after the page rendered', () => {
  let site: TestSite

  beforeAll(async () => {
    site = await testSite({ root: ROOT, browser: { path: chrome } })
  }, 120_000)

  afterAll(async () => site?.close())

  it('is followed behind a click or in a client island', async () => {
    const { visitors } = await values()

    visitors.set(60)

    await using page = await site.open('/')

    expect(await page.evaluate(() => document.querySelector('p.late') === null && document.querySelector('p.revealed') === null)).toBe(true)
    await page.click('button.toggle')
    await page.click('button.reveal')
    await page.waitUntil(() => document.querySelector('p.late')?.textContent === '60 late' && document.querySelector('p.revealed')?.textContent === '60 revealed')
    visitors.set(61)
    await page.waitUntil(() => document.querySelector('p.late')?.textContent === '61 late' && document.querySelector('p.revealed')?.textContent === '61 revealed', { timeout: '10000ms' })
    expect(page.errors).toEqual([])
  })
})
