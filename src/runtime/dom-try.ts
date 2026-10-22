import { blockIn, claiming, fresh, HydrationMismatchError, islandOf, Region, release, swap } from './dom'
import { FAILED } from './markers'
import { catchError, getOwner, onCleanup, reportError, runWithOwner, unrecorded } from './reactive'

// The `try` block: its own module, as it weighs on a page whose islands have none.

// A `try` block: its content under an owner catching what its effects throw later, or its `catch` block once it throws, the error reported either way.
export function attempt(element: Node | null, start: Node | null, end: Node | null, render: (caught: (error: unknown) => unknown) => unknown, fallback: ((error: unknown) => unknown) | undefined): void {
  const region = new Region(element, start, end)

  // The server rendered the `catch` block: kept as it came, since the error it shows stayed on the server.
  if (claiming() && failedOnServer(region))
    return

  const block = blockIn(region)
  let failed = false
  let disposeContent: (() => void) | undefined
  const parent = getOwner()

  onCleanup(() => release(block))

  const fail = (error: unknown) => {
    reportError(error, islandOf(region.parent))

    if (failed)
      return

    failed = true
    disposeContent?.()
    // What the block built, or claimed before it threw, goes; the fallback is built afresh.
    region.clear()
    block.units = []

    if (fallback)
      runWithOwner(parent, () => unrecorded(() => fresh(() => swap(block, () => fallback(error), true))))
  }

  catchError((dispose) => {
    disposeContent = dispose

    try {
      swap(block, () => render(fallback ?? (() => null)))
    }
    catch (error) {
      // Markup the island would not claim is the island's to recover from, rendering it afresh, not the block's to fall back from.
      if (error instanceof HydrationMismatchError)
        throw error

      fail(error)
    }
  }, fail)
}

function failedOnServer(region: Region): boolean {
  const first = region.start ? region.start.nextSibling : region.element!.firstChild

  return first?.nodeType === 8 && (first as Comment).data === FAILED
}
