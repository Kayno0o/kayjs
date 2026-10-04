import type { JSX } from '@solidjs/web'
import type { AwaitProps } from './checks'
import type { Html } from './html'
import { Await as SolidAwait } from './await'
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

  // An island builds the same tree as in the browser, which wraps any value in a memo and a boundary.
  if (insideIsland())
    return SolidAwait(props)

  if (!(value instanceof Promise))
    return props.ready(value as Awaited<T>)

  // Inside a block that is itself streamed, nothing streams: the pending block stays.
  if (deferred === undefined)
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
