import type { CodeBlock, DeltasOptions, Finish, Piece, Progress, Reply, Source, ToolCall, Usage } from './types'
import { logFrom } from 'kay'
import { AiError } from './errors'
import { highlighting } from './highlight'

const log = logFrom('kayjs-ai')

function snapshot(call: ToolCall): ToolCall {
  return { ...call, input: { ...call.input } }
}

// A reply over what `open` yields once first read, with `signals` stopping it when any aborts.
// The text is kept as it comes, so any number of readers (`await`, `for await`, `usage`) share one provider request.
export function createReply(open: (signal: AbortSignal) => AsyncIterable<Piece>, signals: (AbortSignal | undefined)[], highlight = highlighting, outlive = false, onEnd?: () => void, { resumed = false, sources = [] }: { resumed?: boolean | undefined, sources?: readonly Source[] | undefined } = {}): Reply {
  const controller = new AbortController()
  const deltas: string[] = []
  // Appended to as it streams, so a snapshot reads it without joining the pieces again.
  let thought = ''
  const waiters = new Set<() => void>()
  const counted = Promise.withResolvers<Usage | undefined>()
  const ending = Promise.withResolvers<Finish | undefined>()
  const total: Partial<Usage> = {}
  const calls: ToolCall[] = []
  // Counts each change to the text, to a call or to the reasoning, which `progress()` reads from.
  let version = 0
  // Counts each change to the text alone, which is what its code blocks are scanned for.
  let textVersion = 0
  // Counts the times the text started over, which a reader meets by starting from the top.
  let epoch = 0
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
        if ('text' in piece) {
          deltas.push(piece.text)
          version++
          textVersion++
        }
        else if ('reasoning' in piece) {
          thought += piece.reasoning
          version++
        }
        else if ('restart' in piece) {
          deltas.length = 0
          epoch++
          version++
          textVersion++
        }
        else if ('usage' in piece) {
          Object.assign(total, piece.usage)
        }
        else if ('tool' in piece) {
          const at = calls.findIndex(call => call.id === piece.tool.id)

          if (at === -1)
            calls.push(piece.tool)
          else
            calls[at] = piece.tool

          version++
        }
        else if ('finish' in piece) {
          reason = piece.finish
        }

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
      onEnd?.()
      counted.resolve(failure === undefined && total.inputTokens !== undefined && total.outputTokens !== undefined ? { ...total, inputTokens: total.inputTokens, outputTokens: total.outputTokens } : undefined)
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

  const read = (snapshots: boolean, onRestart?: () => void): AsyncIterator<string> => {
    start()

    let cursor = 0
    let snapshot = ''
    let closed = false
    let known = epoch

    return {
      async next() {
        for (;;) {
          if (closed)
            return { done: true, value: undefined }

          if (known !== epoch) {
            known = epoch

            // A reader that was given nothing has no text to drop.
            if (cursor > 0)
              onRestart?.()

            cursor = 0
            snapshot = ''
          }

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
      // A reader leaving early stops the provider, so a page left mid-reply bills no more, unless the reply outlives its readers.
      return: async () => {
        closed = true

        if (!outlive)
          stop()

        return Promise.resolve({ done: true, value: undefined })
      },
    }
  }

  const progress = (): AsyncIterator<Progress> => {
    start()

    const highlighted = highlight()
    let seen = 0
    let scanned = 0
    let closed = false
    // Highlighting runs beside the stream: a snapshot carries the text at once and the blocks finished since, so a slow highlighter never holds the text back.
    let working = false
    let stale = false
    let finished: CodeBlock[] = []

    const scan = () => {
      working = true
      stale = false
      scanned = textVersion

      void (async () => {
        try {
          finished.push(...await highlighted(deltas.join('')))
        }
        catch (error) {
          log.warn('highlighting a reply failed, so its code stays plain', error)
        }
        finally {
          working = false
          notify()
        }
      })()
    }

    return {
      async next() {
        for (;;) {
          if (closed)
            return { done: true, value: undefined }

          if (finished.length > 0) {
            const code = finished

            finished = []

            return { done: false, value: { text: deltas.join(''), calls: calls.map(snapshot), code, ...thought !== '' && { reasoning: thought }, ...outlive && { outlives: true }, ...sources.length > 0 && { sources: sources.map(source => ({ ...source })) } } }
          }

          if (seen < version) {
            seen = version

            // A change to the reasoning or a call leaves the text as it was, so it is not scanned again.
            if (scanned !== textVersion) {
              if (working)
                stale = true
              else
                scan()
            }

            return { done: false, value: { text: deltas.join(''), calls: calls.map(snapshot), ...thought !== '' && { reasoning: thought }, ...outlive && { outlives: true }, ...sources.length > 0 && { sources: sources.map(source => ({ ...source })) } } }
          }

          if (stale && !working) {
            scan()

            continue
          }

          if (ended && !working) {
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
      return: async () => {
        closed = true

        if (!outlive)
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
    stream: () => ({ [Symbol.asyncIterator]: () => read(true) }),
    deltas: (options?: DeltasOptions) => ({ [Symbol.asyncIterator]: () => read(false, options?.onRestart) }),
    progress: () => ({ [Symbol.asyncIterator]: progress }),
    get calls() {
      start()

      return (async () => {
        await ending.promise

        return calls.map(snapshot)
      })()
    },
    get usage() {
      start()

      return counted.promise
    },
    get finish() {
      start()

      return ending.promise
    },
    resumed,
    stop,
  }
}
