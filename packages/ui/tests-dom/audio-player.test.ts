import type { Mounted } from 'kay/test'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import AudioPlayers from '../tests/fixture/src/components/audio-players.kay'
import { click } from './dom'

const LENGTH = 120

type Handler = ((details: { seekTime?: number }) => void) | null

// A stand-in for the media element happy-dom does not play: the time and length the test sets, and the events a browser fires.
function fake(audio: HTMLAudioElement) {
  let time = 0
  let paused = true

  Object.defineProperties(audio, {
    currentTime: { get: () => time, set: (value: number) => { time = value }, configurable: true },
    duration: { get: () => LENGTH, configurable: true },
    paused: { get: () => paused, configurable: true },
    play: { value: async () => {
      paused = false
      audio.dispatchEvent(new Event('play'))
    }, configurable: true },
    pause: { value: () => {
      paused = true
      audio.dispatchEvent(new Event('pause'))
    }, configurable: true },
  })
  audio.dispatchEvent(new Event('loadedmetadata'))

  return (seconds: number) => {
    time = seconds
    audio.dispatchEvent(new Event('timeupdate'))
  }
}

let mounted: Mounted | undefined
let positions: number[] = []
let chapters: number[] = []
let handlers: Record<string, Handler> = {}
let metadata: { title: string, artist: string, album: string } | null = null
const original = Object.getOwnPropertyDescriptor(navigator, 'mediaSession')

beforeEach(() => {
  handlers = {}
  metadata = null
  Object.defineProperty(navigator, 'mediaSession', {
    configurable: true,
    value: {
      setActionHandler: (action: string, handler: Handler) => { handlers[action] = handler },
      get metadata() { return metadata },
      set metadata(value: typeof metadata) { metadata = value },
    },
  })
  ;(globalThis as { MediaMetadata?: unknown }).MediaMetadata = class {
    constructor(init: { title: string, artist: string, album: string }) {
      Object.assign(this, init)
    }
  }
})

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  positions = []
  chapters = []

  if (original)
    Object.defineProperty(navigator, 'mediaSession', original)
  else
    Reflect.deleteProperty(navigator, 'mediaSession')
})

async function players() {
  mounted = await mountComponent(AudioPlayers, { onPosition: (seconds: number) => positions.push(seconds), onChapter: (index: number) => chapters.push(index) })

  const root = mounted.root
  const player = root.querySelector<HTMLElement>('#player')!
  const audio = player.querySelector('audio')!
  const move = fake(audio)

  await settle()

  return {
    root,
    player,
    audio,
    move: async (seconds: number) => {
      move(seconds)
      await settle()
    },
    part: (name: string) => [...player.querySelectorAll<HTMLElement>(`[data-part="${name}"]`)],
    current: (name: string) => [...player.querySelectorAll(`[data-part="${name}"]`)].findIndex(element => element.getAttribute('aria-current') === 'true'),
  }
}

test('plays a source from a bar with a play button, the time and a slider, and draws no native controls', async () => {
  const { player, audio, part } = await players()

  expect([audio.getAttribute('src'), audio.hasAttribute('controls'), part('time')[0]!.textContent]).toEqual(['/episode.mp3', false, '0:00 / 2:00'])
  expect(part('play')[0]!.getAttribute('aria-label')).toBe('Play')

  click(part('play')[0]!)
  await settle()
  expect([part('play')[0]!.getAttribute('aria-label'), audio.paused]).toEqual(['Pause', false])

  click(part('play')[0]!)
  await settle()
  expect([part('play')[0]!.getAttribute('aria-label'), audio.paused, player.querySelector('input[type=range]')!.getAttribute('max')]).toEqual(['Play', true, String(LENGTH)])
})

test('the slider seeks, and speaks the time', async () => {
  const { audio, part, move } = await players()
  const track = part('track')[0] as HTMLInputElement

  await move(12)
  expect([track.value, track.getAttribute('aria-valuetext')]).toEqual(['12', '0:12 / 2:00'])

  track.value = '75'
  track.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  expect([audio.currentTime, positions.at(-1)]).toEqual([75, 75])
})

