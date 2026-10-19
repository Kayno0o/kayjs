import type { AwaitProps } from './checks'
import type { JSX } from './jsx'
import type { Html } from './rendered'
import { child } from './html'
import { insideIsland } from './island.server'
import { getOwner, runWithOwner } from './reactive'
import { html } from './rendered'
import { isSnapshots } from './snapshots'

// A block whose value was still pending when the page rendered, streamed in once it settles, or as each part of an async iterable comes.
export interface PendingBlock {
  id: string
  value: Promise<unknown> | AsyncIterable<unknown>
  ready: (value: never) => unknown
  failed?: ((error: unknown) => unknown) | undefined
}

interface EarlyRejections {
  // Rejected promises nothing has taken yet, with how they failed and the timer that logs them.
  held: Map<Promise<unknown>, { reason: unknown, timer: ReturnType<typeof setTimeout> }>
  // How long one may wait for an `await` block, or any code, to take it before it is logged.
  graceMs: number
}

// Shared by every copy of the runtime in the process, so one listener holds them all.
const EARLY = Symbol.for('kay.earlyRejections.1')
const early = ((globalThis as Record<symbol, unknown>)[EARLY] ??= installEarlyRejections()) as EarlyRejections

export const earlyRejections: Pick<EarlyRejections, 'graceMs'> = early

const NOT_TAKEN = 'kay: a promise rejected and nothing took it'

// A promise a page's data holds can reject before its `await` block renders, whoever made it: the process would crash on it, so it is held until something takes it, and logged if nothing does.
// A process ending first logs what it still holds and exits with code 1, as an unhandled rejection ends it without this.
function installEarlyRejections(): EarlyRejections {
  const state: EarlyRejections = { held: new Map(), graceMs: 30_000 }

  process.on('unhandledRejection', (reason, promise) => {
    const timer = setTimeout(() => {
      state.held.delete(promise)
      console.error(NOT_TAKEN, reason)
    }, state.graceMs)

    timer.unref()
    state.held.set(promise, { reason, timer })
  })
  process.on('rejectionHandled', (promise) => {
    clearTimeout(state.held.get(promise)?.timer)
    state.held.delete(promise)
  })
  process.on('exit', () => {
    for (const { reason } of state.held.values())
      console.error(NOT_TAKEN, reason)

    if (state.held.size > 0 && (process.exitCode === undefined || process.exitCode === 0))
      process.exitCode = 1
  })

  return state
}

// Renders are synchronous, so the blocks of the one in progress can live here, like the islands it renders.
interface Collecting {
  blocks: PendingBlock[]
  // What a block's id starts with: the id of the streamed block this render is the content of, none for the page.
  prefix: string
  next: number
}

let deferred: Collecting | undefined

// Runs a synchronous render and lists the `await` blocks it left pending.
// Ids count from zero in each render, under the id of the block it renders, so a page gives the same bytes every time it renders the same and its compressed copy is kept; they only have to differ within one document.
export function collectDeferred<T>(render: () => T, within?: string): { result: T, deferred: PendingBlock[] } {
  const previous = deferred
  const collecting: Collecting = { blocks: [], prefix: within === undefined ? '' : `${within}_`, next: 0 }

  deferred = collecting

  try {
    return { result: render(), deferred: collecting.blocks }
  }
  finally {
    deferred = previous
  }
}

// On a page, a pending value renders its `pending` block between markers that the streamed result replaces; a settled one renders right away.
// Typed as the browser build is, which `kay check` reads templates against.
export function Await<T>(props: AwaitProps<T>): JSX.Element {
  const value = props.value
  const parts = isSnapshots(value)

  if (!parts && !(value instanceof Promise))
    return props.ready(value as never)

  // Inside a block that is itself streamed nothing streams, and an island hydrates its pending block and settles it in the browser; the server takes a promise either way, so a rejection crashes nothing, and leaves an iterable unread.
  if (deferred === undefined || insideIsland()) {
    if (!parts)
      void Promise.allSettled([value])

    return props.pending?.()
  }

  const id = `${deferred.prefix}${(deferred.next++).toString(36)}`
  const collecting = deferred
  // Rendered once the value settles, under the component that declared it, for what it provided.
  const parent = getOwner()
  const failed = props.failed

  collecting.blocks.push({ id, value, ready: (settled: never) => runWithOwner(parent, () => props.ready(settled)), failed: failed && (error => runWithOwner(parent, () => failed(error))) })
  // The streamed block replaces this one whole, so an `await` inside it renders its own pending block and streams nothing.
  deferred = undefined

  try {
    const markup: Html = html(`<!--kay-await:${id}-->${child(props.pending?.())}<!--/kay-await:${id}-->`)

    return markup
  }
  finally {
    deferred = collecting
  }
}
