import type { TestPage } from 'kay/test'
import { join } from 'node:path'
import { afterAll, afterEach, expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { fakeAi } from '../src'

const site = await testSite({ root: join(import.meta.dir, 'fixture'), browser: true })

afterAll(async () => site.close())
afterEach(() => fakeAi.clear())

const MIC = '.kai-chat-form .kai-chat-record'

interface Voice {
  said: string
  refusal: string | undefined
  tracks: { readyState: string }[]
}

// Chromium in a test has no microphone: a stream of one track, and a recorder handing over `said` as its one chunk, the bytes the fixture's transcribe reads back as the text.
async function microphone(page: TestPage) {
  await page.initScript(() => {
    const voice = window as unknown as Voice & { MediaRecorder: unknown }

    voice.said = 'Hello there'
    voice.refusal = undefined
    voice.tracks = []

    class Track extends EventTarget {
      readyState = 'live'

      stop() {
        this.readyState = 'ended'
      }
    }

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          if (voice.refusal !== undefined)
            throw new DOMException('no', voice.refusal)

          const track = new Track()

          voice.tracks.push(track)

          return { getTracks: () => [track], getAudioTracks: () => [track] }
        },
      },
    })

    voice.MediaRecorder = class extends EventTarget {
      state = 'inactive'
      mimeType = 'audio/webm'

      start() {
        this.state = 'recording'
      }

      stop() {
        this.state = 'inactive'
        setTimeout(() => {
          this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: new Blob([voice.said], { type: 'audio/webm' }) }))
          this.dispatchEvent(new Event('stop'))
        })
      }
    }
  })
}

it('records from the microphone, sends what transcribe wrote down after the typed text, stops saying it is written down, and releases the microphone', async () => {
  await using page = await site.open('/speaking')

  await microphone(page)
  await page.reload()
  await page.waitFor(`${MIC}[aria-label="Speak a message"][aria-pressed=false]`)

  expect(await page.a11y('.kai-chat-form')).toEqual([])

  await page.fill('.kai-chat-form textarea', 'Say')
  await page.click(MIC)
  await page.waitFor(`${MIC}[aria-pressed=true]`)
  await page.waitFor('.kai-chat-status p', { text: 'Recording' })
  await page.click(MIC)
  await page.waitFor('.kai-chat-turn[data-role=assistant]', { text: 'Fake reply to: Say Hello there' })

  expect(await page.text('.kai-chat-turn[data-role=user]')).toBe('Say Hello there')
  expect(await page.text('.kai-chat-status')).toBe('')
  expect(await page.value('.kai-chat-form textarea')).toBe('')
  expect(await page.evaluate(() => (window as unknown as Voice).tracks.map(track => track.readyState))).toEqual(['ended'])
  expect(page.errors).toEqual([])
}, 120_000)

it('says why nothing was sent: a refused transcription, no text, and a blocked microphone', async () => {
  await using page = await site.open('/speaking')

  await microphone(page)
  await page.reload()
  await page.waitFor(MIC)

  for (const [said, refusal, notice] of [['refuse', undefined, 'Too noisy to write down.'], ['  ', undefined, 'Nothing was heard.'], ['x', 'NotAllowedError', 'The microphone is blocked']] as const) {
    await page.evaluate((text: string, name: string | null) => {
      const voice = window as unknown as Voice

      voice.said = text
      voice.refusal = name ?? undefined
    }, said, refusal ?? null)
    await page.click(MIC)

    if (refusal === undefined) {
      await page.waitFor(`${MIC}[aria-pressed=true]`)
      await page.click(MIC)
    }

    await page.waitFor('.kai-chat .kui-notice', { text: notice })
    await page.waitFor(`${MIC}:not([aria-busy])`)
  }

  expect(await page.count('.kai-chat-turn')).toBe(0)
}, 120_000)

// Speaks `said`: one press records, the next sends it to transcribe.
async function speak(page: TestPage, said: string) {
  await page.evaluate((text: string) => {
    (window as unknown as Voice).said = text
  }, said)
  await page.click(MIC)
  await page.waitFor(`${MIC}[aria-pressed=true]`)
  await page.click(MIC)
}

it('leaves what was said in the field while a reply is under way, and drops a transcription the visitor started over during', async () => {
  await using page = await site.open('/speaking')

  await microphone(page)
  await page.reload()
  await page.waitFor(MIC)
  await page.fill('.kai-chat-form textarea', 'Hold')
  await page.click('.kai-chat-form .kai-chat-send')
  await page.waitFor('.kai-chat-turn[data-role=assistant]', { text: 'Working' })
  await speak(page, 'Hello there')
  await page.waitUntil(() => document.querySelector('textarea')?.value === 'Hello there')

  expect(await page.count('.kai-chat-turn[data-role=user]')).toBe(1)

  await page.click('.kai-chat-form .kai-chat-new')
  await page.waitFor('.kai-chat-turn', { gone: true })
  await page.fill('.kai-chat-form textarea', 'Hi')
  await page.click('.kai-chat-form .kai-chat-send')
  await page.waitFor('.kai-chat-turn[data-role=assistant]', { text: 'Fake reply to: Hi' })
  await speak(page, 'slow Late words')
  await page.waitFor(`${MIC}[aria-busy=true]`)
  await page.click('.kai-chat-form .kai-chat-new')
  await page.waitFor(`${MIC}:not([aria-busy])`, { timeout: '3s' })

  expect([await page.count('.kai-chat-turn'), await page.value('.kai-chat-form textarea'), await page.count('.kai-chat .kui-notice')]).toEqual([0, '', 0])
}, 120_000)

it('drops a recording on Escape from the keyboard, saying so', async () => {
  await using page = await site.open('/speaking')

  await microphone(page)
  await page.reload()
  await page.waitFor(MIC)
  await page.evaluate((selector: string) => document.querySelector<HTMLElement>(selector)!.focus(), MIC)
  await page.press('Enter')
  await page.waitFor(`${MIC}[aria-pressed=true]`)
  await page.press('Escape')
  await page.waitFor(`${MIC}[aria-pressed=false]`)
  await page.waitFor('.kai-chat-status p', { text: 'Recording cancelled' })

  await page.waitUntil(() => (window as unknown as Voice).tracks.every(track => track.readyState === 'ended'))

  expect(await page.count('.kai-chat-turn')).toBe(0)
}, 120_000)

// Whether a script the page loaded holds the recorder's own code.
async function recorderLoaded() {
  const scripts = performance.getEntriesByType('resource').filter(entry => entry.name.endsWith('.js')).map(entry => entry.name)
  const texts = await Promise.all(scripts.map(async url => (await fetch(url)).text()))

  return texts.some(text => text.includes('getUserMedia'))
}

it('ships no recorder to a chat without transcribe, and loads it as a chat with one mounts', async () => {
  await using quiet = await site.open('/quiet')

  await quiet.waitFor('.kai-chat-form textarea')

  expect([await quiet.count(MIC), await quiet.evaluate(recorderLoaded)]).toEqual([0, false])

  await using speaking = await site.open('/speaking')

  await speaking.waitUntil(recorderLoaded)
}, 120_000)
