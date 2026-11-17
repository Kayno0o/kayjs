import type { TestPage } from 'kay/test'
import { join } from 'node:path'
import { afterAll, afterEach, expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { fakeAi } from '../src'

const site = await testSite({ root: join(import.meta.dir, 'fixture'), browser: true })

afterAll(async () => site.close())
afterEach(() => fakeAi.clear())

const PLAY = '.kai-chat-turn[data-role=assistant] .kai-chat-play'
const SEND = '.kai-chat-form .kai-chat-send'

interface Sound extends EventTarget {
  paused: boolean
}

interface Hall {
  mode: string
  sounds: Sound[]
}

// A stand-in for `new Audio(src)` whose play() the test decides: `plays`, `refuses` as an autoplay policy does, `aborts` yet plays, `aborts-paused` and fails, or `breaks`.
async function stubAudio(page: TestPage) {
  await page.initScript(() => {
    const hall = window as unknown as Hall & { Audio: unknown }

    hall.mode = 'plays'
    hall.sounds = []

    hall.Audio = class extends EventTarget implements Sound {
      paused = true

      constructor() {
        super()
        hall.sounds.push(this)
      }

      async play() {
        const refuse = async (name: string) => Promise.reject(new DOMException('no', name))
        const start = () => {
          this.paused = false
          queueMicrotask(() => this.dispatchEvent(new Event('playing')))
        }

        if (hall.mode === 'refuses')
          return refuse('NotAllowedError')

        if (hall.mode === 'aborts-paused')
          return refuse('AbortError')

        if (hall.mode === 'breaks')
          return refuse('NotSupportedError')

        start()

        return hall.mode === 'aborts' ? refuse('AbortError') : Promise.resolve()
      }

      pause() {
        this.paused = true
      }
    }
  })
}

async function open(path: string) {
  const page = await site.open(path)

  await stubAudio(page)
  await page.reload()
  await page.waitFor('.kai-chat-form textarea')

  return page
}

async function say(page: TestPage, text: string) {
  await page.fill('.kai-chat-form textarea', text)
  await page.click(SEND)
}

async function setMode(page: TestPage, mode: string) {
  return page.evaluate((value: string) => {
    (window as unknown as Hall).mode = value
  }, mode)
}

const heard = async (page: TestPage) => page.text('.heard')
const finish = async (page: TestPage) => page.evaluate(() => (window as unknown as Hall).sounds.at(-1)!.dispatchEvent(new Event('ended')))
const paused = async (page: TestPage) => page.evaluate(() => (window as unknown as Hall).sounds.map(sound => sound.paused))

it('reads a finished reply with the speak action, tells the app when it starts and ends, and offers a stop meanwhile', async () => {
  await using page = await open('/reading')

  await say(page, 'Hi')
  await page.waitFor(`${PLAY}[aria-pressed=true][aria-label="Stop reading"]`)
  await page.waitFor('.speaking', { text: 'on' })
  await page.waitFor('.heard', { text: 'speak:Fake reply to: Hi' })

  await finish(page)
  await page.waitFor(PLAY, { gone: true })
  await page.waitFor('.speaking', { text: 'off' })

  expect(await heard(page)).toBe('speak:Fake reply to: Hi;end:Fake reply to: Hi')
  expect(await page.count('.kai-chat .kui-notice')).toBe(0)
  expect(await paused(page)).toEqual([true])
  expect(page.errors).toEqual([])
}, 120_000)

it('stops the reading when a message is sent or the conversation starts over, and reads the newer reply', async () => {
  await using page = await open('/reading')

  await say(page, 'One')
  await page.waitFor(`${PLAY}[aria-pressed=true]`)
  await say(page, 'Two')
  await page.waitUntil(() => (window as unknown as Hall).sounds.length === 2)

  expect(await paused(page)).toEqual([true, false])

  await page.click('.stop-speaking')
  await page.waitFor('.speaking', { text: 'off' })

  expect(await paused(page)).toEqual([true, true])

  await say(page, 'Three')
  await page.waitUntil(() => (window as unknown as Hall).sounds.length === 3)
  await page.click('.kai-chat-form .kai-chat-new')
  await page.waitFor('.speaking', { text: 'off' })

  expect(await paused(page)).toEqual([true, true, true])
}, 120_000)

it('leaves a play button on the turn when the browser refuses to play unasked, which plays it', async () => {
  await using page = await open('/reading')

  await setMode(page, 'refuses')
  await say(page, 'Hi')
  await page.waitFor(`${PLAY}[aria-pressed=false][aria-label="Read the reply aloud"]`)

  expect([await page.count('.kai-chat .kui-notice'), await heard(page)]).toEqual([0, ''])

  await setMode(page, 'plays')
  await page.click(PLAY)
  await page.waitFor(`${PLAY}[aria-pressed=true]`)
  await page.waitFor('.heard', { text: 'speak:Fake reply to: Hi' })
  await page.waitFor('.speaking', { text: 'on' })
}, 120_000)

it('shows a notice for a failed play, and none for a play cut short that plays anyway', async () => {
  await using page = await open('/reading')

  await setMode(page, 'aborts')
  await say(page, 'Hi')
  await page.waitFor(`${PLAY}[aria-pressed=true]`)

  expect(await page.count('.kai-chat .kui-notice')).toBe(0)

  await page.click('.stop-speaking')
  await setMode(page, 'aborts-paused')
  await say(page, 'Again')
  await page.waitFor('.kai-chat .kui-notice', { text: 'The reply could not be read aloud.' })

  expect(await heard(page)).toContain('fail:Fake reply to: Again:The reply could not be read aloud.')
}, 120_000)

it('shows the refusal of the speak action as the notice, and clears it with the next send', async () => {
  await using page = await open('/reading')

  await say(page, 'Refuse')
  await page.waitFor('.kai-chat .kui-notice', { text: 'Too long to read.' })
  await say(page, 'Fine')
  await page.waitFor('.kai-chat .kui-notice', { gone: true })
}, 120_000)

it('leaves the choice to the visitor with autoplay off: a play button on each reply and nothing played unasked', async () => {
  await using page = await open('/reading-manual')

  await say(page, 'Hi')
  await page.waitFor(`${PLAY}[aria-label="Read the reply aloud"]`)

  expect(await page.evaluate(() => (window as unknown as Hall).sounds.length)).toBe(0)

  await page.click(PLAY)
  await page.waitFor(`${PLAY}[aria-pressed=true]`)
  await page.click(PLAY)
  await page.waitFor(`${PLAY}[aria-pressed=false]`)

  expect(await paused(page)).toEqual([true])
}, 120_000)
