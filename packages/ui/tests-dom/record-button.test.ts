import type { Mounted } from 'kay/test'
import { afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import RecordButton from '../src/record-button.kay'
import { click } from './dom'

// The recorders made, the tracks opened, the chunk a recorder hands over, which a test empties for a silent one, and what a stopped recorder waits on before it says so.
let recorders: { state: string }[] = []
let tracks: FakeTrack[] = []
let chunk: string[] = ['voice']
let held: Promise<void> | undefined

// Stand-ins for the microphone happy-dom has not: a track that ends, a stream of one, and a recorder handing over one chunk as browsers do on stop.
class FakeTrack extends EventTarget {
  readyState = 'live'

  stop() {
    this.readyState = 'ended'
  }
}

class FakeRecorder extends EventTarget {
  // The list of the test that installed this class, so a recorder a slow microphone opens after its test ended is not counted by the next.
  static into: { state: string }[] = []
  state = 'inactive'
  mimeType = 'audio/webm;codecs=opus'

  constructor(readonly stream: { getTracks: () => FakeTrack[] }) {
    super()
    ;(this.constructor as typeof FakeRecorder).into.push(this)
  }

  start() {
    this.state = 'recording'
  }

  stop() {
    if (this.state === 'inactive')
      return

    this.state = 'inactive'
    void this.stopped()
  }

  private async stopped() {
    await held
    this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: new Blob(chunk, { type: 'audio/webm' }) }))
    this.dispatchEvent(new Event('stop'))
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

// The recorder loads its recording code with a dynamic import, which reads a file the first time: a press settled on one macrotask can come before it under load.
beforeAll(async () => {
  await import('../src/recording')
})

beforeEach(() => {
  recorders = []
  tracks = []
  chunk = ['voice']
  held = undefined
  microphone(async () => stream())
  ;(globalThis as { MediaRecorder?: unknown }).MediaRecorder = class extends FakeRecorder {
    static override into = recorders
  }
})

