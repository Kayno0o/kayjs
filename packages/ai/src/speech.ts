import type { CallOptions } from './config'
import type { AudioFormat } from './types'
import { byteSize, configError } from 'kay/library'
import { setUp } from './config'
import { AiError } from './errors'
import { billed } from './limits'

const DEFAULT_MAX_RECORDING_BYTES = 10 * 1024 * 1024
const DEFAULT_MAX_SPEAK_CHARS = 4096
// What a recording counts against the budget: one character per 250 bytes, so one token per 1,000 bytes.
const BYTES_PER_CHAR = 250
const MIN_SPEED = 0.25
const MAX_SPEED = 4

export interface TranscribeOptions extends CallOptions {
  // What is spoken, as an ISO 639-1 code such as `fr`: left out, the model tells, which a short recording may get wrong.
  language?: string | undefined
  // The most bytes the recording may hold, bytes or a size such as `'5mb'`, 10 MB by default; a larger one fails with a `too-long` error before the provider is called. `Infinity` lifts it.
  maxSize?: number | string | undefined
}

export interface SpeakOptions extends CallOptions {
  // The voice to read in, `AI_VOICE` unless given; left out of the request when neither names one.
  voice?: string | undefined
  // From 0.25 to 4, 1 the voice's own pace.
  speed?: number | undefined
  // The audio's format, the server's own (mp3 for OpenAI) unless given.
  format?: AudioFormat | undefined
  // The most characters of text, 4,096 by default (OpenAI's own limit); a longer one fails with a `too-long` error before the provider is called. `Infinity` lifts it.
  maxInputChars?: number | undefined
}

// Writes a recording down, such as one a `Chat` posts: the text, trimmed. The server is `AI_AUDIO_URL`, else the OpenAI-compatible one `ask` uses, the model `AI_TRANSCRIBE_MODEL`; under `bun test` the fake answers.
export async function transcribe(audio: Blob, options: TranscribeOptions = {}): Promise<string> {
  const maxSize = options.maxSize ?? DEFAULT_MAX_RECORDING_BYTES
  const max = maxSize === Infinity ? Infinity : byteSize(maxSize, 'the maxSize of transcribe')

  if (audio.size > max)
    throw new AiError('too-long', `the recording holds ${audio.size} bytes, past the ${max} that maxSize allows`)

  const { send, model, timeout, signal } = setUp('transcribe', options)

  return billed(audio.size / BYTES_PER_CHAR, signal, async () => send({ audio, model, language: options.language, timeout }, signal), text => text.length)
}

// Reads a text aloud: the audio as a Blob, typed by its format, which `new Response(audio)` serves as it is. The server is `AI_AUDIO_URL`, else the OpenAI-compatible one `ask` uses, the model `AI_SPEECH_MODEL` and the voice `AI_VOICE`; under `bun test` the fake answers.
export async function speak(text: string, options: SpeakOptions = {}): Promise<Blob> {
  const { speed } = options

  if (speed !== undefined && !(speed >= MIN_SPEED && speed <= MAX_SPEED))
    throw configError('ai', 'speed', `speak({ speed }) is ${speed}; it takes a number from ${MIN_SPEED} to ${MAX_SPEED}`)

  const maxInputChars = options.maxInputChars ?? DEFAULT_MAX_SPEAK_CHARS

  if (maxInputChars !== Infinity && !(Number.isInteger(maxInputChars) && maxInputChars >= 1))
    throw configError('ai', 'maxInputChars', `speak({ maxInputChars }) is ${maxInputChars}; it takes a whole number of 1 or more, or Infinity`)

  if (text.length > maxInputChars)
    throw new AiError('too-long', `the text holds ${text.length} characters, past the ${maxInputChars} that maxInputChars allows`)

  const { send, model, voice, timeout, signal } = setUp('speak', options)

  return billed(text.length, signal, async () => send({ text, model, voice: options.voice ?? voice, speed, format: options.format, timeout }, signal), () => 0)
}