test('chapters are listed with their start and marked on the timeline, the one playing aria-current, with a link and the actions slot beside each', async () => {
  const { part, current, move } = await players()

  expect(part('chapter').map(item => item.querySelector('[data-part="jump"]')!.textContent)).toEqual(['0:00Intro', '0:30News', '1:30Outro'])
  expect(part('mark').map(mark => mark.getAttribute('style'))).toEqual(['inset-inline-start: calc(0.5rem + (100% - 1rem) * 0.25)', 'inset-inline-start: calc(0.5rem + (100% - 1rem) * 0.75)'])
  expect(part('actions').map(actions => actions.textContent)).toEqual(['Like Intro 0', 'Like News 1', 'Like Outro 2'])
  expect(part('chapter')[1]!.querySelector('a')!.getAttribute('href')).toBe('https://example.com/news')
  expect(part('chapter')[1]!.querySelector('a')!.getAttribute('aria-label')).toBe('Open News')
  expect(current('jump')).toBe(0)

  await move(40)
  expect([current('jump'), part('now')[0]!.textContent, chapters]).toEqual([1, 'News', [1]])
})

test('a chapter button seeks to its start and plays', async () => {
  const { audio, part } = await players()

  click(part('jump')[2]!)
  await settle()
  expect([audio.currentTime, audio.paused, positions.at(-1)]).toEqual([90, false, 90])
})

test('the previous button restarts a chapter past its first seconds and goes to the one before otherwise, the next goes on', async () => {
  const { audio, part, move } = await players()
  const [previous, , next] = [part('step')[0]!, part('play')[0]!, part('step')[1]!]

  await move(50)
  click(previous)
  await settle()
  expect(audio.currentTime).toBe(30)

  await move(31)
  click(previous)
  await settle()
  expect(audio.currentTime).toBe(0)

  click(next)
  await settle()
  expect(audio.currentTime).toBe(30)
})

test('the transcript follows the playback, marks the cue playing under its chapter, and seeks on a click', async () => {
  const { audio, part, current, move } = await players()

  expect(part('groupTitle').map(title => title.textContent)).toEqual(['Intro', 'News', 'Outro'])
  expect(part('cue').map(cue => cue.textContent)).toEqual(['Hello. ', 'Welcome. ', 'The news. ', 'Bye. '])
  expect(current('cue')).toBe(0)

  await move(35)
  expect(current('cue')).toBe(2)

  await move(70)
  expect(current('cue')).toBe(-1)

  click(part('cue')[1]!)
  await settle()
  expect([audio.currentTime, audio.paused]).toEqual([10, false])
})

// happy-dom lays nothing out: a folded box has no height, an open one shows two cues of a column where each is 50 high.
function layOut(box: HTMLElement, buttons: HTMLElement[]) {
  const details = box.closest('details')!

  Object.defineProperty(box, 'clientHeight', { get: () => details.open ? 100 : 0, configurable: true })

  for (const [index, button] of buttons.entries()) {
    Object.defineProperty(button, 'offsetTop', { value: index * 50, configurable: true })
    Object.defineProperty(button, 'offsetHeight', { value: 20, configurable: true })
  }
}

test('opening the transcript brings the cue playing into view', async () => {
  const { player, part, move } = await players()
  const box = part('transcript')[0]!

  layOut(box, part('cue'))
  await move(95)
  expect(box.scrollTop).toBe(0)

  const details = player.querySelector('details')!

  details.open = true
  details.dispatchEvent(new Event('toggle'))
  await settle()
  expect(box.scrollTop).toBe(3 * 50 - 40)
})

test('a hand scroll is left alone until a cue changes after it', async () => {
  const { part, move } = await players()
  const box = part('transcript')[0]!

  box.closest('details')!.open = true
  layOut(box, part('cue'))
  await move(15)
  box.dispatchEvent(new Event('wheel', { bubbles: true }))
  box.scrollTop = 0
  await move(35)
  expect(box.scrollTop).toBe(0)

  const realNow = Date.now

  Date.now = () => realNow() + 5000

  try {
    await move(100)
    await move(5)
    expect(box.scrollTop).toBe(0)
    await move(95)
    expect(box.scrollTop).toBe(3 * 50 - 40)
  }
  finally {
    Date.now = realNow
  }
})

