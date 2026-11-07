import type { ActionStream, SETTLED, Settles } from './action'
import type { ApiError } from './api-error'
import type { ConnectionStatus } from './live'
import { apiErrorOf } from './api-error'
import { connection, ending, listenerSet, onData } from './connection'
import { decodeServerValue } from './wire'

const DATA = 'data: '
const END = 'event: end'
const ERROR = 'event: error'
// A proxy may rewrite the line breaks kay sends as \r\n.
const LINE_BREAK = /\r?\n/

// How to call the action again: `send` posts it as the first call was and hands the answer, throwing the error of a refusal or of no answer, and `begun` runs with the stream when a new answer starts being read.
export interface Retrying<T> {
  send: () => Promise<Response>
  begun: (stream: ActionStream<T> & Settles) => void
}

// kay's own answer holds one line per value, so it is read here rather than by live.ts's reader: what this module imports of the runtime loads up front on every page, so it takes `settled` from its caller too.
// Values arriving before the first `on()`, until the task the call resolved in ends, go to it when it comes. `failure` is what `ended()` rejects with for a stream that failed, an `ActionError` its caller makes.
export function actionStream<T>(response: Response, settled: typeof SETTLED, failure: () => Error, retrying?: Retrying<T>): ActionStream<T> & Settles {
  const link = connection<T>(() => undefined, false)
  const { ended, settled: whenSettled } = ending(link)
  const opened = listenerSet<boolean>()
  let early: T[] | undefined
  let run = 0

  const end = (final: ConnectionStatus) => {
    if (final === 'failed')
      link.fail(failure() as ApiError)
    else
      link.set(final)
  }

  // Reads one answer; a run that was replaced, as a retry does, no longer changes anything.
  const open = (answer: Response) => {
    const mine = ++run
    const reader = answer.body!.getReader()

    early = []
    link.set('open')
    void read<T>(reader, (value) => {
      if (mine !== run)
        return

      early?.push(value)
      link.receive(value)
    }, (final) => {
      if (mine === run)
        end(final)
    })
    setTimeout(() => {
      early = undefined
    }, 0)

    return reader
  }

  let reader = open(response)

  async function send(stream: ActionStream<T> & Settles) {
    try {
      const next = await retrying!.send()

      if (link.status() !== 'connecting') {
        void next.body?.cancel()

        return
      }

      reader = open(next)
      opened.emit(true)
      retrying!.begun(stream)
    }
    catch (thrown) {
      link.fail(apiErrorOf(thrown))
    }
  }

  function close() {
    link.set('closed')
    void cancel(reader)
  }

  const on = (listener: (value: T) => void) => {
    const missed = early ?? []

    early = undefined

    for (const value of missed)
      listener(value)

    return link.on(listener)
  }

  const self: ActionStream<T> & Settles = {
    last: link.last,
    status: link.status,
    pending: link.pending,
    error: link.error,
    retry: () => {
      if (retrying) {
        link.retry(() => {
          // The previous answer is forgotten; `retry` already reads as connecting.
          run++
          link.forget()
          void send(self)
        })
      }
    },
    on,
    onData: onData(on),
    onOpen: opened.on,
    close,
    ended,
    [settled]: whenSettled,
  }

  return self
}

// A body running out before its end event, failing to read or sending a value that does not decode ends the stream as failed and stops it on the server; one already closed stays closed.
async function read<T>(reader: ReadableStreamDefaultReader<Uint8Array>, receive: (value: T) => void, end: (final: ConnectionStatus) => void): Promise<void> {
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()

      if (done)
        break

      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split(LINE_BREAK)

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
  await cancel(reader)
}

async function cancel(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel()
  }
  catch {}
}
