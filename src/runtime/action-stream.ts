import type { ActionStream, SETTLED, Settles } from './action'
import type { StreamStatus } from './live'
import { ownSignal } from './reactive'
import { decodeServerValue } from './wire'

const DATA = 'data: '
const END = 'event: end'
const ERROR = 'event: error'

// kay's own answer holds one line per value, so it is read here rather than by live.ts's reader: what this module imports of the runtime loads up front on every page, so it takes `settled` from its caller too.
// Values arriving before the first `on()`, until the task the call resolved in ends, go to it when it comes.
export function actionStream<T>(response: Response, settled: typeof SETTLED): ActionStream<T> & Settles {
  const [status, setStatus] = ownSignal<StreamStatus>('open')
  const [last, setLast] = ownSignal<T | undefined>(undefined, { equals: false })
  const listeners = new Set<(value: T) => void>()
  const reader = response.body!.getReader()
  let early: T[] | undefined = []
  let ended: StreamStatus | undefined
  const waiting: ((status: StreamStatus) => void)[] = []

  const end = (final: StreamStatus) => {
    if (ended)
      return

    ended = final
    setStatus(final)

    for (const then of waiting)
      then(final)
  }

  const receive = (value: T) => {
    setLast(value)
    early?.push(value)

    // One listener failing leaves the others and the stream alone.
    for (const listener of listeners) {
      try {
        listener(value)
      }
      catch (error) {
        console.error(error)
      }
    }
  }

  function close() {
    end('closed')
    void cancel(reader)
  }

  void read(reader, receive, end)
  setTimeout(() => {
    early = undefined
  }, 0)

  return {
    last,
    status,
    on: (listener) => {
      const missed = early ?? []

      early = undefined

      for (const value of missed)
        listener(value)

      listeners.add(listener)

      return () => void listeners.delete(listener)
    },
    close,
    [settled]: (then: (status: StreamStatus) => void) => {
      if (ended)
        then(ended)
      else
        waiting.push(then)
    },
  }
}

// A body running out before its end event, or failing to read, ends the stream as failed; one already closed stays closed.
async function read<T>(reader: ReadableStreamDefaultReader<Uint8Array>, receive: (value: T) => void, end: (final: StreamStatus) => void): Promise<void> {
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()

      if (done)
        break

      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')

      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (line === END || line === ERROR) {
          end(line === END ? 'done' : 'failed')
          await cancel(reader)

          return
        }

        if (line.startsWith(DATA))
          receive(decodeServerValue(line.slice(DATA.length)) as T)
      }
    }
  }
  catch (error) {
    console.error('kay: a streaming action sent a value that does not decode, or its answer broke off', error)
  }

  end('failed')
}

async function cancel(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel()
  }
  catch {}
}
