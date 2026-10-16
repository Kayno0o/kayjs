import type { AwaitProps } from './checks'
import type { Html } from './html'
import type { JSX } from './jsx'
import { child } from './html'
import { insideIsland } from './island.server'
import { getOwner, runWithOwner } from './reactive'

// A block whose value was still pending when the page rendered, streamed in once it settles.
export interface PendingBlock {
  id: string
  value: Promise<unknown>
  ready: (value: never) => unknown
  failed?: ((error: unknown) => unknown) | undefined
}

interface EarlyRejections {
  // Rejected promises nothing has taken yet, with how they failed.
  held: Map<Promise<unknown>, unknown>
  // How long one may wait for an `await` block, or any code, to take it before it is logged.
  graceMs: number
}

// Shared by every copy of the runtime in the process, so one listener holds them all.
const EARLY = Symbol.for('kay.earlyRejections')
const early = ((globalThis as Record<symbol, unknown>)[EARLY] ??= installEarlyRejections()) as EarlyRejections

export const earlyRejections: Pick<EarlyRejections, 'graceMs'> = early

// A promise a page's data holds can reject before its `await` block renders, whoever made it: the process would crash on it, so it is held until something takes it, and logged if nothing does.
function installEarlyRejections(): EarlyRejections {
  const state: EarlyRejections = { held: new Map(), graceMs: 30_000 }

  process.on('unhandledRejection', (reason, promise) => {
    state.held.set(promise, reason)
    setTimeout(() => {
      if (state.held.delete(promise))
        console.error('kay: a promise rejected and nothing took it', reason)
    }, state.graceMs).unref()
  })
  process.on('rejectionHandled', promise => state.held.delete(promise))

  return state
}

// Renders are synchronous, so the blocks of the one in progress can live here, like the islands it renders.
let deferred: PendingBlock[] | undefined
let nextId = 0

// Runs a synchronous render and lists the `await` blocks it left pending.
export function collectDeferred<T>(render: () => T): { result: T, deferred: PendingBlock[] } {
  const previous = deferred
  const blocks: PendingBlock[] = []

  deferred = blocks

  try {
    return { result: render(), deferred: blocks }
  }
  finally {
    deferred = previous
  }
}

// On a page, a pending value renders its `pending` block between markers that the streamed result replaces; a settled one renders right away.
// Typed as the browser build is, which `kay check` reads templates against.
export function Await<T>(props: AwaitProps<T>): JSX.Element {
  const value = props.value

  if (!(value instanceof Promise))
    return props.ready(value as Awaited<T>)

  // Inside a block that is itself streamed nothing streams, and an island hydrates its pending block and settles it in the browser; the server takes the promise either way, so a rejection crashes nothing.
  if (deferred === undefined || insideIsland()) {
    void Promise.allSettled([value])

    return props.pending?.()
  }

  const id = (nextId++).toString(36)
  const blocks = deferred
  // Rendered once the value settles, under the component that declared it, for what it provided.
  const parent = getOwner()
  const failed = props.failed

  blocks.push({ id, value, ready: (settled: never) => runWithOwner(parent, () => props.ready(settled)), failed: failed && (error => runWithOwner(parent, () => failed(error))) })
  // The streamed block replaces this one whole, so an `await` inside it renders its own pending block and streams nothing.
  deferred = undefined

  try {
    const markup: Html = { t: `<!--kay-await:${id}-->${child(props.pending?.())}<!--/kay-await:${id}-->` }

    return markup
  }
  finally {
    deferred = blocks
  }
}
