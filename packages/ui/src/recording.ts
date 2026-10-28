// The browser side of a recording, a chunk of its own loaded once a component offers the microphone; record.ts holds what the component reads.

// Why a recording did not start or did not end with what was said: each has its words in `recordWords()`.
export type RecordProblem = 'insecure' | 'unsupported' | 'denied' | 'missing' | 'taken' | 'failed' | 'lost' | 'empty'

export interface Recording {
  // Ends the recording and hands what was said to `onEnd`.
  stop: () => void
  // Ends it and drops what was said, `onEnd` left uncalled; false when it had already ended, its audio on the way.
  cancel: () => boolean
}

export interface RecordOptions {
  // What was said once `stop` ended the recording or `maxMs` ran out, or why there is nothing: the microphone went away (`lost`), the browser failed (`failed`) or no sound came (`empty`).
  onEnd: (result: File | RecordProblem) => void
  // How long a recording runs before it stops as if `stop` was called.
  maxMs: number
}

// The longest delay setTimeout keeps, past which it fires at once.
const LONGEST_TIMER_MS = 2 ** 31 - 1
const EXTENSIONS: Record<string, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' }

function problemOf(error: unknown): RecordProblem {
  if (!(error instanceof DOMException))
    return 'failed'

  if (error.name === 'NotAllowedError' || error.name === 'SecurityError')
    return 'denied'

  if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError')
    return 'missing'

  // Another application holds the device, or the system would not hand it over.
  return error.name === 'NotReadableError' || error.name === 'AbortError' ? 'taken' : 'failed'
}

function release(stream: MediaStream): void {
  for (const track of stream.getTracks())
    track.stop()
}

// A recording as a named file, which an action's `s.File()` takes as it is: `recording.webm` in Chrome and Firefox, `recording.m4a` in Safari.
function recorded(chunks: Blob[], recorder: MediaRecorder): File {
  const type = [recorder.mimeType, chunks[0]?.type].find(given => given !== undefined && given !== '') ?? 'audio/webm'
  const end = type.indexOf(';')

  return new File(chunks, `recording.${EXTENSIONS[end === -1 ? type : type.slice(0, end)] ?? 'audio'}`, { type })
}

// Opens the microphone and records, or says why it cannot: the browser asks the visitor first, and the tracks are released however the recording ends.
export async function startRecording(options: RecordOptions): Promise<Recording | RecordProblem> {
  // Off https browsers offer no `mediaDevices` at all.
  if (navigator.mediaDevices?.getUserMedia === undefined)
    return globalThis.isSecureContext === false ? 'insecure' : 'unsupported'

  if (typeof MediaRecorder === 'undefined')
    return 'unsupported'

  let stream: MediaStream

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  }
  catch (error) {
    return problemOf(error)
  }

  let recorder: MediaRecorder

  try {
    recorder = new MediaRecorder(stream)
  }
  catch {
    release(stream)

    return 'unsupported'
  }

  const chunks: Blob[] = []
  // Set by whoever ended the recording; a recorder stopping with none set lost its microphone.
  let outcome: 'keep' | 'drop' | 'failed' | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let reported = false

  // Told once, as a recorder may fire `error` and then `stop`.
  function report(result: File | RecordProblem) {
    if (!reported)
      options.onEnd(result)

    reported = true
  }

  function end(how: 'keep' | 'drop' | 'failed') {
    if (outcome !== undefined)
      return false

    outcome = how

    if (recorder.state !== 'inactive') {
      recorder.stop()

      return true
    }

    // A recorder already stopped fires no stop event to report through.
    clearTimeout(timer)
    release(stream)

    if (how === 'failed')
      report('failed')

    return true
  }

  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size > 0)
      chunks.push(event.data)
  })
  recorder.addEventListener('error', () => end('failed'))
  recorder.addEventListener('stop', () => {
    clearTimeout(timer)
    release(stream)

    if (outcome === 'drop')
      return

    if (outcome === undefined || outcome === 'failed') {
      report(outcome ?? 'lost')

      return
    }

    const audio = recorded(chunks, recorder)

    report(audio.size > 0 ? audio : 'empty')
  })

  // An unplugged headset ends its track; the recorder stopping by itself is then told apart by no outcome set.
  for (const track of stream.getAudioTracks()) {
    track.addEventListener('ended', () => {
      if (outcome === undefined && recorder.state !== 'inactive')
        recorder.stop()
    })
  }

  recorder.start()
  timer = setTimeout(end, Math.min(options.maxMs, LONGEST_TIMER_MS), 'keep')

  return { stop: () => void end('keep'), cancel: () => end('drop') }
}
