import type { Finish, Piece, Reply, Usage } from './types'
import { AiError } from './errors'

// A reply over what `open` yields once first read, with `signals` stopping it when any aborts.
// The text is kept as it comes, so any number of readers (`await`, `for await`, `usage`) share one provider request.
export function createReply(open: (signal: AbortSignal) => AsyncIterable<Piece>, signals: (AbortSignal | undefined)[]): Reply {
  const controller = new AbortController()
  const deltas: string[] = []
  const waiters = new Set<() => void>()
  const counted = Promise.withResolvers<Usage | undefined>()
  const ending = Promise.withResolvers<Finish | undefined>()
  const total: Partial<Usage> = {}
  let reason: Finish | undefined
  let started = false
  let ended = false
  let failure: { error: unknown } | undefined
  let text: Promise<string> | undefined

  const notify = () => {
    for (const wake of waiters)
      wake()

    waiters.clear()
  }

  const stop = () => controller.abort()

  const pump = async () => {
    try {
      for await (const piece of open(controller.signal)) {
        if ('text' in piece)
          deltas.push(piece.text)
        else if ('usage' in piece)
          Object.assign(total, piece.usage)
        else
          reason = piece.finish

        notify()
      }
    }
    catch (error) {
      // A reply stopped on purpose ends with what it has, whatever the aborted request threw.
      if (!controller.signal.aborted) {
        if (error instanceof AiError && error.partial === undefined && deltas.length > 0)
          error.partial = deltas.join('')

        failure = { error }
      }
    }
    finally {
      for (const signal of signals)
        signal?.removeEventListener('abort', stop)

      ended = true
      counted.resolve(failure === undefined && total.inputTokens !== undefined && total.outputTokens !== undefined ? { inputTokens: total.inputTokens, outputTokens: total.outputTokens } : undefined)
      ending.resolve(failure === undefined ? reason : undefined)
      notify()
    }
  }

  const start = () => {
    if (started)
      return

    started = true

    for (const signal of signals) {
      if (signal?.aborted === true)
        stop()
      else
        signal?.addEventListener('abort', stop, { once: true })
    }

    void pump()
  }

  const finish = async (): Promise<void> => {
    for (;;) {
      if (ended)
        break

      await new Promise<void>((resolve) => {
        waiters.add(resolve)
      })
    }

    if (failure !== undefined)
      throw failure.error
  }

  const read = (snapshots: boolean): AsyncIterator<string> => {
    start()

    let cursor = 0
    let snapshot = ''
    let closed = false

    return {
      async next() {
        for (;;) {
          if (closed)
            return { done: true, value: undefined }

          if (cursor < deltas.length) {
            const parts = deltas.slice(cursor)

            cursor = deltas.length

            const joined = parts.join('')

            snapshot += joined

            return { done: false, value: snapshots ? snapshot : joined }
          }

          if (ended) {
            closed = true

            if (failure !== undefined)
              throw failure.error

            return { done: true, value: undefined }
          }

          await new Promise<void>((resolve) => {
            waiters.add(resolve)
          })
        }
      },
      // A reader leaving early stops the provider, so a page left mid-reply bills no more.
      return: async () => {
        closed = true
        stop()

        return Promise.resolve({ done: true, value: undefined })
      },
    }
  }

  return {
    async then(onFulfilled, onRejected) {
      start()
      text ??= (async () => {
        await finish()

        return deltas.join('')
      })()

      // eslint-disable-next-line kaynooo/no-then -- the thenable's own `then`, passed through
      return text.then(onFulfilled, onRejected)
    },
    [Symbol.asyncIterator]: () => read(true),
    deltas: () => ({ [Symbol.asyncIterator]: () => read(false) }),
    get usage() {
      start()

      return counted.promise
    },
    get finish() {
      start()

      return ending.promise
    },
    stop,
  }
}
