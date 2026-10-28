import type { Reply } from './types'

export interface DeferredOptions {
  resumed?: boolean | undefined
  // Runs once the reply is first read, for as long as it takes to end, and the reply is read as ended only once this has: a write of what it said, which the next call must find. It handles its own errors.
  ended?: ((reply: Reply) => Promise<void>) | undefined
}

// A reply known once `target` settles: every read waits for it, and a target that fails fails the read, as a refused ask does.
// The reply travels wrapped, since a promise resolving to a thenable would wait for its text instead.
export function deferredReply(target: Promise<{ reply: Reply }>, { resumed = false, ended }: DeferredOptions = {}): Reply {
  let ending: Promise<void> | undefined

  // A target no one reads must not fail unheard.
  void (async () => {
    try {
      await target
    }
    catch {}
  })()

  const got = async (): Promise<{ reply: Reply }> => {
    const { reply } = await target

    ending ??= ended?.(reply) ?? Promise.resolve()

    return { reply }
  }

  const ahead = <Value>(pick: (reply: Reply) => AsyncIterable<Value>): AsyncIterable<Value> => ({
    [Symbol.asyncIterator]: () => {
      let source: AsyncIterator<Value> | undefined

      return {
        async next() {
          source ??= pick((await got()).reply)[Symbol.asyncIterator]()

          const step = await source.next()

          if (step.done === true)
            await ending

          return step
        },
        async return(value?: unknown) {
          return await source?.return?.(value) ?? { done: true, value: undefined }
        },
      }
    },
  })

  const text = async () => {
    const said = await (await got()).reply

    await ending

    return said
  }

  return {
    // eslint-disable-next-line kaynooo/no-then -- the thenable's own `then`, passed through
    then: async (onFulfilled, onRejected) => text().then(onFulfilled, onRejected),
    [Symbol.asyncIterator]: () => ahead(reply => reply)[Symbol.asyncIterator](),
    stream: () => ahead(reply => reply.stream()),
    deltas: options => ahead(reply => reply.deltas(options)),
    progress: () => ahead(reply => reply.progress()),
    get calls() {
      return (async () => (await got()).reply.calls)()
    },
    get steps() {
      return (async () => (await got()).reply.steps)()
    },
    get usage() {
      return (async () => (await got()).reply.usage)()
    },
    get finish() {
      return (async () => (await got()).reply.finish)()
    },
    resumed,
    stop: () => void (async () => {
      try {
        (await target).reply.stop()
      }
      catch {}
    })(),
  }
}
