import type { CallOptions } from './config'
import type { AudioFormat } from './types'
import { configError } from 'kay/library'
import { setUp } from './config'

const MIN_SPEED = 0.25
const MAX_SPEED = 4

export interface TranscribeOptions extends CallOptions {
  // What is spoken, as an ISO 639-1 code such as `fr`: left out, the model tells, which a short recording may get wrong.
  language?: string | undefined
}

export interface SpeakOptions extends CallOptions {
  // The voice to read in, `AI_VOICE` unless given; left out of the request when neither names one.
  voice?: string | undefined
  // From 0.25 to 4, 1 the voice's own pace.
  speed?: number | undefined
  // The audio's format, the server's own (mp3 for OpenAI) unless given.
  format?: AudioFormat | undefined
}

// Writes a recording down, such as one a `Chat` posts: the text, trimmed. The server is `AI_AUDIO_URL`, else the OpenAI-compatible one `ask` uses, the model `AI_TRANSCRIBE_MODEL`; under `bun test` the fake answers.
export async function transcribe(audio: Blob, options: TranscribeOptions = {}): Promise<string> {
  const { send, model, timeout, signal } = setUp('transcribe', options)

  return send({ audio, model, language: options.language, timeout }, signal)
}

// Reads a text aloud: the audio as a Blob, typed by its format, which `new Response(audio)` serves as it is. The server is `AI_AUDIO_URL`, else the OpenAI-compatible one `ask` uses, the model `AI_SPEECH_MODEL` and the voice `AI_VOICE`; under `bun test` the fake answers.
export async function speak(text: string, options: SpeakOptions = {}): Promise<Blob> {
  const { speed } = options

  if (speed !== undefined && !(speed >= MIN_SPEED && speed <= MAX_SPEED))
    throw configError(`speak({ speed }) is ${speed}; it takes a number from ${MIN_SPEED} to ${MAX_SPEED}`)

  const { send, model, voice, timeout, signal } = setUp('speak', options)

  return send({ text, model, voice: options.voice ?? voice, speed, format: options.format, timeout }, signal)
}