test('the cues are one tab stop, the cue playing, and the arrows go between them', async () => {
  const { part, move } = await players()
  const cues = part('cue')

  expect(cues.map(cue => cue.tabIndex)).toEqual([0, -1, -1, -1])
  await move(35)
  expect(cues.map(cue => cue.tabIndex)).toEqual([-1, -1, 0, -1])

  const press = (cue: HTMLElement, key: string) => cue.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))

  cues[2]!.focus()
  press(cues[2]!, 'ArrowRight')
  await settle()
  expect([document.activeElement === cues[3], cues.map(cue => cue.tabIndex)]).toEqual([true, [-1, -1, -1, 0]])

  press(cues[3]!, 'ArrowRight')
  press(cues[3]!, 'Home')
  await settle()
  expect(document.activeElement === cues[0]).toBe(true)
})

test('the lock screen shows the chapter playing and skips between chapters', async () => {
  const { audio, move } = await players()

  expect(metadata).toBeNull()

  await audio.play()
  await settle()
  expect(metadata).toMatchObject({ title: 'Intro', artist: 'Show', album: 'Episode' })

  await move(40)
  expect(metadata).toMatchObject({ title: 'News' })

  handlers.nexttrack!({})
  await settle()
  expect(audio.currentTime).toBe(90)

  handlers.previoustrack!({})
  await settle()
  expect(audio.currentTime).toBe(30)

  handlers.seekto!({ seekTime: 5 })
  await settle()
  expect(audio.currentTime).toBe(5)
})

test('a player with no chapters takes no chapter buttons and leaves the lock screen skips unset', async () => {
  const { root, audio } = await players()
  const plain = root.querySelector('#plain')!

  expect([plain.querySelectorAll('[data-part="step"]').length, plain.querySelector('[data-part="chapters"]'), plain.querySelector('[data-part="transcript"]')]).toEqual([0, null, null])
  expect(plain.querySelector('input')!.hasAttribute('disabled')).toBe(true)
  expect(audio).toBeDefined()
})

test('a position the parent passes is followed', async () => {
  const { root, audio } = await players()

  click(root.querySelector('#jump'))
  await settle()
  await settle()
  expect(audio.currentTime).toBe(45)
})

test('a late echo of a position the player reported does not seek back, and a seek reports once', async () => {
  const { root, audio, part, move } = await players()

  click(part('jump')[2]!)
  await settle()
  await move(90)
  expect(positions).toEqual([90])

  await move(100)
  click(root.querySelector('#late'))
  await settle()
  expect([audio.currentTime, positions]).toEqual([100, [90, 100]])
})

test('a chapter link to another site opens in a new tab, so the audio keeps playing', async () => {
  const { part } = await players()
  const link = part('chapter')[1]!.querySelector('a')!

  expect([link.getAttribute('target'), link.getAttribute('rel')]).toEqual(['_blank', 'noopener noreferrer'])
})

test('a play interrupted by a pause is no failure, and a new source puts the button back to play', async () => {
  const { audio, part } = await players()

  Object.defineProperty(audio, 'play', { value: async () => {
    throw new DOMException('interrupted', 'AbortError')
  }, configurable: true })
  click(part('play')[0]!)
  await settle()
  expect(part('play')[0]!.getAttribute('aria-label')).toBe('Play')

  Object.defineProperty(audio, 'play', { value: async () => audio.dispatchEvent(new Event('play')), configurable: true })
  click(part('play')[0]!)
  await settle()
  expect(part('play')[0]!.getAttribute('aria-label')).toBe('Pause')

  audio.dispatchEvent(new Event('emptied'))
  await settle()
  expect([part('play')[0]!.getAttribute('aria-label'), part('time')[0]!.textContent]).toEqual(['Play', '0:00 / 2:00'])
})

test('leaving the page lifts the lock screen handlers and metadata, and a player without chapters sets no skip', async () => {
  const { root, audio } = await players()
  const plain = root.querySelector<HTMLAudioElement>('#plain audio')!

  fake(plain)
  await plain.play()
  await settle()
  expect([handlers.previoustrack, handlers.nexttrack]).toEqual([null, null])

  await audio.play()
  await settle()
  expect(typeof handlers.nexttrack).toBe('function')

  mounted?.unmount()
  mounted = undefined
  expect([handlers.previoustrack, handlers.nexttrack, handlers.seekto, metadata]).toEqual([null, null, null, null])
})
