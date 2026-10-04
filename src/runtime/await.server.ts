import type { AwaitProps } from './checks'
import type { Html } from './html'
import type { JSX } from './jsx'
import { child } from './html'
import { insideIsland } from './island.server'

// A block whose value was still pending when the page rendered, streamed in once it settles.
export interface PendingBlock {
  id: string
  value: Promise<unknown>
  ready: (value: never) => unknown
  failed?: (error: unknown) => unknown
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

  // Inside a block that is itself streamed nothing streams, and an island hydrates its pending block and settles it in the browser.
  if (deferred === undefined || insideIsland())
    return props.pending?.()

  const id = (nextId++).toString(36)
  const blocks = deferred

  blocks.push({ id, value, ready: props.ready as PendingBlock['ready'], failed: props.failed })
  // The streamed block replaces this one whole, so an `await` inside it renders its own pending block and streams nothing.
  deferred = undefined

  try {
    const markup: Html = { t: `<!--kay-await:${id}-->${child(props.pending?.())}<!--/kay-await:${id}-->` }

    return markup as unknown as JSX.Element
  }
  finally {
    deferred = blocks
  }
}