afterEach(async () => {
  mounted?.unmount()
  mounted = undefined
  // Lets a microphone still opening land, and be released by the unmounted button, before the next test starts.
  await settle()
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

test('a press records, the next hands the recording over as a file, busy and said stopped while onRecord pends, and the microphone is released', async () => {
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

  expect([look().busy, look().status, look().problem]).toEqual([null, '', null])
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
    const { button, look } = await mount({ maxDuration: '30ms', failureLabel: 'Not sent', onRecord: async () => Promise.reject(new Error('down')) })

    click(button)
    await settle()
    await Bun.sleep(60)
    await settle()

    expect([look().pressed, look().busy, look().status, look().problem]).toEqual(['false', null, '', 'Not sent'])
    expect(logged).toHaveBeenCalled()
  }
  finally {
    logged.mockRestore()
  }
})

test('a recording whose maxDuration runs out is handed over as if pressed, and an Escape before its audio arrives drops nothing', async () => {
  const stopping = later()
  const { given, button, look } = await mount({ maxDuration: '30ms' })

  held = stopping.promise
  click(button)
  await settle()
  await Bun.sleep(60)

  expect([recorders[0]!.state, look().pressed]).toEqual(['inactive', 'true'])
  // dispatchEvent is false when a listener prevented the default, which Escape does only when it dropped a recording.
  expect(button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))).toBe(true)

  stopping.settle()
  await settle()

  expect(given.map(audio => audio.name)).toEqual(['recording.webm'])
  expect([look().pressed, look().busy, look().status, look().problem]).toEqual(['false', null, '', null])
  expect(tracks.map(track => track.readyState)).toEqual(['ended'])
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

test('reports the start, how a recording stopped before onRecord, a cancel and each problem', async () => {
  const logged = spyOn(console, 'error').mockImplementation(() => undefined)
  const events: unknown[] = []
  const hear = (name: string) => (...args: unknown[]) => events.push([name, ...args])

  try {
    const { button } = await mount({
      maxDuration: '30ms',
      onRecord: async () => {
        events.push(['record'])

        return Promise.reject(new Error('down'))
      },
      onStart: hear('start'),
      onStop: hear('stop'),
      onCancel: hear('cancel'),
      onError: ({ problem, error }: { problem: string, error?: Error }) => events.push(['error', problem, error?.message]),
    })

    microphone(async () => Promise.reject(new DOMException('no', 'NotAllowedError')))
    click(button)
    await settle()
    microphone(async () => stream())
    click(button)
    await settle()
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await settle()

    events.push(['--'])
    click(button)
    await settle()
    await Bun.sleep(60)
    await settle()

    expect(events).toEqual([['error', 'denied', undefined], ['start'], ['cancel'], ['--'], ['start'], ['stop', 'limit'], ['record'], ['error', 'send', 'down']])
  }
  finally {
    logged.mockRestore()
  }
})

test('onStop says press for the press that stopped a recording, then onRecord follows', async () => {
  const events: string[] = []
  const { button } = await mount({ onStart: () => events.push('start'), onStop: (reason: string) => events.push(`stop:${reason}`), onRecord: () => events.push('record') })

  click(button)
  await settle()
  click(button)
  await settle()

  expect(events).toEqual(['start', 'stop:press', 'record'])
})

test('onRecordingChange says true as a press asks for the microphone and false once the recording ends, however it ended', async () => {
  const changes: boolean[] = []
  const { button } = await mount({ onRecordingChange: (recording: boolean) => changes.push(recording) })

  click(button)
  await settle()

  expect(changes).toEqual([true])

  click(button)
  await settle()

  expect(changes).toEqual([true, false])

  click(button)
  await settle()
  button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await settle()

  expect(changes).toEqual([true, false, true, false])

  microphone(async () => Promise.reject(new DOMException('no', 'NotAllowedError')))
  click(button)
  await settle()

  expect(changes).toEqual([true, false, true, false, true, false])

  microphone(async () => stream())
  click(button)
  await settle()
  tracks.at(-1)!.stop()
  tracks.at(-1)!.dispatchEvent(new Event('ended'))
  await settle()

  expect(changes.slice(6)).toEqual([true, false])
})

test('a controlled recording starts as a press would, stops and hands over when set false, and a recording that ended on its own is not started again', async () => {
  const changes: boolean[] = []
  const { given, look } = await mount({ recording: false, onRecordingChange: (recording: boolean) => changes.push(recording) })

  expect(recorders.length).toBe(0)

  await mounted!.setProps({ recording: true })
  await settle()

  expect([look().pressed, look().status, recorders.length, changes]).toEqual(['true', 'Recording', 1, [true]])

  await mounted!.setProps({ recording: false })
  await settle()

  expect([given.length, look().pressed, changes]).toEqual([1, 'false', [true, false]])

  await mounted!.setProps({ recording: true })
  await settle()
  button(mounted!).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await settle()

  expect([look().pressed, recorders.length, changes]).toEqual(['false', 2, [true, false, true, false]])
})

test('a recording set false while the microphone is still being asked for stops once it opens', async () => {
  const opened = later()
  const changes: boolean[] = []
  const { given } = await mount({ recording: false, onRecordingChange: (recording: boolean) => changes.push(recording) })

  microphone(async () => {
    await opened.promise

    return stream()
  })
  await mounted!.setProps({ recording: true })
  await mounted!.setProps({ recording: false })
  opened.settle()
  await settle()

  expect(given.length).toBe(1)
  expect(changes).toEqual([true, false])
})

test('a recording set false then true again while the microphone is asked for keeps recording', async () => {
  const opened = later()
  const { look } = await mount({ recording: false })

  microphone(async () => {
    await opened.promise

    return stream()
  })
  await mounted!.setProps({ recording: true })
  await mounted!.setProps({ recording: false })
  await mounted!.setProps({ recording: true })
  opened.settle()
  await settle()

  expect(look().pressed).toBe('true')
})

test('onRecordingChange says false when maxDuration ends a recording and when the button goes mid-recording', async () => {
  const changes: boolean[] = []
  const { button } = await mount({ maxDuration: '30ms', onRecordingChange: (recording: boolean) => changes.push(recording) })

  click(button)
  await settle()
  await Bun.sleep(60)
  await settle()

  expect(changes).toEqual([true, false])

  mounted!.unmount()

  const gone: boolean[] = []
  const second = await mount({ onRecordingChange: (recording: boolean) => gone.push(recording) })

  click(second.button)
  await settle()
  mounted!.unmount()
  mounted = undefined

  expect(gone).toEqual([true, false])
})

function button(target: Mounted) {
  return target.root.querySelector('button')!
}
