import type { Duration, Signal } from 'kay'
import type { Recording, RecordProblem } from './recording'
import { onCleanup, onMount, signal } from 'kay'
import { wording } from 'kay/words'

export type { RecordProblem } from './recording'

// How long a recording runs by default before it is handed over as if pressed, so one left running stays within an action's `maxSize`.
export const RECORD_LIMIT: Duration = '5m'

export type RecordWords = Record<RecordProblem | 'recording' | 'stopped' | 'cancelled', string>

// What a recording says to the visitor, in the page's language. Called while the component renders, so an island looking them up on the server has them in the browser too, though the recorder itself loads later.
export function recordWords(): RecordWords {
  return {
    recording: wording('ui.recordButton.recording', 'Recording'),
    stopped: wording('ui.recordButton.stopped', 'Recording stopped'),
    cancelled: wording('ui.recordButton.cancelled', 'Recording cancelled'),
    insecure: wording('ui.recordButton.insecure', 'The microphone needs the page opened over https.'),
    unsupported: wording('ui.recordButton.unsupported', 'This browser cannot record sound.'),
    denied: wording('ui.recordButton.denied', 'The microphone is blocked: allow it for this site in the browser\'s settings.'),
    missing: wording('ui.recordButton.missing', 'No microphone was found.'),
    taken: wording('ui.recordButton.taken', 'The microphone is in use by another application.'),
    failed: wording('ui.recordButton.failed', 'The microphone could not be opened.'),
    lost: wording('ui.recordButton.lost', 'The microphone was disconnected, so the recording was dropped.'),
    empty: wording('ui.recordButton.empty', 'Nothing was recorded.'),
  }
}

export interface RecorderOptions {
  // Takes what was said; a promise it returns holds `state` at `sending` until it settles, and a rejection sets `problem` to `failure`.
  onAudio: (audio: File) => unknown
  words: RecordWords
  failure: string
  // What `said` reads while `onAudio`'s promise is pending, `words.stopped` by default; it is emptied once the promise settles, so a status region read later does not say the work is still under way.
  sending?: string | undefined
  // How long a recording runs before it is handed over as if pressed.
  maxMs: number
}

export interface Recorder {
  // Asking for the microphone, recording, or waiting on `onAudio`.
  state: Signal<'idle' | 'asking' | 'recording' | 'sending'>
  // Why the last press recorded nothing, until the next.
  problem: Signal<string | undefined>
  // What a status region says, as a button's new state is not read out.
  said: Signal<string>
  // How long the recording under way has run.
  seconds: Signal<number>
  // Starts a recording, or stops the one under way and hands it over.
  press: () => Promise<void>
  // Drops the recording under way, telling whether there was one: what Escape does.
  cancel: () => boolean
}

// The state of a microphone button, which RecordButton and kayjs-ai's Chat both draw: created in the component's script, it releases the microphone when the component goes.
export function recorder(options: RecorderOptions): Recorder {
  const { words } = options
  const state = signal<'idle' | 'asking' | 'recording' | 'sending'>('idle')
  const problem = signal<string | undefined>(undefined)
  const said = signal('')
  const seconds = signal(0)
  let loading: Promise<typeof import('./recording')> | undefined
  let current: Recording | undefined
  let ticker: ReturnType<typeof setInterval> | undefined
  let gone = false

  // Fetched as the component mounts, so the first press does not wait on it.
  const load = async () => loading ??= import('./recording')

  // A preload that failed is fetched again by the press, which says so if it fails then.
  async function preload() {
    try {
      await load()
    }
    catch {
      loading = undefined
    }
  }

  onMount(() => {
    void preload()
  })

  onCleanup(() => {
    gone = true
    finish()?.cancel()
  })

  function finish() {
    const ended = current

    clearInterval(ticker)
    current = undefined

    return ended
  }

  async function ended(result: File | RecordProblem) {
    finish()

    if (typeof result === 'string') {
      state.set('idle')
      said.set('')
      problem.set(words[result])

      return
    }

    state.set('sending')
    said.set(options.sending ?? words.stopped)

    try {
      await options.onAudio(result)
    }
    catch (error) {
      console.error('kayjs-ui: a recording\'s onRecord failed', error)
      problem.set(options.failure)
    }
    finally {
      said.set('')
      state.set('idle')
    }
  }

  async function start() {
    problem.set(undefined)
    said.set('')
    state.set('asking')

    let started: Recording | RecordProblem

    try {
      const { startRecording } = await load()

      started = await startRecording({ onEnd: result => void ended(result), maxMs: options.maxMs })
    }
    catch (error) {
      console.error('kayjs-ui: the recorder could not be loaded', error)
      loading = undefined
      started = 'failed'
    }

    if (gone) {
      if (typeof started !== 'string')
        started.cancel()

      return
    }

    if (typeof started === 'string') {
      state.set('idle')
      problem.set(words[started])

      return
    }

    current = started
    seconds.set(0)
    ticker = setInterval(() => seconds.set(seconds() + 1), 1000)
    state.set('recording')
    said.set(words.recording)
  }

  async function press() {
    if (state() === 'recording') {
      state.set('sending')
      finish()?.stop()

      return
    }

    if (state() === 'idle')
      await start()
  }

  // A recording whose time ran out just before is already on its way, and is not said to be dropped.
  function cancel() {
    if (state() !== 'recording' || current?.cancel() !== true)
      return false

    finish()
    state.set('idle')
    said.set(words.cancelled)

    return true
  }

  return { state, problem, said, seconds, press, cancel }
}

// `1:05`, the time a recording has run.
export function elapsed(total: number): string {
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
