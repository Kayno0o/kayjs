import type { ActionStream } from './action'
import type { StreamStatus } from './live'
import { SETTLED } from './action'
import { readEvents } from './live'
import { effect, root } from './reactive'

// Reads the server-sent events a streaming action answered a call with, from the moment the answer came.
// Values arriving before the first `on()` listener, until the task the call resolved in ends, are handed to it when it comes, so a caller subscribing right after `await` misses none; `left` closes the stream once the visitor went to another page.
export function actionStream<T>(response: Response, left?: () => boolean): ActionStream<T> & { [SETTLED]: Promise<StreamStatus> } {
  const reader = readEvents<T>(async () => Promise.resolve(response), false)
  let early: T[] | undefined = []
  let settle!: (status: StreamStatus) => void
  const settled = new Promise<StreamStatus>((resolve) => {
    settle = resolve
  })

  reader.on((value) => {
    early?.push(value)

    if (left?.() === true)
      reader.close()
  })

  root(dispose => effect(() => {
    const status = reader.status()

    if (status !== 'connecting' && status !== 'open') {
      dispose()
      settle(status)
    }
  }))

  reader.start()
  setTimeout(() => {
    early = undefined
  }, 0)

  return {
    last: reader.last,
    status: reader.status,
    on: (listener) => {
      const missed = early ?? []

      early = undefined

      for (const value of missed)
        listener(value)

      return reader.on(listener)
    },
    close: reader.close,
    [SETTLED]: settled,
  }
}
