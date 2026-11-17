import type { SpeakAction } from '../src/chat-reader'
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { ActionError } from 'kay'
import { createReader, spokenText } from '../src/chat-reader'
import { speakData } from '../src/speech'

type Mode = 'plays' | 'refuses' | 'aborts' | 'aborts-paused' | 'breaks'

class FakeAudio extends EventTarget {
  static mode: Mode = 'plays'
  static all: FakeAudio[] = []

  paused = true

  constructor(readonly src: string) {
    super()
    FakeAudio.all.push(this)
  }

  async play() {
    const { mode } = FakeAudio

    if (mode === 'refuses')
      throw new DOMException('no', 'NotAllowedError')

    if (mode === 'aborts-paused')
      throw new DOMException('cut', 'AbortError')

    if (mode === 'breaks')
      throw new DOMException('no codec', 'NotSupportedError')

    this.paused = false
    this.dispatchEvent(new Event('playing'))

    if (mode === 'aborts')
      throw new DOMException('cut', 'AbortError')
  }

  pause() {
    this.paused = true
  }
}

const original = globalThis.Audio
const WAV = { audio: btoa('RIFF'), type: 'audio/wav' }

beforeEach(() => {
  FakeAudio.all = []
  FakeAudio.mode = 'plays'
  globalThis.Audio = FakeAudio as unknown as typeof Audio
  spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  globalThis.Audio = original
})

// An action answering `answer`, or throwing it, after the call was made.
function action(answer: unknown): SpeakAction {
  return (() => ({ orThrow: async () => {
    if (answer instanceof Error)
      throw answer

    return answer
  } })) as unknown as SpeakAction
}

function reader(answer: unknown) {
  const told: string[] = []
  const made = createReader({
    speak: () => action(answer),
    failedLabel: () => 'Could not read',
    onStart: ({ id }) => told.push(`start:${id}`),
    onEnd: ({ id }) => told.push(`end:${id}`),
    onFail: ({ reading: { id }, message }) => told.push(`fail:${id}:${message}`),
  })

  return { ...made, told }
}

const settle = async () => new Promise(resolve => setTimeout(resolve, 0))

test('reads the audio of the action and tells its start and end', async () => {
  const { read, playing, told } = reader(WAV)

  await read({ id: 1, text: 'Hello' })
  await settle()

  expect([playing(), told]).toEqual([1, ['start:1']])

  FakeAudio.all[0]!.dispatchEvent(new Event('ended'))

  expect([playing(), told]).toEqual([undefined, ['start:1', 'end:1']])
})

test('plays the address an action answers as a string', async () => {
  const { read } = reader('/voice/1.mp3')

  await read({ id: 1, text: 'Hello' })

  expect(FakeAudio.all[0]!.src).toBe('/voice/1.mp3')
})

test('a newer reading and a stop end the one under way', async () => {
  const { read, stop, playing } = reader(WAV)

  await read({ id: 1, text: 'One' })
  await read({ id: 2, text: 'Two' })

  expect([FakeAudio.all.map(audio => audio.paused), playing()]).toEqual([[true, false], 2])

  stop()

  expect([FakeAudio.all.map(audio => audio.paused), playing()]).toEqual([[true, true], undefined])
})

test('drops the answer of a reading stopped while the action was working', async () => {
  const { read, stop, playing } = reader(WAV)
  const pending = read({ id: 1, text: 'One' })

  stop()
  await pending

  expect([FakeAudio.all.length, playing()]).toEqual([0, undefined])
})

test('a browser refusing to play unasked leaves the turn to play on a press, which it always lets', async () => {
  const { read, refused, playing, problem, told } = reader(WAV)

  FakeAudio.mode = 'refuses'
  await read({ id: 1, text: 'One' })

  expect([refused(), playing(), problem(), told]).toEqual([1, undefined, undefined, []])

  FakeAudio.mode = 'plays'
  await read({ id: 1, text: 'One' }, true)

  expect([refused(), playing(), problem()]).toEqual([undefined, 1, undefined])
})

test('a play cut short that plays anyway is no failure, one left paused is', async () => {
  const { read, playing, problem, told } = reader(WAV)

  FakeAudio.mode = 'aborts'
  await read({ id: 1, text: 'One' })
  await settle()

  expect([playing(), problem(), told]).toEqual([1, undefined, ['start:1']])

  FakeAudio.mode = 'aborts-paused'
  await read({ id: 2, text: 'Two' })

  expect([playing(), problem(), told.at(-1)]).toEqual([undefined, 'Could not read', 'fail:2:Could not read'])
})

test('a play that breaks fails with the label, a refusal of the action with its own message', async () => {
  const broken = reader(WAV)

  FakeAudio.mode = 'breaks'
  await broken.read({ id: 1, text: 'One' })

  expect(broken.problem()).toBe('Could not read')

  FakeAudio.mode = 'plays'

  const refused = reader(new ActionError(422, '', { '': 'Too long to read.' }))

  await refused.read({ id: 1, text: 'One' })

  expect([refused.problem(), refused.told]).toEqual(['Too long to read.', ['fail:1:Too long to read.']])

  const down = reader(new ActionError(500, '', { '': 'secret' }))

  await down.read({ id: 1, text: 'One' })

  expect(down.problem()).toBe('Could not read')
})

test('a broken audio reports its failure once and keeps the turn to play again', async () => {
  const { read, refused, told } = reader(WAV)

  FakeAudio.mode = 'breaks'
  await read({ id: 1, text: 'One' })
  FakeAudio.all[0]!.dispatchEvent(new Event('error'))

  expect([told, refused()]).toEqual([['fail:1:Could not read'], 1])
})

test('a reading that ends in an error event fails, and a new reading clears the notice', async () => {
  const { read, problem } = reader(WAV)

  await read({ id: 1, text: 'One' })
  FakeAudio.all[0]!.dispatchEvent(new Event('error'))

  expect(problem()).toBe('Could not read')

  await read({ id: 2, text: 'Two' })

  expect(problem()).toBeUndefined()
})

test('says the text of a reply without its markdown', () => {
  expect(spokenText('# Title\n\nSome **bold** text with a [link](https://x.test) and `code` [1].\n\n```ts\nconst a = 1\n```\n\n- one\n- two')).toBe('Title Some bold text with a link and code . one two')
})

test('speakData answers the audio as base64 with its type', async () => {
  const data = await speakData('Hello')

  expect(data.type).toBe('audio/wav')
  expect(new Blob([Uint8Array.from(atob(data.audio), character => character.charCodeAt(0))]).size).toBeGreaterThan(44)
})

test('keeps an underscore inside a word and drops the ones that mark emphasis', () => {
  expect(spokenText('Call _this_ snake_case name')).toBe('Call this snake_case name')
})
