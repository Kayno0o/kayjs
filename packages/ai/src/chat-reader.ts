import type { Action, Failure } from 'kay'
import { ActionError, ActionRedirectError, signal } from 'kay'

// What a Chat's `speak` action answers: the audio as base64 with its type, which `speakData()` makes, or the address of audio the browser plays (a URL of the app, or a `data:` URL).
export type SpeakAction = Action<{ text: string }, string | { audio: string, type?: string | undefined } | Failure<unknown>>

// A reply to read: its turn and the text a voice says.
export interface Reading {
  id: number
  text: string
}

export interface ReaderOptions {
  readonly speak: () => SpeakAction | undefined
  // What a failure says when the action gave no refusal of its own.
  readonly failedLabel: () => string
  // The audio began playing, ended, or could not be made or played; a throw is the caller's to catch.
  readonly onStart?: ((reading: Reading) => unknown) | undefined
  readonly onEnd?: ((reading: Reading) => unknown) | undefined
  readonly onFail?: ((reading: Reading, message: string) => unknown) | undefined
}

const DEFAULT_TYPE = 'audio/mpeg'

// The reply as a voice reads it: its markdown is not said, so code blocks, links' addresses, images and the marks around words go.
export function spokenText(markdown: string): string {
  return markdown
    .replaceAll(/```[\s\S]*?```/g, ' ')
    .replaceAll(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replaceAll(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replaceAll(/\[\d+\]/g, '')
    .replaceAll(/^\s{0,3}(?:#{1,6}|[>\-*+]|\d+\.)\s+/gm, '')
    .replaceAll(/[`*~|]|(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, '')
    .replaceAll(/\s+/g, ' ')
    .trim()
}

// What a refused action says (its `ctx.fail` message under 500), else the label; undefined for a redirect, which leaves the page.
function messageOf(error: unknown, fallback: string): string | undefined {
  if (error instanceof ActionRedirectError)
    return undefined

  console.error(error)

  const refusal = error instanceof ActionError && error.status < 500 ? error.errors[''] : undefined

  return refusal === undefined || refusal === '' ? fallback : refusal
}

function addressOf(answer: string | { audio: string, type?: string | undefined }): { src: string, owned: boolean } {
  if (typeof answer === 'string')
    return { src: answer, owned: false }

  const bytes = Uint8Array.from(atob(answer.audio), character => character.charCodeAt(0))

  return { src: URL.createObjectURL(new Blob([bytes], { type: answer.type ?? DEFAULT_TYPE })), owned: true }
}

// Reads replies aloud, one at a time: the turn being read from the request to the end of the audio, the turn that needs a press to play (the browser refused it, or its reading failed), and the last failure. A newer `read` or a `stop` ends the one under way, and an answer or a play that comes back after it is dropped.
export function createReader(options: ReaderOptions) {
  const playing = signal<number | undefined>(undefined)
  const refused = signal<number | undefined>(undefined)
  const problem = signal<string | undefined>(undefined)
  let run = 0
  let audio: HTMLAudioElement | undefined
  let owned: string | undefined

  function release() {
    audio?.pause()
    audio = undefined

    if (owned !== undefined)
      URL.revokeObjectURL(owned)

    owned = undefined
  }

  // Ends the reading under way and forgets the last refusal and failure.
  function stop() {
    run++
    release()
    playing.set(undefined)
    refused.set(undefined)
    problem.set(undefined)
  }

  // A failure ends the run, so the error event and the rejected play() of one broken audio count once.
  function fail(reading: Reading, error: unknown) {
    const message = messageOf(error, options.failedLabel())

    run++
    release()
    playing.set(undefined)

    if (message === undefined)
      return

    problem.set(message)
    refused.set(reading.id)
    options.onFail?.(reading, message)
  }

  // `asked` is a press of the visitor's, which a browser always lets play, so a refusal is only from a reply read unasked.
  async function read(reading: Reading, asked = false): Promise<void> {
    const speak = options.speak()

    stop()

    if (speak === undefined || reading.text === '')
      return

    const mine = run
    let started = false

    playing.set(reading.id)

    try {
      const answer = await speak({ text: reading.text }, { refresh: false }).orThrow()

      if (mine !== run)
        return

      const { src, owned: made } = addressOf(answer)
      const element = new Audio(src)

      audio = element
      owned = made ? src : undefined
      element.addEventListener('playing', () => {
        if (mine !== run || started)
          return

        started = true
        options.onStart?.(reading)
      })
      element.addEventListener('ended', () => {
        if (mine !== run)
          return

        release()
        playing.set(undefined)
        options.onEnd?.(reading)
      })
      element.addEventListener('error', () => {
        if (mine === run)
          fail(reading, new Error('the audio could not be played'))
      })

      try {
        await element.play()
      }
      catch (error) {
        if (mine !== run)
          return

        const name = error instanceof DOMException ? error.name : ''

        // A play() cut short by a new load rejects with AbortError and may play all the same: it failed only if the element is paused.
        if (name === 'AbortError' && !element.paused)
          return

        if (name === 'NotAllowedError' && !asked) {
          release()
          playing.set(undefined)
          refused.set(reading.id)

          return
        }

        throw error
      }
    }
    catch (error) {
      if (mine === run)
        fail(reading, error)
    }
  }

  return { playing, refused, problem, read, stop }
}
