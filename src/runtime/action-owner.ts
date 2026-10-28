import type { ActionStream } from './action-shared'
import type { StreamStatus } from './live'
import type { Owner } from './reactive'
import { leaving, navigation } from './navigation'
import { liveOwner, onCleanupOf } from './reactive'

// Who made a call: the island whose setup or handler did, and how many paths were shown by then.
export interface Caller {
  owner: Owner | undefined
  arrivals: number | undefined
}

// Where the stream a streaming action answered a call with takes a callback, handed how it ended once it did.
export const SETTLED = Symbol.for('kay.settled')

export interface Settles {
  [SETTLED]: (then: (status: StreamStatus) => void) => void
}

// A stream ends with the block or island that started it, or the nearest one around it still alive when its answer arrives (a persist island's living on across pages), and one whose block goes in that same task, the call's own result removing it, passes to the block around it. One started under no owner, after an `await` in a handler say, ends once a path other than the call's is shown.
export function closeWithCaller(stream: ActionStream<unknown> & Settles, caller: Caller | undefined): void {
  let answering = true
  let ended = false
  let owner: Owner | undefined

  setTimeout(() => {
    answering = false
  }, 0)

  function release() {
    const from = owner

    owner = undefined

    if (!answering || !from) {
      stream.close()

      return
    }

    // After the pass that disposes the block, so the nearest one around it still alive then takes the stream.
    queueMicrotask(() => {
      const to = liveOwner(from.owner)

      if (ended)
        return

      if (to)
        attach(to)
      else
        stream.close()
    })
  }

  function attach(to: Owner) {
    owner = to
    onCleanupOf(to, release)
  }

  const first = liveOwner(caller?.owner)

  if (first) {
    attach(first)
  }
  else if (caller && navigation.arrivals !== caller.arrivals) {
    stream.close()
  }
  else if (caller) {
    leaving.add(stream.close)
  }

  // One per call, so an island answering many clicks with a stream does not keep every one until it goes.
  stream[SETTLED](() => {
    ended = true
    leaving.delete(stream.close)

    const at = owner?.cleanups?.indexOf(release) ?? -1

    if (at !== -1)
      owner!.cleanups!.splice(at, 1)
  })
}

// Hands `then` how a stream ended, once it ended, failed or was closed; false when `data` is no stream.
export function onStreamEnd(data: unknown, then: (status: StreamStatus) => void): boolean {
  const settles = (data as Partial<Settles> | null | undefined)?.[SETTLED]

  settles?.(then)

  return settles !== undefined
}
