import type { Mounted } from 'kay/test'
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import RecordButton from '../src/record-button.kay'
import { click } from './dom'

// The recorders made, the tracks opened and the chunk a recorder hands over, which a test empties for a silent one.
let recorders: { state: string }[] = []
let tracks: FakeTrack[] = []
let chunk: string[] = ['voice']

// Stand-ins for the microphone happy-dom has not: a track that ends, a stream of one, and a recorder handing over one chunk as browsers do on stop.
class FakeTrack extends EventTarget {
  readyState = 'live'

  stop() {
    this.readyState = 'ended'
  }
}

class FakeRecorder extends EventTarget {
  state = 'inactive'
  mimeType = 'audio/webm;codecs=opus'

  constructor(readonly stream: { getTracks: () => FakeTrack[] }) {
    super()
    recorders.push(this)
  }

  start() {
    this.state = 'recording'
  }

  stop() {
    if (this.state === 'inactive')
      return

    this.state = 'inactive'
    queueMicrotask(() => {
      this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: new Blob(chunk, { type: 'audio/webm' }) }))
      this.dispatchEvent(new Event('stop'))
    })
  }
}

let mounted: Mounted | undefined
let opening: () => Promise<unknown>
const originalDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')

function microphone(open: () => Promise<unknown>) {
  opening = open
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => opening() } })
}

function stream() {
  const track = new FakeTrack()

  tracks.push(track)

  return { getTracks: () => [track], getAudioTracks: () => [track] }
}

beforeEach(() => {
  recorders = []
  tracks = []
  chunk = ['voice']
  microphone(async () => stream())
  ;(globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeRecorder
})

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  Reflect.deleteProperty(globalThis, 'MediaRecorder')
  Reflect.deleteProperty(globalThis, 'isSecureContext')

  if (originalDevices)
    Object.defineProperty(navigator, 'mediaDevices', originalDevices)
  else
    Reflect.deleteProperty(navigator, 'mediaDevices')
})

function later() {
  let settleIt: () => void = () => undefined
  const promise = new Promise<void>(resolve => settleIt = resolve)

  return { promise, settle: () => settleIt() }
}

async function mount(props: Record<string, unknown> = {}) {
  const given: File[] = []

  mounted = await mountComponent(RecordButton, { onRecord: (audio: File) => given.push(audio), ...props })

  const root = mounted.root
  const button = root.querySelector('button')!

  return {
    given,
    button,
    look: () => ({
      pressed: button.getAttribute('aria-pressed'),
      busy: button.getAttribute('aria-busy'),
      time: root.querySelector('[data-part=time]')?.textContent ?? null,
      status: root.querySelector('[role=status]')?.textContent ?? '',
      problem: root.querySelector('.kui-notice')?.textContent ?? null,
    }),
  }
}

test('a press records, the next hands the recording over as a file, busy while onRecord pends, and the microphone is released', async () => {
  const sending = later()
  const given: File[] = []
  const { button, look } = await mount({ label: 'Speak', onRecord: async (audio: File) => {
    given.push(audio)
    await sending.promise
  } })

  expect([button.textContent?.trim(), look().pressed]).toEqual(['Speak', 'false'])

  click(button)
  await settle()

  expect(look()).toEqual({ pressed: 'true', busy: null, time: '0:00', status: 'Recording', problem: null })
  expect(recorders[0]!.state).toBe('recording')

  click(button)
  await settle()

  expect(given.map(audio => [audio.name, audio.type, audio.size])).toEqual([['recording.webm', 'audio/webm;codecs=opus', 5]])
  expect([look().pressed, look().busy, look().time, look().status]).toEqual(['false', 'true', null, 'Recording stopped'])
  expect(tracks.map(track => track.readyState)).toEqual(['ended'])

  sending.settle()
  await settle()

  expect([look().busy, look().problem]).toEqual([null, null])
})

test('a microphone the visitor blocks, one missing and one another application holds each say so, and nothing is recorded', async () => {
  const { given, button, look } = await mount()

  for (const [name, said] of [['NotAllowedError', 'The microphone is blocked'], ['NotFoundError', 'No microphone was found.'], ['NotReadableError', 'in use by another application']] as const) {
    microphone(async () => Promise.reject(new DOMException('no', name)))
    click(button)
    await settle()

    expect(look().problem).toContain(said)
    expect([look().pressed, look().busy]).toEqual(['false', null])
  }

  expect([given.length, recorders.length]).toEqual([0, 0])
})

test('a page off https and a browser without MediaRecorder each say why, and a recorder refusing the stream releases the microphone', async () => {
  const { button, look } = await mount()

  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined })
  ;(globalThis as { isSecureContext?: boolean }).isSecureContext = false
  click(button)
  await settle()

  expect(look().problem).toBe('The microphone needs the page opened over https.')

  microphone(async () => stream())
  Reflect.deleteProperty(globalThis, 'MediaRecorder')
  click(button)
  await settle()

  expect([look().problem, tracks.length]).toEqual(['This browser cannot record sound.', 0])

  ;(globalThis as { MediaRecorder?: unknown }).MediaRecorder = class {
    constructor() {
      throw new DOMException('no', 'NotSupportedError')
    }
  }
  click(button)
  await settle()

  expect([look().problem, tracks.map(track => track.readyState)]).toEqual(['This browser cannot record sound.', ['ended']])
})

test('a microphone unplugged mid-recording drops the recording and says so', async () => {
  const { given, button, look } = await mount()

  click(button)
  await settle()
  tracks[0]!.stop()
  tracks[0]!.dispatchEvent(new Event('ended'))
  await settle()

  expect(given).toEqual([])
  expect([look().pressed, look().busy, look().problem]).toEqual(['false', null, 'The microphone was disconnected, so the recording was dropped.'])
})

test('Escape while recording drops it, and a recording with no sound says nothing was recorded', async () => {
  const { given, button, look } = await mount()

  click(button)
  await settle()
  button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await settle()

  expect(given).toEqual([])
  expect([look().pressed, look().status, look().problem]).toEqual(['false', 'Recording cancelled', null])
  expect(tracks[0]!.readyState).toBe('ended')

  chunk = []
  click(button)
  await settle()
  click(button)
  await settle()

  expect(given).toEqual([])
  expect(look().problem).toBe('Nothing was recorded.')
})

test('a rejected onRecord says failure, and the recording stops by itself after maxDuration', async () => {
  const logged = spyOn(console, 'error').mockImplementation(() => undefined)

  try {
    const { button, look } = await mount({ maxDuration: '30ms', failure: 'Not sent', onRecord: async () => Promise.reject(new Error('down')) })

    click(button)
    await settle()
    await Bun.sleep(60)
    await settle()

    expect([look().pressed, look().busy, look().problem]).toEqual(['false', null, 'Not sent'])
    expect(logged).toHaveBeenCalled()
  }
  finally {
    logged.mockRestore()
  }
})

test('a RecordButton removed while it records releases the microphone', async () => {
  const { given, button } = await mount()

  click(button)
  await settle()
  mounted!.unmount()
  mounted = undefined
  await settle()

  expect([tracks[0]!.readyState, given.length]).toEqual(['ended', 0])
})
