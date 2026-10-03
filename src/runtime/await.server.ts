import type { JSX } from '@solidjs/web'
import type { AwaitProps } from './checks'
import { ssr } from '@solidjs/web'
import { Await as SolidAwait } from './await'
import { insideIsland } from './island.server'

// A block whose value was still pending when the page rendered, streamed in once it settles.
export interface PendingBlock {
  id: string
  value: Promise<unknown>
  ready: (value: never) => JSX.Element
  failed?: (error: unknown) => JSX.Element
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
export function Await<T>(props: AwaitProps<T>): JSX.Element {
  const value = props.value

  if (!(value instanceof Promise))
    return props.ready(value as Awaited<T>)

  if (deferred === undefined || insideIsland())
    return SolidAwait(props)

  const id = (nextId++).toString(36)
  const blocks = deferred

  blocks.push({ id, value, ready: props.ready as PendingBlock['ready'], failed: props.failed })
  // The streamed block replaces this one whole, so an `await` inside it renders its own pending block and streams nothing.
  deferred = undefined

  try {
    return ssr([`<!--kay-await:${id}-->`, `<!--/kay-await:${id}-->`], props.pending?.()) as unknown as JSX.Element
  }
  finally {
    deferred = blocks
  }
}
