import { afterEach, expect, mock, test } from 'bun:test'
import { settle } from 'kay/test'

// A stand-in for hls.js that logs what the gallery asks of it.
class FakeHls {
  static supported = true
  static made: FakeHls[] = []
  calls: string[] = []

  static isSupported() {
    return FakeHls.supported
  }

  constructor(public options: { autoStartLoad: boolean }) {
    FakeHls.made.push(this)
  }

  loadSource(src: string) {
    this.calls.push(`load ${src}`)
  }

  attachMedia() {
    this.calls.push('attach')
  }

  startLoad() {
    this.calls.push('start')
  }

  destroy() {
    this.calls.push('destroy')
  }
}

mock.module('hls.js', () => ({ default: FakeHls }))

const { playSource } = await import('../src/media')

afterEach(() => {
  FakeHls.made = []
  FakeHls.supported = true
})

function video(native = false): HTMLVideoElement {
  const element = document.createElement('video')

  element.canPlayType = type => native && type === 'application/vnd.apple.mpegurl' ? 'maybe' : ''

  return element
}

test('plays a file, or a playlist the browser plays itself, straight from its source', () => {
  const file = video()
  const native = video(true)

  playSource(file, '/clip.mp4')
  playSource(native, '/live.m3u8')

  expect([file.src, native.src, FakeHls.made]).toEqual([expect.stringContaining('/clip.mp4'), expect.stringContaining('/live.m3u8'), []])
})

test('plays a playlist through hls.js, loading nothing before the first play, and stops it on cleanup', async () => {
  const element = video()
  const stop = playSource(element, '/live.m3u8')

  await settle()

  const [player] = FakeHls.made

  expect([player?.options.autoStartLoad, player?.calls]).toEqual([false, ['load /live.m3u8', 'attach']])

  element.dispatchEvent(new Event('play'))
  element.dispatchEvent(new Event('play'))
  stop()

  expect(player?.calls).toEqual(['load /live.m3u8', 'attach', 'start', 'destroy'])
})

test('makes no player for a video stopped before hls.js loaded, and falls back to the source where hls.js is unsupported', async () => {
  playSource(video(), '/live.m3u8')()
  await settle()

  expect(FakeHls.made).toEqual([])

  FakeHls.supported = false

  const element = video()

  playSource(element, '/live.m3u8')
  await settle()

  expect([FakeHls.made, element.src]).toEqual([[], expect.stringContaining('/live.m3u8')])
})
