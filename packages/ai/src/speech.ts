import type { AudioFormat, CallOptions } from './types'
import { byteSize, configError } from 'kay/library'
import { setUp } from './call'
import { AiError } from './errors'
import { billed } from './limits'
import { speechLanguage } from './locale'

const DEFAULT_MAX_RECORDING_BYTES = 10 * 1024 * 1024
const DEFAULT_MAX_SPEAK_CHARS = 4096
// What a recording counts against the budget: one character per 250 bytes, so one token per 1,000 bytes.
const BYTES_PER_CHAR = 250
const MIN_SPEED = 0.25
const MAX_SPEED = 4

export interface TranscribeOptions extends CallOptions {
  // What is spoken, a BCP 47 tag such as `fr` or `fr-FR` as everywhere in kay, sent to the provider as the ISO 639-1 code it takes (`fr`): left out, the model tells, which a short recording may get wrong.
  locale?: string | undefined
  /** @deprecated Written `locale`, which takes a BCP 47 tag; `deprecated-ai-language` rewrites it. Removed in 1.108. */
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

  const { send, signal } = setUp('transcribe', options)
  const locale = options.locale ?? options.language
  const language = locale === undefined ? undefined : speechLanguage(locale, 'transcribe({ locale })')

  return billed(audio.size / BYTES_PER_CHAR, signal, async () => send({ audio, language }), text => text.length)
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

  const { send, voice, signal } = setUp('speak', options)

  return billed(text.length, signal, async () => send({ text, voice: options.voice ?? voice, speed, format: options.format }), () => 0)
}

// `speak()` as an action can answer it: the audio as base64 with its type, which a Chat's `speak` action plays. An action's answer is JSON, so the Blob itself cannot go.
export async function speakData(text: string, options: SpeakOptions = {}): Promise<{ audio: string, type: string }> {
  const blob = await speak(text, options)

  return { audio: Buffer.from(await blob.arrayBuffer()).toString('base64'), type: blob.type }
}
